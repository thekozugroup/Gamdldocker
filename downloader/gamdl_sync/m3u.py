"""Playlist file generation.

gamdl writes an ``.m3u`` containing nothing but bare relative paths, one per
line, indexed by the track's position in the playlist. That has three problems
for a tool that syncs on a schedule:

* it *updates* the existing file in place and never truncates it, so when a
  playlist shrinks upstream the removed tracks linger forever;
* a track that failed or was skipped leaves a blank line behind;
* there is no ``#EXTM3U`` header and no ``#EXTINF`` metadata, so players show
  filenames instead of song titles.

So the daemon deletes the file before each run (forcing a clean regeneration)
and then repairs what gamdl produced. The result is a real UTF-8 ``.m3u8`` that
reflects the playlist as it exists right now.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

__all__ = ["PlaylistEntry", "RepairResult", "read_entries", "render_m3u8", "repair_playlist"]


@dataclass
class PlaylistEntry:
    """One track line, plus whatever we could learn about it."""

    relative_path: str
    absolute_path: Path
    exists: bool
    duration: int = -1
    title: str = ""
    artist: str = ""

    @property
    def display(self) -> str:
        if self.artist and self.title:
            return f"{self.artist} - {self.title}"
        return self.title or self.absolute_path.stem


@dataclass
class RepairResult:
    entries: list[PlaylistEntry]
    total: int
    available: int
    missing: int
    text: str


def read_entries(playlist_path: Path, base_dir: Path | None = None) -> list[str]:
    """Return the raw track lines of an m3u/m3u8, ignoring blanks and comments.

    ``base_dir`` is unused here but kept in the signature because callers read
    better when the resolution root is explicit at the call site.
    """
    try:
        text = playlist_path.read_text(encoding="utf-8", errors="replace")
    except (OSError, FileNotFoundError):
        return []
    # A BOM would otherwise become part of the first path.
    text = text.lstrip("﻿")
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            out.append(stripped)
    return out


def _resolve(raw_line: str, m3u_dir: Path, output_root: Path) -> Path:
    """Resolve a playlist line to an absolute path.

    gamdl emits paths relative to the m3u's own directory. We fall back to the
    library root because a file hand-edited by the user, or produced by an older
    version of this project, may be relative to that instead.
    """
    candidate = Path(raw_line)
    if candidate.is_absolute():
        return candidate
    from_m3u = (m3u_dir / candidate).resolve(strict=False)
    if from_m3u.exists():
        return from_m3u
    from_root = (output_root / candidate).resolve(strict=False)
    if from_root.exists():
        return from_root
    return from_m3u


def _relative_to(target: Path, start: Path) -> str:
    """Path of ``target`` as seen from ``start``, using forward slashes.

    ``os.path.relpath`` handles the ``../`` climbing correctly for any depth,
    which is what the previous implementation got wrong: it rewrote every
    ``../../`` prefix to ``../`` unconditionally, breaking playlists whose media
    sat more than one level below the library root.
    """
    return Path(os.path.relpath(target, start)).as_posix()


def _read_tags(path: Path) -> tuple[int, str, str]:
    """Best-effort (duration, title, artist) from an audio file.

    mutagen ships with gamdl, so this costs no extra dependency. Any failure
    yields a duration of -1, which is the m3u convention for "unknown".
    """
    try:
        from mutagen import File as MutagenFile  # type: ignore[import-untyped]
    except ImportError:
        return -1, "", ""
    try:
        audio = MutagenFile(str(path), easy=True)
    except Exception:
        return -1, "", ""
    if audio is None:
        return -1, "", ""
    duration = -1
    try:
        if audio.info is not None and getattr(audio.info, "length", None):
            duration = round(audio.info.length)
    except Exception:
        duration = -1

    def first(key: str) -> str:
        try:
            value = audio.get(key)
        except Exception:
            return ""
        if isinstance(value, list) and value:
            return str(value[0])
        return str(value) if value else ""

    return duration, first("title"), first("artist")


def repair_playlist(
    source: Path,
    *,
    m3u_dir: Path,
    output_root: Path,
    title: str,
    prune_missing: bool = True,
    read_tags: bool = True,
    source_dir: Path | None = None,
) -> RepairResult:
    """Turn gamdl's raw output into a well-formed, current ``.m3u8``.

    Order is preserved (it is the playlist's order), duplicates are dropped, and
    entries whose media is not on disk are either removed or counted, depending
    on ``prune_missing``.

    ``source_dir`` is where gamdl wrote ``source``, which is a staging directory
    rather than ``m3u_dir``; its lines are relative to that. The rewritten lines
    are always relative to ``m3u_dir``, where the file is about to be published.
    """
    raw_lines = read_entries(source, m3u_dir)
    resolve_base = source_dir if source_dir is not None else source.parent

    entries: list[PlaylistEntry] = []
    seen: set[str] = set()
    for raw in raw_lines:
        absolute = _resolve(raw, resolve_base, output_root)
        key = str(absolute)
        if key in seen:
            continue
        seen.add(key)
        exists = absolute.exists()
        duration, tag_title, tag_artist = (-1, "", "")
        if exists and read_tags:
            duration, tag_title, tag_artist = _read_tags(absolute)
        entries.append(
            PlaylistEntry(
                relative_path=_relative_to(absolute, m3u_dir),
                absolute_path=absolute,
                exists=exists,
                duration=duration,
                title=tag_title,
                artist=tag_artist,
            )
        )

    total = len(entries)
    missing = sum(1 for entry in entries if not entry.exists)
    if prune_missing:
        entries = [entry for entry in entries if entry.exists]
    available = sum(1 for entry in entries if entry.exists)

    return RepairResult(
        entries=entries,
        total=total,
        available=available,
        missing=missing,
        text=render_m3u8(entries, title),
    )


# M3U is line-oriented, so a newline inside a title or a tag value would end the
# directive early and turn the rest of the value into a bogus entry. Tag data
# comes from files on disk that this project did not write, so it is not
# trustworthy input.
_LINE_BREAK_RE = re.compile(r"[\r\n\u2028\u2029]+")


def _one_line(value: str) -> str:
    """Flatten anything that would break out of a single m3u directive."""
    return _LINE_BREAK_RE.sub(" ", value).strip()


def render_m3u8(entries: list[PlaylistEntry], title: str) -> str:
    """Render entries as extended M3U.

    ``#PLAYLIST`` carries the true title — emoji and all — so a player shows the
    playlist's real name even when the filename had to be sanitised.
    """
    lines = ["#EXTM3U"]
    clean_title = _one_line(title)
    if clean_title:
        lines.append(f"#PLAYLIST:{clean_title}")
    for entry in entries:
        lines.append(f"#EXTINF:{entry.duration},{_one_line(entry.display)}")
        # A path cannot contain a newline on any filesystem we support, so this
        # is belt-and-braces rather than a real vector.
        lines.append(_one_line(entry.relative_path))
    return "\n".join(lines) + "\n"
