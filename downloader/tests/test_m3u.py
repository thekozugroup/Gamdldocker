"""Playlist file repair tests.

The behaviours worth protecting: a shrunken playlist actually shrinks, a failed
track does not leave a blank line, relative paths survive at any nesting depth,
and the title in ``#PLAYLIST`` keeps its emoji even when the filename could not.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from gamdl_sync.m3u import PlaylistEntry, read_entries, render_m3u8, repair_playlist


@pytest.fixture
def library(tmp_path: Path) -> Path:
    root = tmp_path / "music"
    (root / "playlists").mkdir(parents=True)
    return root


def _track(library: Path, relative: str) -> Path:
    path = library / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00")
    return path


def _repair(library: Path, raw: str, **kwargs):
    source = library / "playlists" / "raw.m3u"
    source.write_text(raw, encoding="utf-8")
    return repair_playlist(
        source,
        m3u_dir=library / "playlists",
        output_root=library,
        title=kwargs.pop("title", "Test"),
        read_tags=kwargs.pop("read_tags", False),
        **kwargs,
    )


# --------------------------------------------------------------------------- #
# read_entries
# --------------------------------------------------------------------------- #


def test_read_entries_skips_comments_and_blanks(tmp_path: Path):
    path = tmp_path / "a.m3u8"
    path.write_text("#EXTM3U\n\nfoo.m4a\n\n#EXTINF:1,x\nbar.m4a\n", encoding="utf-8")
    assert read_entries(path) == ["foo.m4a", "bar.m4a"]


def test_read_entries_strips_a_bom(tmp_path: Path):
    path = tmp_path / "a.m3u8"
    path.write_bytes("﻿#EXTM3U\nfoo.m4a\n".encode())
    assert read_entries(path) == ["foo.m4a"]


def test_read_entries_on_a_missing_file_is_empty(tmp_path: Path):
    assert read_entries(tmp_path / "nope.m3u8") == []


# --------------------------------------------------------------------------- #
# repair_playlist
# --------------------------------------------------------------------------- #


def test_drops_blank_lines_from_failed_tracks(library: Path):
    _track(library, "A/Album/01 One.m4a")
    _track(library, "A/Album/03 Three.m4a")
    # gamdl leaves an empty line where track 2 failed.
    result = _repair(library, "../A/Album/01 One.m4a\n\n../A/Album/03 Three.m4a\n")
    assert [e.relative_path for e in result.entries] == [
        "../A/Album/01 One.m4a",
        "../A/Album/03 Three.m4a",
    ]


def test_prunes_entries_whose_media_is_gone(library: Path):
    _track(library, "A/Album/01 One.m4a")
    result = _repair(library, "../A/Album/01 One.m4a\n../A/Album/02 Missing.m4a\n")
    assert result.total == 2
    assert result.available == 1
    assert result.missing == 1
    assert len(result.entries) == 1


def test_keeps_missing_entries_when_pruning_is_off(library: Path):
    _track(library, "A/Album/01 One.m4a")
    result = _repair(
        library, "../A/Album/01 One.m4a\n../A/Album/02 Missing.m4a\n", prune_missing=False
    )
    assert len(result.entries) == 2
    assert result.missing == 1


def test_deduplicates_while_preserving_order(library: Path):
    _track(library, "A/1.m4a")
    _track(library, "A/2.m4a")
    result = _repair(library, "../A/1.m4a\n../A/2.m4a\n../A/1.m4a\n")
    assert [e.relative_path for e in result.entries] == ["../A/1.m4a", "../A/2.m4a"]


def test_preserves_deep_relative_paths(library: Path):
    # The old shell implementation rewrote every '../../' to '../',
    # which silently broke every playlist nested more than one level deep.
    _track(library, "Artist/Album/Disc 1/01 Song.m4a")
    result = _repair(library, "../Artist/Album/Disc 1/01 Song.m4a\n")
    assert result.entries[0].relative_path == "../Artist/Album/Disc 1/01 Song.m4a"


def test_rewrites_absolute_paths_as_relative(library: Path):
    track = _track(library, "Artist/Album/01 Song.m4a")
    result = _repair(library, f"{track}\n")
    assert result.entries[0].relative_path == "../Artist/Album/01 Song.m4a"


def test_accepts_paths_relative_to_the_library_root(library: Path):
    # Files written by an older version of this project were root-relative.
    _track(library, "Artist/Album/01 Song.m4a")
    result = _repair(library, "Artist/Album/01 Song.m4a\n")
    assert result.entries[0].relative_path == "../Artist/Album/01 Song.m4a"


def test_handles_unicode_paths(library: Path):
    _track(library, "🪨 Artist/Álbum/01 Söng ；.m4a")
    result = _repair(library, "../🪨 Artist/Álbum/01 Söng ；.m4a\n")
    assert result.available == 1
    assert "🪨" in result.text


def test_empty_source_produces_a_valid_header_only_playlist(library: Path):
    result = _repair(library, "", title="Empty")
    assert result.text == "#EXTM3U\n#PLAYLIST:Empty\n"
    assert result.total == 0


def test_a_shrunken_playlist_does_not_keep_stale_entries(library: Path):
    # Regenerating from a two-line source must not resurrect a third track that
    # a previous cycle had written.
    _track(library, "A/1.m4a")
    _track(library, "A/2.m4a")
    _track(library, "A/3.m4a")
    first = _repair(library, "../A/1.m4a\n../A/2.m4a\n../A/3.m4a\n")
    assert first.total == 3
    second = _repair(library, "../A/1.m4a\n../A/2.m4a\n")
    assert second.total == 2
    assert "3.m4a" not in second.text


# --------------------------------------------------------------------------- #
# render_m3u8
# --------------------------------------------------------------------------- #


def test_render_includes_extm3u_and_playlist_title():
    text = render_m3u8([], "🪨+roll")
    assert text.startswith("#EXTM3U\n")
    assert "#PLAYLIST:🪨+roll" in text


def test_render_emits_extinf_per_entry(tmp_path: Path):
    entry = PlaylistEntry(
        relative_path="../A/1.m4a",
        absolute_path=tmp_path / "A" / "1.m4a",
        exists=True,
        duration=214,
        title="Song",
        artist="Artist",
    )
    text = render_m3u8([entry], "Mix")
    assert "#EXTINF:214,Artist - Song" in text
    assert text.endswith("../A/1.m4a\n")


def test_render_falls_back_to_the_filename_when_tags_are_missing(tmp_path: Path):
    entry = PlaylistEntry(
        relative_path="../A/1.m4a", absolute_path=tmp_path / "A" / "1.m4a", exists=True
    )
    assert "#EXTINF:-1,1" in render_m3u8([entry], "Mix")


def test_render_uses_lf_endings_only():
    entry = PlaylistEntry(relative_path="a.m4a", absolute_path=Path("a.m4a"), exists=True)
    assert "\r" not in render_m3u8([entry], "Mix")
