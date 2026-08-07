"""Durable state shared with the web UI.

Two processes touch these files: this daemon and the Next.js server. Neither can
assume it is alone, so every write goes through a temp file plus ``os.replace``
(atomic on POSIX) and every read-modify-write holds an advisory lock on a
sidecar ``.lock`` file. A reader that arrives mid-write sees either the old file
or the new one, never a truncated one.

Reads are deliberately forgiving. A corrupt status file is an annoyance; a daemon
that refuses to start because of one is an outage.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_FILE_MODE",
    "PRIVATE_FILE_MODE",
    "FileLock",
    "NameCache",
    "StatusStore",
    "atomic_write_json",
    "atomic_write_text",
    "read_heartbeat",
    "read_json",
    "write_heartbeat",
]


# --------------------------------------------------------------------------- #
# Primitives
# --------------------------------------------------------------------------- #


#: A lock older than this is assumed to belong to a process that died holding
#: it. Both sides of the fence use the same value — see webui/lib/fsx.ts.
LOCK_STALE_SECONDS = 30.0
LOCK_SUFFIX = ".lock"


@contextmanager
def FileLock(path: Path, *, timeout: float = 30.0) -> Iterator[None]:  # noqa: N802
    """Exclusive lock on ``<path>.lock``, shared with the web UI.

    The obvious implementation is ``flock``, and that is what this used to be —
    but Node has no ``flock``, so the web UI could only take an ``O_EXCL``
    lockfile. Two different mechanisms on two different filenames are two locks
    that do not exclude each other, which is worse than no lock at all because
    the code reads as though it is safe. Both sides now race for the same file
    with ``O_EXCL``, the one primitive both runtimes have.

    A sidecar is locked rather than the file itself so the lock survives the
    ``os.replace`` that swaps the real file out from under us.
    """
    lock_path = path.with_name(path.name + LOCK_SUFFIX)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    acquired = False

    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if _lock_is_stale(lock_path):
                log.warning("breaking a stale lock on %s", path.name)
                with contextlib.suppress(OSError):
                    lock_path.unlink()
                continue
            if time.monotonic() >= deadline:
                # Proceeding unlocked is better than stalling the sync loop
                # forever. Writes are atomic regardless, so the worst case is a
                # lost concurrent update, not a corrupt file.
                log.warning("timed out waiting for the lock on %s; proceeding", path.name)
                break
            time.sleep(0.05)
            continue
        except OSError as exc:
            log.warning("could not create a lock for %s (%s); proceeding", path.name, exc)
            break

        with os.fdopen(fd, "w") as handle:
            handle.write(f'{{"pid": {os.getpid()}, "ts": {time.time():.3f}}}')
        acquired = True
        break

    try:
        yield
    finally:
        if acquired:
            with contextlib.suppress(OSError):
                lock_path.unlink()


def _lock_is_stale(lock_path: Path) -> bool:
    try:
        return (time.time() - lock_path.stat().st_mtime) > LOCK_STALE_SECONDS
    except OSError:
        # It vanished between the failed create and the stat — treat it as free.
        return True


def read_json(path: Path | str, default: Any = None) -> Any:
    """Read JSON, returning ``default`` for anything that goes wrong."""
    path = Path(path)
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        log.warning("ignoring unreadable JSON at %s: %s", path, exc)
        return default


# Files in /config are read by the web container as well as written here, so
# they need to be group- and world-readable. mkstemp creates at 0600 and the
# mode survives os.replace, which silently made every state file unreadable to
# the web UI.
DEFAULT_FILE_MODE = 0o644
#: For anything that is, or sits beside, a credential.
PRIVATE_FILE_MODE = 0o600


def atomic_write_text(path: Path | str, text: str, *, mode: int | None = None) -> None:
    """Write ``text`` so that readers only ever observe a complete file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        tmp.chmod(DEFAULT_FILE_MODE if mode is None else mode)
        tmp.replace(path)
        _fsync_dir(path.parent)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_json(path: Path | str, data: Any, *, mode: int | None = None) -> None:
    """Atomically write ``data`` as pretty-printed UTF-8 JSON."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    atomic_write_text(path, text, mode=mode)


def _fsync_dir(directory: Path) -> None:
    """Persist the rename itself, not just the file contents."""
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


# --------------------------------------------------------------------------- #
# Status store
# --------------------------------------------------------------------------- #


def _utcnow() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class StatusStore:
    """``playlist-status.json`` — one entry per playlist URL.

    The web UI polls this constantly, so updates are merge-in-place: a field the
    caller does not mention keeps its previous value. That lets the daemon push a
    progress tick without having to restate everything it knows.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, dict]:
        data = read_json(self.path, {})
        return data if isinstance(data, dict) else {}

    def update(self, url: str, **fields: Any) -> dict:
        """Merge ``fields`` into the entry for ``url`` and return it."""
        with FileLock(self.path):
            data = self.read()
            entry = data.get(url)
            if not isinstance(entry, dict):
                entry = {}
            entry.update({k: v for k, v in fields.items() if v is not None})
            data[url] = entry
            atomic_write_json(self.path, data)
        return entry

    def mark_running(self, url: str, name: str | None = None) -> None:
        self.update(
            url,
            status="running",
            startedAt=_utcnow(),
            name=name,
            lastError="",
            progress={"current": 0, "total": 0},
        )

    def mark_finished(
        self,
        url: str,
        status: str,
        *,
        name: str | None = None,
        playlist_file: str | None = None,
        song_count: int | None = None,
        available_count: int | None = None,
        missing_count: int | None = None,
        duration_seconds: float | None = None,
        error: str | None = None,
    ) -> None:
        fields: dict[str, Any] = {
            "status": status,
            "name": name,
            "playlistFile": playlist_file,
            "songCount": song_count,
            "availableCount": available_count,
            "missingCount": missing_count,
            "durationSeconds": (
                round(duration_seconds, 1) if duration_seconds is not None else None
            ),
            # Empty string, not None, so a previous error is actually cleared.
            "lastError": error or "",
        }
        if status == "failed":
            fields["failedAt"] = _utcnow()
        else:
            fields["lastDownloaded"] = _utcnow()
        self.update(url, **fields)

    def set_progress(self, url: str, current: int, total: int) -> None:
        self.update(url, progress={"current": current, "total": total})

    def reset_to_idle(self, urls: list[str]) -> None:
        """Mark the given URLs idle and forget everything else.

        Dropping unknown URLs is what keeps the file from growing forever as
        playlists come and go.
        """
        with FileLock(self.path):
            data = self.read()
            kept = {}
            for url in urls:
                entry = data.get(url)
                entry = dict(entry) if isinstance(entry, dict) else {}
                if entry.get("status") != "running":
                    entry["status"] = "idle"
                kept[url] = entry
            atomic_write_json(self.path, kept)

    def forget(self, url: str) -> None:
        with FileLock(self.path):
            data = self.read()
            if url in data:
                del data[url]
                atomic_write_json(self.path, data)


# --------------------------------------------------------------------------- #
# Name cache
# --------------------------------------------------------------------------- #


class NameCache:
    """``playlist-name-cache.json`` — Apple's title for each playlist URL.

    Written by both the web UI (which resolves titles when a playlist is added)
    and the daemon (which records the name it actually used). Legacy files stored
    a bare string per URL; those are upgraded to dicts on read.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, dict]:
        raw = read_json(self.path, {})
        if not isinstance(raw, dict):
            return {}
        out: dict[str, dict] = {}
        for url, value in raw.items():
            if isinstance(value, str):
                out[url] = {"name": value}
            elif isinstance(value, dict):
                out[url] = value
        return out

    def set_name(self, url: str, name: str) -> None:
        with FileLock(self.path):
            data = self.read()
            entry = data.get(url) or {}
            entry["name"] = name
            data[url] = entry
            # 0600: the cache is not secret, but it lives beside cookies.txt and
            # inherits the same conservative posture.
            atomic_write_json(self.path, data, mode=PRIVATE_FILE_MODE)

    def prune(self, keep: list[str]) -> None:
        keep_set = set(keep)
        with FileLock(self.path):
            data = self.read()
            pruned = {k: v for k, v in data.items() if k in keep_set}
            if len(pruned) != len(data):
                atomic_write_json(self.path, pruned, mode=PRIVATE_FILE_MODE)


# --------------------------------------------------------------------------- #
# Heartbeat
# --------------------------------------------------------------------------- #


def write_heartbeat(
    path: Path | str,
    *,
    state: str,
    cycle: int,
    detail: str = "",
    stalled_for: float = 0.0,
) -> None:
    """Publish liveness for the container healthcheck and the web UI.

    A file beats ``pgrep`` because it proves the loop is *progressing*, not just
    that a process with the right name exists.
    """
    try:
        atomic_write_json(
            path,
            {
                "ts": time.time(),
                "iso": _utcnow(),
                "pid": os.getpid(),
                "state": state,
                "cycle": cycle,
                "detail": detail,
                # Seconds since the daemon last changed what it was doing. The
                # write timestamp alone would stay fresh forever while the sync
                # thread is wedged, so this is what "is it healthy" reads.
                "stalledFor": round(stalled_for, 1),
            },
        )
    except OSError as exc:
        log.debug("heartbeat write failed: %s", exc)


def read_heartbeat(path: Path | str) -> dict:
    data = read_json(path, {})
    return data if isinstance(data, dict) else {}
