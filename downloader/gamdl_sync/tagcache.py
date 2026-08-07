"""A cache for audio tags.

Rebuilding a playlist means reading the title, artist and duration of every
track in it. Those never change once a file is on disk, but the previous
implementation re-derived them every cycle: measured at one open, three stats
and four lstats per entry — 16,000 filesystem operations for a 2,000-track
playlist, every hour, forever. On the NAS share that a library of that size
actually lives on, each of those is a network round trip.

The cache is keyed on identity *and* content: a path whose size or mtime has
changed is re-read, so replacing a file with a better rip is picked up
immediately. It lives in ``/config`` beside the other shared state and is pruned
against the paths still in use, so it cannot grow without bound.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .state import atomic_write_json, read_json

log = logging.getLogger(__name__)

__all__ = ["TagCache"]

#: Bump when the stored tuple's shape changes, so old entries are discarded
#: rather than misread.
SCHEMA = 1


class TagCache:
    """Maps ``path -> (size, mtime_ns, duration, title, artist)``."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._entries: dict[str, list] = {}
        self._dirty = False
        self._loaded = False

    # ------------------------------------------------------------------ #

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        data = read_json(self.path, None)
        if not isinstance(data, dict) or data.get("schema") != SCHEMA:
            return
        entries = data.get("entries")
        if isinstance(entries, dict):
            self._entries = {
                key: value
                for key, value in entries.items()
                if isinstance(value, list) and len(value) == 5
            }

    def get(self, path: Path, size: int, mtime_ns: int) -> tuple[int, str, str] | None:
        """Return cached tags, or None if absent or stale."""
        self.load()
        entry = self._entries.get(str(path))
        if entry is None:
            return None
        cached_size, cached_mtime, duration, title, artist = entry
        if cached_size != size or cached_mtime != mtime_ns:
            return None
        return int(duration), str(title), str(artist)

    def put(self, path: Path, size: int, mtime_ns: int, tags: tuple[int, str, str]) -> None:
        self.load()
        duration, title, artist = tags
        self._entries[str(path)] = [size, mtime_ns, duration, title, artist]
        self._dirty = True

    def prune(self, keep: set[str]) -> None:
        """Drop entries for files no playlist references any more."""
        self.load()
        if not keep:
            return
        pruned = {key: value for key, value in self._entries.items() if key in keep}
        if len(pruned) != len(self._entries):
            self._entries = pruned
            self._dirty = True

    def save(self) -> None:
        if not self._dirty:
            return
        try:
            # Not durable: losing this on a power cut costs one slow cycle, not
            # correctness — every entry is re-derivable from the files.
            atomic_write_json(
                self.path, {"schema": SCHEMA, "entries": self._entries}, durable=False
            )
            self._dirty = False
        except OSError as exc:
            log.debug("could not save the tag cache: %s", exc)

    def __len__(self) -> int:
        self.load()
        return len(self._entries)
