"""Playlist-list tests.

The old duplicate check was ``content.includes(url)``, which meant a URL that was
a prefix of another was treated as already present. Identity here is the ``pl.*``
id, because Apple serves the same playlist under every storefront with an
arbitrary slug.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from gamdl_sync.playlists import (
    canonical_key,
    is_playlist_url,
    load_playlist_urls,
    normalize_url,
    write_playlist_urls,
)

BASE = "https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr"


# --------------------------------------------------------------------------- #
# normalize_url
# --------------------------------------------------------------------------- #


def test_normalize_drops_query_and_fragment():
    assert normalize_url(f"{BASE}?i=12345&l=en#top") == BASE


def test_normalize_drops_a_trailing_slash():
    assert normalize_url(BASE + "/") == BASE


def test_normalize_lowercases_the_host_only():
    assert normalize_url("https://Music.Apple.COM/us/playlist/Jams/pl.u-ABC") == (
        "https://music.apple.com/us/playlist/Jams/pl.u-ABC"
    )


def test_normalize_strips_www():
    assert normalize_url("https://www.music.apple.com/us/playlist/a/pl.u-A").startswith(
        "https://music.apple.com/"
    )


def test_normalize_adds_a_scheme():
    assert normalize_url("music.apple.com/us/playlist/a/pl.u-A") == (
        "https://music.apple.com/us/playlist/a/pl.u-A"
    )


def test_normalize_of_empty_input_is_empty():
    assert normalize_url("   ") == ""


# --------------------------------------------------------------------------- #
# canonical_key
# --------------------------------------------------------------------------- #


def test_same_playlist_across_storefronts_shares_a_key():
    us = "https://music.apple.com/us/playlist/jams/pl.u-ABCDEF"
    gb = "https://music.apple.com/gb/playlist/different-slug/pl.u-ABCDEF"
    assert canonical_key(us) == canonical_key(gb)


def test_different_playlists_have_different_keys():
    assert canonical_key(BASE) != canonical_key(
        "https://music.apple.com/us/playlist/jams/pl.u-OTHERID"
    )


def test_a_prefix_url_is_not_the_same_playlist():
    # The old String.includes() check treated these as duplicates.
    short = "https://music.apple.com/us/playlist/a/pl.u-ABC"
    longer = "https://music.apple.com/us/playlist/a/pl.u-ABCDEF"
    assert canonical_key(short) != canonical_key(longer)


def test_key_is_case_sensitive_for_the_playlist_id():
    # Apple ids are case-sensitive; folding them would merge distinct playlists.
    assert canonical_key("https://music.apple.com/us/playlist/a/pl.u-AbC") != canonical_key(
        "https://music.apple.com/us/playlist/a/pl.u-abc"
    )


# --------------------------------------------------------------------------- #
# is_playlist_url
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "url",
    [
        BASE,
        "https://music.apple.com/gb/playlist/x/pl.u-ABC?i=1",
        "music.apple.com/us/playlist/x/pl.pm-ABC",
        "https://beta.music.apple.com/us/playlist/x/pl.u-ABC",
    ],
)
def test_accepts_playlist_urls(url: str):
    assert is_playlist_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://music.apple.com/us/album/x/1234567",
        "https://music.apple.com/us/artist/x/1234567",
        "https://open.spotify.com/playlist/abc",
        "https://music.apple.com/us/playlist/x",  # no pl.* id
        "not a url",
        "",
    ],
)
def test_rejects_everything_else(url: str):
    assert not is_playlist_url(url)


# --------------------------------------------------------------------------- #
# load / write
# --------------------------------------------------------------------------- #


def test_load_skips_comments_and_blanks(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    path.write_text(f"# header\n\n{BASE}\n  \n# another\n", encoding="utf-8")
    assert load_playlist_urls(path) == [BASE]


def test_load_deduplicates_by_canonical_key(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    path.write_text(
        "https://music.apple.com/us/playlist/a/pl.u-ABC\n"
        "https://music.apple.com/gb/playlist/b/pl.u-ABC\n",
        encoding="utf-8",
    )
    assert len(load_playlist_urls(path)) == 1


def test_load_preserves_order(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    urls = [f"https://music.apple.com/us/playlist/p/pl.u-{i}" for i in range(5)]
    path.write_text("\n".join(urls), encoding="utf-8")
    assert load_playlist_urls(path) == urls


def test_load_of_a_missing_file_is_empty(tmp_path: Path):
    assert load_playlist_urls(tmp_path / "nope.txt") == []


def test_write_preserves_the_comment_header(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    path.write_text("# Apple Music Playlist URLs\n# One per line\n\nold\n", encoding="utf-8")
    write_playlist_urls(path, [BASE])
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# Apple Music Playlist URLs\n# One per line\n")
    assert BASE in text
    assert "old" not in text


def test_write_creates_the_file_when_absent(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    write_playlist_urls(path, [BASE])
    assert path.read_text(encoding="utf-8").strip() == BASE


def test_write_ends_with_exactly_one_newline(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    write_playlist_urls(path, [BASE])
    assert path.read_text(encoding="utf-8").endswith(BASE + "\n")


def test_write_then_load_round_trips(tmp_path: Path):
    path = tmp_path / "playlists.txt"
    urls = [BASE, "https://music.apple.com/us/playlist/b/pl.u-BBBBBB"]
    write_playlist_urls(path, urls)
    assert load_playlist_urls(path) == urls
