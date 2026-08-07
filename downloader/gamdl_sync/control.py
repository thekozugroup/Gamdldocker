"""Control channel between the web UI and the daemon.

The previous design had the web UI run ``docker restart gamdl-downloader`` to
trigger a sync, which meant mounting ``/var/run/docker.sock`` into the web
container. That mount is equivalent to giving the web UI root on the host, and it
made "Sync Now" abort whatever was in flight.

Instead the two processes share the ``/config`` volume they already share, and
the UI drops a small file the daemon picks up within a second. No socket, no
restart, no privilege.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from .state import atomic_write_json

log = logging.getLogger(__name__)

__all__ = ["CANCEL", "RELOAD", "SYNC_NOW", "Command", "ControlChannel"]

SYNC_NOW = "sync-now"
RELOAD = "reload"
CANCEL = "cancel"

KNOWN_COMMANDS = (SYNC_NOW, RELOAD, CANCEL)

# A command file larger than this is not something we wrote.
_MAX_COMMAND_BYTES = 64 * 1024


@dataclass(frozen=True)
class Command:
    name: str
    payload: dict

    @property
    def urls(self) -> list[str]:
        """Playlists this command is scoped to; empty means all of them."""
        raw = self.payload.get("urls")
        if isinstance(raw, list):
            return [str(u) for u in raw if isinstance(u, str) and u.strip()]
        return []


class ControlChannel:
    """Consume command files from ``<config>/control``."""

    def __init__(self, directory: Path | str) -> None:
        self.directory = Path(directory)

    def ensure(self) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("could not create control directory %s: %s", self.directory, exc)

    def emit(self, name: str, payload: dict | None = None) -> None:
        """Write a command. Used by tests and by the CLI helper."""
        self.ensure()
        atomic_write_json(self.directory / name, payload or {})

    def poll(self) -> list[Command]:
        """Read and remove every pending command.

        Removal happens before the command is acted on, so a command that
        crashes the cycle is not replayed forever on restart.
        """
        if not self.directory.is_dir():
            return []
        commands: list[Command] = []
        try:
            names = sorted(p.name for p in self.directory.iterdir() if p.is_file())
        except OSError:
            return []

        for name in names:
            path = self.directory / name
            if name not in KNOWN_COMMANDS:
                log.debug("ignoring unknown control file %s", name)
                path.unlink(missing_ok=True)
                continue
            payload: dict = {}
            try:
                if path.stat().st_size <= _MAX_COMMAND_BYTES:
                    parsed = json.loads(path.read_text(encoding="utf-8") or "{}")
                    if isinstance(parsed, dict):
                        payload = parsed
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                # An empty or malformed file still means "the user pressed the
                # button" — honour the command with default scope.
                payload = {}
            path.unlink(missing_ok=True)
            commands.append(Command(name=name, payload=payload))

        return commands
