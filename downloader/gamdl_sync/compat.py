"""Runtime guards against known upstream crashes.

We would rather not touch gamdl's source, and none of this runs unless the exact
fragile code is present. The alternative is worse: the bug below aborts an entire
playlist over a single track, and the previous version of this project patched it
at image-build time — which the auto-updater then silently undid on the next
``pip install --upgrade gamdl``.

Every patch here must be:

* **precise** — it matches an exact source fragment and does nothing if upstream
  has changed, so a future release is never corrupted;
* **idempotent** — re-applied after every upgrade without stacking;
* **loud** — it logs what it changed, so the behaviour is never a mystery.

Delete a patch as soon as the corresponding upstream fix ships.
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

__all__ = ["apply_compat_patches"]


@dataclass(frozen=True)
class SourcePatch:
    """A single exact-match source rewrite."""

    name: str
    module: str
    marker: str  # already patched if present
    old: str
    new: str
    why: str

    def apply(self) -> str:
        """Returns one of: applied, already, not-needed, unwritable, missing."""
        try:
            module = importlib.import_module(self.module)
        except Exception:
            return "missing"

        file_path = getattr(module, "__file__", None)
        if not file_path:
            return "missing"
        path = Path(file_path)

        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return "missing"

        if self.marker in content:
            return "already"
        if self.old not in content:
            # Upstream changed shape; assume they fixed it and stay out of it.
            return "not-needed"

        try:
            path.write_text(content.replace(self.old, self.new, 1), encoding="utf-8")
        except OSError as exc:
            log.warning("could not apply the %s guard (%s). %s", self.name, exc, self.why)
            return "unwritable"
        return "applied"


_EMPTY_PLAYLIST_TRACK_GUARD = SourcePatch(
    name="empty-playlist-track",
    module="gamdl.downloader.downloader",
    marker="gamdl_sync: playlist_track guard",
    old=(
        "        if len(playlist_file_lines) < playlist_track:\n"
        "            playlist_file_lines.extend("
    ),
    new=(
        "        # gamdl_sync: playlist_track guard — indexing [playlist_track - 1]\n"
        "        # with a track number of 0 or None hits [-1] on an empty list and\n"
        "        # raises IndexError, which aborts the whole playlist.\n"
        "        if not playlist_track or playlist_track < 1:\n"
        "            return\n"
        "        if len(playlist_file_lines) < playlist_track:\n"
        "            playlist_file_lines.extend("
    ),
    why="a track whose playlist position is missing will abort that playlist",
)


PATCHES: tuple[SourcePatch, ...] = (_EMPTY_PLAYLIST_TRACK_GUARD,)


def apply_compat_patches() -> dict[str, str]:
    """Apply every guard. Safe to call repeatedly; call it after each upgrade."""
    results: dict[str, str] = {}
    for patch in PATCHES:
        outcome = patch.apply()
        results[patch.name] = outcome
        if outcome == "applied":
            log.info("applied the %s compatibility guard to gamdl", patch.name)
        elif outcome == "not-needed":
            log.debug("%s guard not needed — upstream code has changed", patch.name)
    return results
