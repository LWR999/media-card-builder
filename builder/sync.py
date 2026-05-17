"""Sync job: rsync staged build to SD card mount."""
import subprocess
import threading
import time

_jobs: dict[int, dict] = {}
_lock = threading.Lock()


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


def _run_sync(card_id: int, stage_path: str, card_mount_path: str,
              unmanaged_folders: list[str]):
    try:
        src = stage_path.rstrip("/") + "/"
        dst = card_mount_path.rstrip("/") + "/"

        cmd = ["rsync", "-av", "--delete"]
        for folder in unmanaged_folders:
            # Exclude by folder name so --delete doesn't remove them from the card
            cmd += ["--exclude", folder.rstrip("/") + "/"]
        cmd += [src, dst]

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
            if line:
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
