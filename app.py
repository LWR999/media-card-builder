"""media-card-builder – Flask application."""
import json
import logging
import os
import re
import time
import unicodedata
from io import BytesIO
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from mutagen.flac import FLAC
from PIL import Image

from builder import job as build_job
from builder import sync as sync_job

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret")

NAS_ROOT  = os.environ.get("NAS_MUSIC_PATH", "").rstrip("/")
NAS_STAGE = os.environ.get("NAS_STAGE_PATH", "").rstrip("/")

DB_PARAMS = {
    "host":     os.environ.get("DB_HOST", "localhost"),
    "port":     int(os.environ.get("DB_PORT", 5432)),
    "dbname":   os.environ.get("DB_NAME", "music_catalog"),
    "user":     os.environ.get("DB_USER", ""),
    "password": os.environ.get("DB_PASSWORD", ""),
}


def get_conn():
    return psycopg2.connect(**DB_PARAMS)


def dict_cursor(conn):
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)


# ---------------------------------------------------------------------------
# Stage path helpers
# ---------------------------------------------------------------------------

def _safe_name(s: str) -> str:
    return re.sub(r"[^\w\-]", "_", s)[:60].strip("_")


def _stage_path(card: dict) -> Path | None:
    if not NAS_STAGE:
        return None
    folder = f"{card['id']}_{_safe_name(card['name'])}"
    return Path(NAS_STAGE) / folder


# ---------------------------------------------------------------------------
# Schema bootstrap
# ---------------------------------------------------------------------------

def ensure_tables():
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Migrate output_path → card_mount_path if this is an older instance
            cur.execute("""
                DO $$ BEGIN
                    ALTER TABLE cards RENAME COLUMN output_path TO card_mount_path;
                EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
                END $$;
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS cards (
                    id               SERIAL PRIMARY KEY,
                    name             VARCHAR(500)  NOT NULL,
                    target_size_gb   NUMERIC(10,2) NOT NULL,
                    card_mount_path  VARCHAR(2000),
                    device_profile   VARCHAR(100) DEFAULT 'generic',
                    status           VARCHAR(50)  NOT NULL DEFAULT 'draft',
                    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS card_albums (
                    card_id   INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                    album_id  INTEGER NOT NULL,
                    added_by  VARCHAR(20) NOT NULL DEFAULT 'user'
                                CHECK (added_by IN ('user', 'suggestion')),
                    accepted  BOOLEAN NOT NULL DEFAULT TRUE,
                    added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (card_id, album_id)
                );

                CREATE INDEX IF NOT EXISTS idx_card_albums_card_id ON card_albums(card_id);

                CREATE TABLE IF NOT EXISTS card_unmanaged_paths (
                    id          SERIAL PRIMARY KEY,
                    card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                    folder_name VARCHAR(2000) NOT NULL,
                    size_bytes  BIGINT NOT NULL DEFAULT 0,
                    UNIQUE (card_id, folder_name)
                );
            """)
            cur.execute("ALTER TABLE cards ALTER COLUMN status SET DEFAULT 'draft'")
        conn.commit()


try:
    ensure_tables()
except Exception as e:
    logging.warning("Could not ensure tables: %s", e)


# ---------------------------------------------------------------------------
# Album art cache
# ---------------------------------------------------------------------------

_art_cache: dict[int, bytes | None] = {}
_ART_CACHE_MAX = 600
_ART_TILE_WIDTH = 300


def _normalize_for_jpeg(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        src = img.convert("RGBA") if img.mode == "P" else img
        bg.paste(src, mask=src.split()[-1])
        return bg
    return img if img.mode == "RGB" else img.convert("RGB")


def _extract_art(album_id: int) -> bytes | None:
    if not NAS_ROOT:
        return None
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT nas_path FROM albums WHERE id = %s", (album_id,))
            row = cur.fetchone()
    if not row:
        return None
    album_dir = Path(NAS_ROOT) / row[0]
    if not album_dir.exists():
        return None
    flacs = sorted(album_dir.glob("*.flac"))
    if not flacs:
        for sub in sorted(album_dir.iterdir()):
            if sub.is_dir() and not sub.name.startswith("."):
                flacs = sorted(sub.glob("*.flac"))
                if flacs:
                    break
    for flac_path in flacs[:5]:
        try:
            audio = FLAC(str(flac_path))
            for pic in audio.pictures:
                img = Image.open(BytesIO(pic.data))
                w, h = img.size
                if w > _ART_TILE_WIDTH:
                    img = img.resize(
                        (_ART_TILE_WIDTH, round(h * _ART_TILE_WIDTH / w)),
                        Image.Resampling.LANCZOS,
                    )
                buf = BytesIO()
                _normalize_for_jpeg(img).save(buf, format="JPEG", quality=82, optimize=True)
                return buf.getvalue()
        except Exception:
            continue
    return None


@app.get("/api/albums/<int:album_id>/art")
def album_art(album_id):
    if album_id in _art_cache:
        data = _art_cache[album_id]
    else:
        data = _extract_art(album_id)
        if len(_art_cache) >= _ART_CACHE_MAX:
            _art_cache.pop(next(iter(_art_cache)))
        _art_cache[album_id] = data

    if data is None:
        return "", 404
    resp = Response(data, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _album_size_bytes(nas_path: str) -> int:
    """Sum FLAC file sizes on disk; 0 if unavailable."""
    if not NAS_ROOT or not nas_path:
        return 0
    album_dir = Path(NAS_ROOT) / nas_path
    if not album_dir.exists():
        return 0
    return sum(
        f.stat().st_size
        for f in album_dir.rglob("*.flac")
        if f.is_file()
    )


def _enrich_albums(rows: list[dict]) -> list[dict]:
    for row in rows:
        row["size_bytes"] = _album_size_bytes(row.get("nas_path", ""))
    return rows


# ---------------------------------------------------------------------------
# Routes – cards
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/cards")
def list_cards():
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("""
                SELECT c.id, c.name, c.target_size_gb, c.card_mount_path,
                       c.device_profile, c.status, c.created_at,
                       COUNT(ca.album_id) FILTER (WHERE ca.accepted) AS album_count
                FROM cards c
                LEFT JOIN card_albums ca ON ca.card_id = c.id
                GROUP BY c.id
                ORDER BY c.created_at DESC
            """)
            cards = [dict(r) for r in cur.fetchall()]
    for c in cards:
        sp = _stage_path(c)
        c["stage_path"]   = str(sp) if sp else None
        c["stage_exists"] = sp.exists() if sp else False
    return jsonify(cards)


@app.post("/api/cards")
def create_card():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        target_gb = float(data["target_size_gb"])
    except (KeyError, ValueError, TypeError):
        return jsonify({"error": "target_size_gb required"}), 400

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO cards (name, target_size_gb, card_mount_path, device_profile)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                (name, target_gb,
                 data.get("card_mount_path"), data.get("device_profile", "generic")),
            )
            card_id = cur.fetchone()[0]
        conn.commit()
    return jsonify({"id": card_id}), 201


@app.delete("/api/cards/<int:card_id>")
def delete_card(card_id):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cards WHERE id = %s RETURNING id", (card_id,))
            if cur.fetchone() is None:
                return jsonify({"error": "not found"}), 404
        conn.commit()
    return jsonify({"ok": True})


@app.get("/api/cards/<int:card_id>")
def get_card(card_id):
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404
            card = dict(card)

            cur.execute("""
                SELECT ca.album_id, ca.added_by, ca.accepted,
                       al.title, ar.name AS artist, al.year,
                       al.nas_path, al.is_compilation,
                       COALESCE(string_agg(DISTINCT g.name, ', ' ORDER BY g.name), '') AS genres
                FROM card_albums ca
                JOIN albums al ON al.id = ca.album_id
                JOIN artists ar ON ar.id = al.artist_id
                LEFT JOIN album_genres ag ON ag.album_id = al.id
                LEFT JOIN genres g ON g.id = ag.genre_id
                WHERE ca.card_id = %s
                GROUP BY ca.album_id, ca.added_by, ca.accepted,
                         al.title, ar.name, ar.sort_name, al.year, al.nas_path, al.is_compilation
                ORDER BY ar.sort_name, al.title
            """, (card_id,))
            albums = _enrich_albums([dict(r) for r in cur.fetchall()])

            cur.execute("""
                SELECT id, folder_name, size_bytes
                FROM card_unmanaged_paths WHERE card_id = %s
                ORDER BY folder_name
            """, (card_id,))
            unmanaged = [dict(r) for r in cur.fetchall()]

    sp = _stage_path(card)
    album_bytes    = sum(a["size_bytes"] for a in albums if a["accepted"])
    unmanaged_bytes = sum(u["size_bytes"] for u in unmanaged)

    result = card
    result["albums"]           = albums
    result["unmanaged_paths"]  = unmanaged
    result["album_bytes"]      = album_bytes
    result["unmanaged_bytes"]  = unmanaged_bytes
    result["used_bytes"]       = album_bytes + unmanaged_bytes
    result["target_bytes"]     = int(float(card["target_size_gb"]) * 1024 ** 3)
    result["stage_path"]       = str(sp) if sp else None
    result["stage_exists"]     = sp.exists() if sp else False
    return jsonify(result)


@app.patch("/api/cards/<int:card_id>")
def update_card(card_id):
    data = request.json or {}
    fields = []
    vals = []
    for col in ("name", "card_mount_path", "device_profile", "target_size_gb"):
        if col in data:
            fields.append(f"{col} = %s")
            vals.append(data[col])
    if not fields:
        return jsonify({"error": "nothing to update"}), 400
    vals.append(card_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE cards SET {', '.join(fields)} WHERE id = %s RETURNING id",
                vals,
            )
            if cur.fetchone() is None:
                return jsonify({"error": "not found"}), 404
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – album search
# ---------------------------------------------------------------------------

@app.get("/api/albums/search")
def search_albums():
    q      = request.args.get("q", "").strip()
    artist = request.args.get("artist", "").strip()
    genre  = request.args.get("genre", "").strip()
    limit  = min(int(request.args.get("limit", 20000)), 20000)
    card_id = request.args.get("card_id", type=int)

    conditions: list[str] = []
    params: list = []

    if q:
        conditions.append("(lower(al.title) LIKE %s OR lower(ar.name) LIKE %s)")
        pat = f"%{q.lower()}%"
        params += [pat, pat]
    if artist:
        conditions.append("lower(ar.name) LIKE %s")
        params.append(f"%{artist.lower()}%")
    if genre:
        conditions.append("""
            EXISTS (
                SELECT 1 FROM album_genres ag2
                JOIN genres g2 ON g2.id = ag2.genre_id
                WHERE ag2.album_id = al.id AND lower(g2.name) LIKE %s
            )
        """)
        params.append(f"%{genre.lower()}%")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute(f"""
                SELECT al.id, al.title, ar.name AS artist, al.year,
                       al.nas_path, al.is_compilation,
                       COALESCE(string_agg(DISTINCT g.name, ', ' ORDER BY g.name), '') AS genres
                FROM albums al
                JOIN artists ar ON ar.id = al.artist_id
                LEFT JOIN album_genres ag ON ag.album_id = al.id
                LEFT JOIN genres g ON g.id = ag.genre_id
                {where}
                GROUP BY al.id, al.title, ar.name, ar.sort_name, al.year, al.nas_path, al.is_compilation
                ORDER BY ar.sort_name, al.title
                LIMIT %s
            """, params + [limit])
            rows = [dict(r) for r in cur.fetchall()]
            for row in rows:
                row["size_bytes"] = 0

            if card_id:
                cur.execute(
                    "SELECT album_id FROM card_albums WHERE card_id = %s", (card_id,)
                )
                on_card = {r["album_id"] for r in cur.fetchall()}
                for row in rows:
                    row["on_card"] = row["id"] in on_card
            else:
                for row in rows:
                    row["on_card"] = False

            return jsonify(rows)


# ---------------------------------------------------------------------------
# Routes – card albums
# ---------------------------------------------------------------------------

@app.post("/api/cards/<int:card_id>/albums")
def add_album(card_id):
    data     = request.json or {}
    album_id = data.get("album_id")
    added_by = data.get("added_by", "user")
    if not album_id:
        return jsonify({"error": "album_id required"}), 400

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM cards WHERE id = %s", (card_id,))
            if not cur.fetchone():
                return jsonify({"error": "card not found"}), 404
            cur.execute("""
                INSERT INTO card_albums (card_id, album_id, added_by, accepted)
                VALUES (%s, %s, %s, true)
                ON CONFLICT (card_id, album_id) DO NOTHING
            """, (card_id, album_id, added_by))
        conn.commit()
    return jsonify({"ok": True}), 201


@app.delete("/api/cards/<int:card_id>/albums/<int:album_id>")
def remove_album(card_id, album_id):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM card_albums WHERE card_id = %s AND album_id = %s RETURNING card_id",
                (card_id, album_id),
            )
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
        conn.commit()
    return jsonify({"ok": True})


@app.patch("/api/cards/<int:card_id>/albums/<int:album_id>")
def patch_album(card_id, album_id):
    data     = request.json or {}
    accepted = data.get("accepted")
    if accepted is None:
        return jsonify({"error": "accepted required"}), 400
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE card_albums SET accepted = %s WHERE card_id = %s AND album_id = %s RETURNING card_id",
                (bool(accepted), card_id, album_id),
            )
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – unmanaged paths
# ---------------------------------------------------------------------------

@app.delete("/api/cards/<int:card_id>/unmanaged/<int:path_id>")
def delete_unmanaged(card_id, path_id):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM card_unmanaged_paths WHERE id = %s AND card_id = %s RETURNING id",
                (path_id, card_id),
            )
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – suggestions
# ---------------------------------------------------------------------------

@app.get("/api/cards/<int:card_id>/suggestions")
def get_suggestions(card_id):
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT target_size_gb FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404

            target_bytes = int(float(card["target_size_gb"]) * 1024 ** 3)

            cur.execute("""
                SELECT al.id, al.artist_id, al.year AS release_year, al.nas_path,
                       al.title, ar.name AS artist
                FROM card_albums ca
                JOIN albums al ON al.id = ca.album_id
                JOIN artists ar ON ar.id = al.artist_id
                WHERE ca.card_id = %s AND ca.accepted = true
            """, (card_id,))
            seed_rows      = cur.fetchall()
            seed_ids       = {r["id"] for r in seed_rows}
            seed_artist_ids = {r["artist_id"] for r in seed_rows}
            seed_years     = [r["release_year"] for r in seed_rows if r["release_year"]]

            if seed_ids:
                cur.execute("""
                    SELECT DISTINCT genre_id FROM album_genres
                    WHERE album_id = ANY(%s)
                """, (list(seed_ids),))
                seed_genre_ids = {r["genre_id"] for r in cur.fetchall()}
            else:
                seed_genre_ids = set()

            used_bytes = sum(_album_size_bytes(r["nas_path"]) for r in seed_rows)
            remaining  = target_bytes - used_bytes
            buffer     = int(target_bytes * 0.02)
            fill_target = remaining - buffer

            if fill_target <= 0:
                return jsonify({"suggestions": [], "remaining_bytes": remaining})

            cur.execute("""
                SELECT al.id, al.title, ar.name AS artist, al.year,
                       al.nas_path, al.is_compilation, al.artist_id,
                       COALESCE(string_agg(DISTINCT g.name, ', ' ORDER BY g.name), '') AS genres,
                       array_agg(DISTINCT ag.genre_id) AS genre_ids
                FROM albums al
                JOIN artists ar ON ar.id = al.artist_id
                LEFT JOIN album_genres ag ON ag.album_id = al.id
                LEFT JOIN genres g ON g.id = ag.genre_id
                WHERE al.id != ALL(%s)
                GROUP BY al.id, al.title, ar.name, ar.sort_name, al.year,
                         al.nas_path, al.is_compilation, al.artist_id
                ORDER BY ar.sort_name, al.title
            """, (list(seed_ids) if seed_ids else [0],))
            candidates = cur.fetchall()

    def score(row):
        s = 0
        if row["artist_id"] in seed_artist_ids:
            s += 100
        genre_ids = set(gid for gid in (row["genre_ids"] or []) if gid)
        if genre_ids & seed_genre_ids:
            s += 50
        if seed_years and row["year"]:
            min_gap = min(abs(row["year"] - y) for y in seed_years)
            if min_gap <= 5:
                s += 20
        return s

    scored = sorted(candidates, key=lambda r: (-score(r), r["artist"], r["title"]))

    suggestions = []
    space_left  = fill_target
    for row in scored[:800]:
        if space_left <= 0:
            break
        sz = _album_size_bytes(row["nas_path"])
        if sz == 0 or sz > space_left:
            continue
        suggestions.append({
            "id":        row["id"],
            "title":     row["title"],
            "artist":    row["artist"],
            "year":      row["year"],
            "genres":    row["genres"],
            "nas_path":  row["nas_path"],
            "size_bytes": sz,
        })
        space_left -= sz

    return jsonify({
        "suggestions":     suggestions,
        "remaining_bytes": remaining,
        "used_bytes":      used_bytes,
        "target_bytes":    target_bytes,
    })


@app.post("/api/cards/<int:card_id>/suggestions/accept")
def accept_suggestions(card_id):
    data      = request.json or {}
    album_ids = data.get("album_ids")
    if not album_ids:
        return jsonify({"error": "album_ids required"}), 400

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM cards WHERE id = %s", (card_id,))
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
            for aid in album_ids:
                cur.execute("""
                    INSERT INTO card_albums (card_id, album_id, added_by, accepted)
                    VALUES (%s, %s, 'suggestion', true)
                    ON CONFLICT (card_id, album_id) DO UPDATE SET accepted = true
                """, (card_id, aid))
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – build
# ---------------------------------------------------------------------------

@app.post("/api/cards/<int:card_id>/build")
def start_build_route(card_id):
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404
            card = dict(card)

    stage = _stage_path(card)
    if not stage:
        return jsonify({"error": "NAS_STAGE_PATH not configured in .env"}), 500

    started = build_job.start_build(card_id, DB_PARAMS, NAS_ROOT, str(stage))
    if not started:
        return jsonify({"error": "already running"}), 409
    return jsonify({"ok": True, "stage_path": str(stage)})


@app.get("/api/cards/<int:card_id>/build/status")
def build_status(card_id):
    state = build_job.get_job(card_id)
    if not state:
        return jsonify({"status": "idle"})
    return jsonify(state)


@app.get("/api/cards/<int:card_id>/build/stream")
def build_stream(card_id):
    def generate():
        last_log_idx = 0
        while True:
            state = build_job.get_job(card_id)
            if not state:
                yield f"data: {json.dumps({'status': 'idle'})}\n\n"
                break

            payload = {
                "status":        state["status"],
                "current_album": state["current_album"],
                "done":          state["done"],
                "total":         state["total"],
                "new_log":       state["log"][last_log_idx:],
            }
            last_log_idx = len(state["log"])

            if state["total"] > 0:
                payload["pct"] = round(state["done"] / state["total"] * 100, 1)
            else:
                payload["pct"] = 0

            elapsed = time.time() - state.get("started_at", time.time())
            if state["done"] > 0 and state["total"] > 0:
                rate      = state["done"] / elapsed
                remaining = state["total"] - state["done"]
                payload["eta_secs"] = int(remaining / rate) if rate > 0 else 0

            yield f"data: {json.dumps(payload)}\n\n"

            if state["status"] in ("done", "error"):
                break
            time.sleep(1)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Routes – sync
# ---------------------------------------------------------------------------

@app.post("/api/cards/<int:card_id>/sync")
def start_sync_route(card_id):
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404
            card = dict(card)
            cur.execute(
                "SELECT folder_name FROM card_unmanaged_paths WHERE card_id = %s",
                (card_id,),
            )
            unmanaged = [r["folder_name"] for r in cur.fetchall()]

    if not card.get("card_mount_path"):
        return jsonify({"error": "card_mount_path not set — add it in Settings"}), 400

    stage = _stage_path(card)
    if not stage or not stage.exists():
        return jsonify({"error": "Staging directory not found — build the card first"}), 400

    started = sync_job.start_sync(card_id, str(stage), card["card_mount_path"], unmanaged)
    if not started:
        return jsonify({"error": "already running"}), 409
    return jsonify({"ok": True})


@app.get("/api/cards/<int:card_id>/sync/stream")
def sync_stream(card_id):
    def generate():
        last_log_idx = 0
        while True:
            state = sync_job.get_job(card_id)
            if not state:
                yield f"data: {json.dumps({'status': 'idle'})}\n\n"
                break
            payload = {
                "status":  state["status"],
                "pct":     state.get("pct", 0),
                "new_log": state["log"][last_log_idx:],
            }
            last_log_idx = len(state["log"])
            yield f"data: {json.dumps(payload)}\n\n"
            if state["status"] in ("done", "error"):
                break
            time.sleep(1)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Routes – import from physical card
# ---------------------------------------------------------------------------

@app.post("/api/cards/<int:card_id>/import-card")
def import_from_card(card_id):
    """Scan mounted SD card, match folders to DB albums, flag unmanaged folders."""
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404
            card = dict(card)

    mount = card.get("card_mount_path")
    if not mount:
        return jsonify({"error": "card_mount_path not set"}), 400

    mount_path = Path(mount)
    if not mount_path.exists():
        return jsonify({"error": f"Mount path not found: {mount}"}), 400

    def _norm(s):
        return unicodedata.normalize('NFC', s).strip().lower()

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, nas_path FROM albums")
            album_by_folder = {_norm(Path(r[1]).name): r[0] for r in cur.fetchall()}

    matched_ids = []
    unmanaged   = []

    for item in sorted(mount_path.iterdir()):
        if not item.is_dir() or item.name.startswith("."):
            continue
        album_id = album_by_folder.get(_norm(item.name))
        if album_id:
            matched_ids.append(album_id)
        else:
            size = sum(f.stat().st_size for f in item.rglob("*") if f.is_file())
            unmanaged.append({"folder_name": item.name, "size_bytes": size})

    with get_conn() as conn:
        with conn.cursor() as cur:
            for album_id in matched_ids:
                cur.execute("""
                    INSERT INTO card_albums (card_id, album_id, added_by, accepted)
                    VALUES (%s, %s, 'user', true)
                    ON CONFLICT (card_id, album_id) DO NOTHING
                """, (card_id, album_id))
            for u in unmanaged:
                cur.execute("""
                    INSERT INTO card_unmanaged_paths (card_id, folder_name, size_bytes)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (card_id, folder_name) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
                """, (card_id, u["folder_name"], u["size_bytes"]))
        conn.commit()

    return jsonify({
        "matched":            len(matched_ids),
        "unmanaged":          len(unmanaged),
        "unmanaged_folders":  [u["folder_name"] for u in unmanaged],
    })


# ---------------------------------------------------------------------------
# Routes – export / import card definition
# ---------------------------------------------------------------------------

@app.get("/api/cards/<int:card_id>/export")
def export_card_definition(card_id):
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
            card = cur.fetchone()
            if not card:
                return jsonify({"error": "not found"}), 404
            card = dict(card)

            cur.execute("""
                SELECT ca.added_by, al.nas_path, al.title, ar.name AS artist
                FROM card_albums ca
                JOIN albums al ON al.id = ca.album_id
                JOIN artists ar ON ar.id = al.artist_id
                WHERE ca.card_id = %s AND ca.accepted = true
                ORDER BY ar.sort_name, al.title
            """, (card_id,))
            albums = [dict(r) for r in cur.fetchall()]

    definition = {
        "name":             card["name"],
        "target_size_gb":   float(card["target_size_gb"]),
        "device_profile":   card["device_profile"],
        "card_mount_path":  card["card_mount_path"],
        "albums":           albums,
        "exported_at":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    filename = f"card_{_safe_name(card['name'])}.json"
    return Response(
        json.dumps(definition, indent=2),
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/cards/import-definition")
def import_card_definition():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO cards (name, target_size_gb, card_mount_path, device_profile)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                (name, data.get("target_size_gb", 32),
                 data.get("card_mount_path"), data.get("device_profile", "generic")),
            )
            card_id = cur.fetchone()[0]

            matched   = 0
            unmatched = []
            for a in data.get("albums", []):
                nas_path = a.get("nas_path", "")
                cur.execute("SELECT id FROM albums WHERE nas_path = %s", (nas_path,))
                row = cur.fetchone()
                if row:
                    cur.execute("""
                        INSERT INTO card_albums (card_id, album_id, added_by, accepted)
                        VALUES (%s, %s, %s, true)
                        ON CONFLICT DO NOTHING
                    """, (card_id, row[0], a.get("added_by", "user")))
                    matched += 1
                else:
                    unmatched.append(nas_path)
        conn.commit()

    return jsonify({
        "id":              card_id,
        "matched":         matched,
        "unmatched":       len(unmatched),
        "unmatched_paths": unmatched,
    }), 201


# ---------------------------------------------------------------------------
# Genres
# ---------------------------------------------------------------------------

@app.get("/api/genres")
def list_genres():
    with get_conn() as conn:
        with dict_cursor(conn) as cur:
            cur.execute("SELECT id, name FROM genres ORDER BY name")
            return jsonify([dict(r) for r in cur.fetchall()])


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=True)
