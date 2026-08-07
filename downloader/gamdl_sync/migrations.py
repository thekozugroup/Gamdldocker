"""One-time upgrades of on-disk state.

Existing installs must survive ``git pull && docker compose up -d --build`` with
no manual steps, so anything that changed shape between versions is fixed up
here. Each migration records that it ran in ``/config/.migrations.json`` and is
skipped forever after, which keeps startup cheap and makes the migrations safe to
write non-idempotently.
"""

from __future__ import annotations

import logging
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from .state import PRIVATE_FILE_MODE, atomic_write_json, read_json

if TYPE_CHECKING:  # pragma: no cover
    from .daemon import Paths

log = logging.getLogger(__name__)

__all__ = ["run_migrations"]


def run_migrations(paths: Paths) -> list[str]:
    """Run every migration that has not run yet. Returns the names applied."""
    ledger = read_json(paths.migrations, {})
    if not isinstance(ledger, dict):
        ledger = {}
    applied: list[str] = []

    for name, migration in _MIGRATIONS:
        if ledger.get(name):
            continue
        try:
            migration(paths)
        except Exception as exc:
            log.warning("migration %s failed: %s", name, exc)
            continue
        ledger[name] = {"appliedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        applied.append(name)
        log.info("applied migration: %s", name)

    if applied:
        atomic_write_json(paths.migrations, ledger)
    return applied


def _move_legacy_playlist_folder(paths: Paths) -> None:
    """Relocate ``<library>/Playlists/**`` into the configured playlist folder.

    gamdl's default template writes to ``Playlists/<artist>/<title>.m3u`` under
    the library root. Older versions of this project moved those files after the
    fact; the daemon now points gamdl straight at the right folder, so anything
    left in the old location is swept in once.
    """
    from .config import load_settings

    settings = load_settings(paths.settings)
    legacy = Path(settings.output_location) / "Playlists"
    destination = Path(settings.playlist_m3u_dir)
    if not legacy.is_dir():
        return
    if _same_directory(legacy, destination):
        # On a case-insensitive mount (Docker Desktop on macOS and Windows)
        # "Playlists" and "playlists" are the same directory, so a path-string
        # comparison would say they differ and we would move every file onto
        # itself.
        return

    destination.mkdir(parents=True, exist_ok=True)
    moved = 0
    for source in legacy.rglob("*"):
        if not source.is_file() or source.suffix.lower() not in (".m3u", ".m3u8"):
            continue
        target = destination / source.name
        if target.exists():
            target = destination / f"{source.stem}.{int(time.time())}{source.suffix}"
        try:
            shutil.move(str(source), str(target))
            moved += 1
        except OSError as exc:
            log.warning("could not move %s: %s", source, exc)

    if moved:
        log.info("moved %d playlist file(s) out of the legacy Playlists folder", moved)
    # Remove the now-empty tree, but never anything containing real files.
    try:
        for directory in sorted(legacy.rglob("*"), reverse=True):
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        if legacy.is_dir() and not any(legacy.iterdir()):
            legacy.rmdir()
    except OSError:
        pass


def _same_directory(first: Path, second: Path) -> bool:
    """True when both paths name the same directory on disk.

    ``samefile`` compares inode identity, which is the only answer that holds on
    case-insensitive filesystems and through symlinks.
    """
    try:
        return first.samefile(second)
    except (OSError, FileNotFoundError):
        return first.resolve() == second.resolve()


def _upgrade_name_cache(paths: Paths) -> None:
    """Turn legacy ``{"<url>": "Name"}`` entries into ``{"name": ...}`` dicts."""
    data = read_json(paths.name_cache, None)
    if not isinstance(data, dict) or not data:
        return
    changed = False
    upgraded: dict[str, dict] = {}
    for url, value in data.items():
        if isinstance(value, str):
            upgraded[url] = {"name": value}
            changed = True
        elif isinstance(value, dict):
            upgraded[url] = value
        else:
            changed = True
    if changed:
        atomic_write_json(paths.name_cache, upgraded, mode=PRIVATE_FILE_MODE)


def _drop_dead_webui_env(paths: Paths) -> None:
    """Remove ``/config/webui.env``.

    The settings route wrote it on every save and nothing ever read it — not the
    entrypoint, not compose, not gamdl. Leaving a stale file that looks
    authoritative is worse than removing it.
    """
    path = paths.config_dir / "webui.env"
    if path.is_file():
        path.unlink(missing_ok=True)
        log.info("removed unused webui.env")


def _secure_cookie_files(paths: Paths) -> None:
    """Tighten permissions on credential files written by older versions."""
    for name in ("cookies.txt", "music.apple.com_cookies.txt", "playlist-name-cache.json"):
        path = paths.config_dir / name
        if path.is_file():
            try:
                path.chmod(PRIVATE_FILE_MODE)
            except OSError as exc:
                log.debug("could not chmod %s: %s", name, exc)


_MIGRATIONS: list[tuple[str, Callable[[Paths], None]]] = [
    ("2024.legacy-playlists-folder", _move_legacy_playlist_folder),
    ("2024.name-cache-dict-shape", _upgrade_name_cache),
    ("2024.remove-webui-env", _drop_dead_webui_env),
    ("2024.secure-config-permissions", _secure_cookie_files),
]
