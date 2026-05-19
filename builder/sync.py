"""Sync job: rsync staged build to SD card mount."""
import os
import re
import subprocess
import threading
import time
from pathlib import Path

_PROGRESS_RE   = re.compile(r'to-chk=(\d+)/(\d+)')
_PROGRESS_LINE = re.compile(r'^\s*[\d,]+\s+\d+%')

_MAC_DETRITUS = {".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd"}


def _clean_staging(stage_path: str, log_fn):
    """Remove Mac detritus from the staging root before rsync."""
    removed = 0
    for root, dirs, files in os.walk(stage_path):
        root_path = Path(root)
        for fname in files:
            if fname.startswith("._") or fname in _MAC_DETRITUS:
                try:
                    (root_path / fname).unlink()
                    removed += 1
                except OSError:
                    pass
        dirs[:] = [d for d in dirs if d not in _MAC_DETRITUS]
    if removed:
        log_fn(f"Removed {removed} Mac detritus file(s) from staging.")

_LOG_DIR = Path("logs")

_jobs: dict[int, dict] = {}
_lock = threading.Lock()


def _log_file(card_id: int) -> Path:
    return _LOG_DIR / f"sync_{card_id}.log"


def get_job(card_id: int) -> dict | None:
    with _lock:
        return _jobs.get(card_id)


def start_sync(card_id: int, stage_path: str, card_mount_path: str,
               unmanaged_folders: list[str]) -> bool:
    with _lock:
        if card_id in _jobs and _jobs[card_id].get("status") == "running":
            return False
        _jobs[card_id] = {
            "status":     "running",
            "log":        [],
            "pct":        0,
            "started_at": time.time(),
        }
    try:
        _LOG_DIR.mkdir(exist_ok=True)
        with _log_file(card_id).open("a") as f:
            f.write(f"\n{'='*60}\n{time.strftime('%Y-%m-%d %H:%M:%S')} — sync started\n{'='*60}\n")
    except OSError:
        pass
    threading.Thread(
        target=_run_sync,
        args=(card_id, stage_path, card_mount_path, unmanaged_folders),
        daemon=True,
    ).start()
    return True


def _append_log(card_id: int, line: str):
    with _lock:
        if card_id in _jobs:
            _jobs[card_id]["log"].append(line)
    try:
        with _log_file(card_id).open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _run_sync(card_id: int, stage_path: str, card_mount_path: str,
              unmanaged_folders: list[str]):
    try:
        src = stage_path.rstrip("/") + "/"
        dst = card_mount_path.rstrip("/") + "/"

        cmd = ["rsync", "-rlv", "--no-perms", "--no-owner", "--no-group",
               "--omit-dir-times", "--size-only", "--delete",
               "--info=progress2"]
        for folder in unmanaged_folders:
            # Exclude by folder name so --delete doesn't remove them from the card
            cmd += ["--exclude", folder.rstrip("/") + "/"]
        cmd += [src, dst]

        _clean_staging(stage_path, lambda msg: _append_log(card_id, msg))
        _append_log(card_id, f"rsync {src} → {dst}")
        if unmanaged_folders:
            _append_log(card_id,
                        f"Preserving {len(unmanaged_folders)} unmanaged folder(s): " +
                        ", ".join(unmanaged_folders))
        _append_log(card_id, "")

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            if _PROGRESS_LINE.match(line):
                m = _PROGRESS_RE.search(line)
                if m:
                    remaining = int(m.group(1))
                    total = int(m.group(2))
                    if total > 0:
                        pct = int((total - remaining) / total * 100)
                        with _lock:
                            if card_id in _jobs:
                                _jobs[card_id]["pct"] = pct
            else:
                _append_log(card_id, line)

        proc.wait()

        if proc.returncode == 0:
            _append_log(card_id, "\nSync complete.")
            with _lock:
                if card_id in _jobs:
                    _jobs[card_id].update({"status": "done", "pct": 100})
        else:
            _append_log(card_id, f"\nrsync exited with code {proc.returncode}")
            with _lock:
                if card_id in _jobs:
                    _jobs[card_id]["status"] = "error"

    except Exception as e:
        _append_log(card_id, f"FATAL: {e}")
        with _lock:
            if card_id in _jobs:
                _jobs[card_id]["status"] = "error"
