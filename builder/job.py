"""Build job: copies albums to staging path and applies prep processing."""
import logging
import threading
import time
from pathlib import Path

import psycopg2

from builder.prep import process_album_directory

log = logging.getLogger(__name__)

_jobs: dict[int, dict] = {}
_lock = threading.Lock()


def get_job(card_id: int) -> dict | None:
    with _lock:
        return _jobs.get(card_id)


def _update_job(card_id: int, **kwargs):
    with _lock:
        if card_id in _jobs:
            _jobs[card_id].update(kwargs)


def start_build(card_id: int, db_params: dict, nas_root: str, stage_path: str,
                personal_root: str = "") -> bool:
    with _lock:
        if card_id in _jobs and _jobs[card_id].get("status") == "running":
            return False
        _jobs[card_id] = {
            "status":        "running",
            "current_album": "",
            "done":          0,
            "total":         0,
            "errors":        [],
            "log":           [],
            "started_at":    time.time(),
        }

    threading.Thread(
        target=_run_build,
        args=(card_id, db_params, nas_root, stage_path, personal_root),
        daemon=True,
    ).start()
    return True


def _run_build(card_id: int, db_params: dict, nas_root: str, stage_path: str,
               personal_root: str = ""):
    conn = None
    try:
        conn = psycopg2.connect(**db_params)
        conn.autocommit = False
        cur = conn.cursor()

        cur.execute("""
            SELECT ca.album_id, ar.name AS artist, al.title, al.nas_path
            FROM cards c
            JOIN card_albums ca ON ca.card_id = c.id
            JOIN albums al ON al.id = ca.album_id
            JOIN artists ar ON ar.id = al.artist_id
            WHERE c.id = %s AND ca.accepted = true
            ORDER BY ar.sort_name, al.title
        """, (card_id,))
        album_rows = cur.fetchall()

        cur.execute("""
            SELECT folder_name, display_name
            FROM card_personal_items WHERE card_id = %s
            ORDER BY display_name
        """, (card_id,))
        personal_rows = cur.fetchall()

        total = len(album_rows) + len(personal_rows)
        if total == 0:
            _update_job(card_id, status="done", total=0)
            return

        _update_job(card_id, total=total)

        nas_root_path = Path(nas_root.rstrip("/"))
        output_root   = Path(stage_path)
        output_root.mkdir(parents=True, exist_ok=True)

        for idx, (album_id, artist, title, nas_path) in enumerate(album_rows):
            folder_name = Path(nas_path).name
            dest_dir    = output_root / folder_name
            _update_job(card_id, current_album=f"{artist} - {title}", done=idx)
            _append_log(card_id, f"[{idx+1}/{total}] {artist} - {title}")

            if dest_dir.exists() and any(dest_dir.glob("*.flac")):
                _append_log(card_id, "  Skipped (already exists)")
                continue

            src_dir = nas_root_path / nas_path
            if not src_dir.exists():
                _append_log(card_id, f"  ERROR: source not found: {src_dir}")
                _jobs[card_id]["errors"].append(f"{artist} - {title}: source missing")
                continue

            try:
                _copy_album(src_dir, dest_dir)
                process_album_directory(dest_dir, log=lambda m: _append_log(card_id, m))
            except Exception as e:
                _append_log(card_id, f"  ERROR: {e}")
                _jobs[card_id]["errors"].append(f"{artist} - {title}: {e}")

        personal_root_path = Path(personal_root) if personal_root else None
        for idx, (folder_name, display_name) in enumerate(personal_rows):
            overall = len(album_rows) + idx
            dest_dir = output_root / folder_name
            _update_job(card_id, current_album=f"[Personal] {display_name}", done=overall)
            _append_log(card_id, f"[{overall+1}/{total}] [Personal] {display_name}")

            if dest_dir.exists():
                _append_log(card_id, "  Skipped (already exists)")
                continue

            if not personal_root_path:
                _append_log(card_id, "  ERROR: NAS_PERSONAL_PATH not configured")
                continue

            src_dir = personal_root_path / folder_name
            if not src_dir.exists():
                _append_log(card_id, f"  ERROR: personal source not found: {src_dir}")
                _jobs[card_id]["errors"].append(f"[Personal] {display_name}: source missing")
                continue

            try:
                _copy_dir(src_dir, dest_dir)
            except Exception as e:
                _append_log(card_id, f"  ERROR: {e}")
                _jobs[card_id]["errors"].append(f"[Personal] {display_name}: {e}")

        cur.execute("UPDATE cards SET status = 'built' WHERE id = %s", (card_id,))
        conn.commit()
        _update_job(card_id, status="done", done=total)
        _append_log(card_id, "Build complete.")

    except Exception as e:
        log.exception("Build job failed for card %d", card_id)
        _update_job(card_id, status="error")
        _append_log(card_id, f"FATAL: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()


def _copy_album(src_dir: Path, dest_dir: Path):
    import shutil
    dest_dir.mkdir(parents=True, exist_ok=True)
    for item in src_dir.rglob("*"):
        if item.name.startswith("._") or item.name == ".DS_Store":
            continue
        rel = item.relative_to(src_dir)
        dst = dest_dir / rel
        if item.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        elif item.is_file() and item.suffix.lower() == ".flac":
            shutil.copy2(str(item), str(dst))


def _copy_dir(src_dir: Path, dest_dir: Path):
    """Copy all files from src to dest, skipping macOS metadata files."""
    import shutil
    dest_dir.mkdir(parents=True, exist_ok=True)
    for item in src_dir.rglob("*"):
        if item.name.startswith("._") or item.name == ".DS_Store":
            continue
        rel = item.relative_to(src_dir)
        dst = dest_dir / rel
        if item.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        elif item.is_file():
            shutil.copy2(str(item), str(dst))


def _append_log(card_id: int, line: str):
    with _lock:
        if card_id in _jobs:
            _jobs[card_id]["log"].append(line)
