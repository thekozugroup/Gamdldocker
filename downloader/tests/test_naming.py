"""Naming tests.

Every case from the original ``tests/test_sanitize.bats`` is preserved here, plus
the adversarial Unicode cases that the bash implementation could not express.
Where behaviour deliberately changed from the bats suite it is called out in a
comment and recorded in docs/MIGRATION.md.
"""

from __future__ import annotations

import pytest

from gamdl_sync.naming import (
    escape_for_gamdl_template,
    playlist_short_id,
    playlist_slug_from_url,
    predict_gamdl_name,
    resolve_playlist_name,
    resolve_playlist_title,
    sanitize_filename,
    uniquify,
)

URL = "https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr"


# --------------------------------------------------------------------------- #
# sanitize_filename — ported from test_sanitize.bats
# --------------------------------------------------------------------------- #


def test_maps_unsafe_chars_to_fullwidth_lookalikes():
    assert sanitize_filename('a\\b/c:d*e?f"g<h>i|j', "fallback") == "a＼b／c：d＊e？f＂g＜h＞i｜j"


def test_maps_semicolon_too():
    # New in v2: gamdl rewrites ';' to '_', so we map it before gamdl sees it.
    assert sanitize_filename("rock;roll", "fb") == "rock；roll"


def test_strips_ascii_control_chars():
    assert sanitize_filename("hello\x01\x07world", "fallback") == "helloworld"


def test_trims_trailing_dots_and_spaces():
    assert sanitize_filename("My Playlist...   ", "fallback") == "My Playlist"


def test_collapses_internal_whitespace():
    assert sanitize_filename("  too    many   spaces  ", "fallback") == "too many spaces"


def test_empty_input_returns_fallback():
    assert sanitize_filename("", "abc123") == "abc123"


def test_input_that_becomes_empty_returns_fallback():
    assert sanitize_filename("\x01\x02\x03", "fb6chr") == "fb6chr"


def test_preserves_emoji():
    assert sanitize_filename("🪨 roll", "fb") == "🪨 roll"


def test_preserves_non_ascii_letters_and_symbols():
    assert sanitize_filename("¯\\_(ツ)_/¯", "fb") == "¯＼_(ツ)_／¯"


def test_preserves_plus():
    # gamdl's illegal set does not include '+', and neither does ours.
    assert sanitize_filename("🪨+roll", "fb") == "🪨+roll"


def test_safe_mode_preserves_plus_but_strips_emoji():
    assert sanitize_filename("🪨+roll", "fb", safe=True) == "+roll"


def test_safe_mode_shrug_falls_back_to_short_id():
    assert sanitize_filename("¯\\_(ツ)_/¯", "short", safe=True) == "short"


def test_safe_mode_keeps_real_short_names():
    assert sanitize_filename("Mix", "short", safe=True) == "Mix"


def test_safe_mode_keeps_ascii_text_intact():
    assert sanitize_filename("Plain Mix", "fb", safe=True) == "Plain Mix"


def test_safe_mode_folds_accents_instead_of_deleting_them():
    # Behaviour change from bats: the old implementation produced "roll caf"
    # because it dropped the accented codepoint entirely. NFKD keeps the letter.
    assert sanitize_filename("🪨 roll café", "fb", safe=True) == "roll cafe"


# --------------------------------------------------------------------------- #
# sanitize_filename — adversarial Unicode
# --------------------------------------------------------------------------- #


def test_strips_bidi_control_characters():
    # U+202E would visually reverse everything after it in a file listing.
    assert sanitize_filename("safe‮exe.txt", "fb") == "safeexe.txt"


def test_normalizes_to_nfc():
    decomposed = "café"  # 'e' + combining acute
    assert sanitize_filename(decomposed, "fb") == "café"


def test_preserves_zwj_emoji_sequence():
    family = "👨‍👩‍👧"
    assert sanitize_filename(family, "fb") == family


def test_preserves_skin_tone_modifier():
    assert sanitize_filename("👍🏽 mix", "fb") == "👍🏽 mix"


def test_preserves_flag_sequence():
    assert sanitize_filename("🇯🇵 city pop", "fb") == "🇯🇵 city pop"


def test_preserves_rtl_text():
    arabic = "موسيقى"
    assert sanitize_filename(arabic, "fb") == arabic


def test_truncates_on_byte_boundary_not_codepoint():
    name = "🎵" * 100  # 4 bytes each
    result = sanitize_filename(name, "fb", max_bytes=50)
    assert len(result.encode("utf-8")) <= 50
    assert result == "🎵" * 12  # 48 bytes; a 13th would overflow


def test_truncation_does_not_split_a_grapheme_cluster():
    # Two family emoji; the cluster is 18 bytes, so a 20-byte cap fits exactly one.
    name = "👨‍👩‍👧👨‍👩‍👧"
    result = sanitize_filename(name, "fb", max_bytes=20)
    assert result == "👨‍👩‍👧"


def test_truncation_does_not_leave_a_trailing_dot():
    assert not sanitize_filename("abcdefghij." + "x" * 50, "fb", max_bytes=11).endswith(".")


def test_only_emoji_name_survives_default_mode():
    assert sanitize_filename("💍", "fb") == "💍"


# --------------------------------------------------------------------------- #
# gamdl interop
# --------------------------------------------------------------------------- #


def test_escapes_braces_for_gamdl_template():
    # gamdl renders templates through string.Formatter; a bare '{' raises there.
    assert escape_for_gamdl_template("{Best} of 2024") == "{{Best}} of 2024"


def test_escaped_template_round_trips_through_string_formatter():
    import string

    name = "{brace} ; test"
    rendered = string.Formatter().vformat(escape_for_gamdl_template(name), (), {})
    assert rendered == name


def test_predict_gamdl_name_matches_gamdl_sanitizer():
    assert predict_gamdl_name('a\\b/c:d*e?f"g<h>i|j;k') == "a_b_c_d_e_f_g_h_i_j_k"


def test_predict_gamdl_name_leaves_fullwidth_lookalikes_alone():
    # This is the whole point of mapping to lookalikes: gamdl has nothing to eat.
    sanitized = sanitize_filename('Rock/Roll: "Best"?', "fb")
    assert predict_gamdl_name(sanitized) == sanitized


# --------------------------------------------------------------------------- #
# short id / slug
# --------------------------------------------------------------------------- #


def test_short_id_takes_last_six_chars():
    assert playlist_short_id(URL) == "ALAyAr"


def test_short_id_falls_back_to_a_hash():
    result = playlist_short_id("https://example.com/nothing")
    assert len(result) == 6 and result.isalnum()


def test_slug_dehyphenates_ascii_slugs():
    assert (
        playlist_slug_from_url(
            "https://music.apple.com/us/playlist/my-summer-mix/pl.u-AAAAAA111111"
        )
        == "my summer mix"
    )


def test_slug_strips_leading_m_prefix():
    assert (
        playlist_slug_from_url("https://music.apple.com/us/playlist/m-chill/pl.u-AAAAAA111111")
        == "chill"
    )


def test_slug_preserves_percent_encoded_unicode():
    assert (
        playlist_slug_from_url(
            "https://music.apple.com/us/playlist/%F0%9F%AA%A8%2Broll/pl.u-AAAAAA111111"
        )
        == "🪨+roll"
    )


def test_slug_of_a_non_playlist_url_is_generic():
    assert playlist_slug_from_url("https://example.com/") == "playlist"


# --------------------------------------------------------------------------- #
# resolve_playlist_name — precedence
# --------------------------------------------------------------------------- #


def test_resolve_uses_override_when_present():
    name, source = resolve_playlist_name(
        "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111",
        overrides={"https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "Bops"},
    )
    assert (name, source) == ("Bops", "override")


def test_resolve_override_beats_cache():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, source = resolve_playlist_name(
        url, overrides={url: "Override Wins"}, name_cache={url: {"name": "Cache Loses"}}
    )
    assert (name, source) == ("Override Wins", "override")


def test_resolve_falls_through_to_cache():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, source = resolve_playlist_name(url, name_cache={url: {"name": "From Cache"}})
    assert (name, source) == ("From Cache", "cache")


def test_resolve_cache_beats_url_slug():
    # The real bug this precedence exists for: the slug would mangle '+'.
    url = "https://music.apple.com/us/playlist/rocknroll/pl.u-PLUSAAA111111"
    name, source = resolve_playlist_name(url, name_cache={url: {"name": "🪨+roll"}})
    assert (name, source) == ("🪨+roll", "cache")


def test_resolve_accepts_legacy_string_cache_entries():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, source = resolve_playlist_name(url, name_cache={url: "Legacy Shape"})
    assert (name, source) == ("Legacy Shape", "cache")


def test_resolve_falls_back_to_slug():
    name, source = resolve_playlist_name(
        "https://music.apple.com/us/playlist/my-summer-mix/pl.u-AAAAAA111111"
    )
    assert (name, source) == ("my summer mix", "slug")


def test_resolve_sanitizes_the_override():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, _ = resolve_playlist_name(url, overrides={url: "Bad/Name:Here..."})
    assert name == "Bad／Name：Here"


def test_resolve_preserves_emoji_override():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, _ = resolve_playlist_name(url, overrides={url: "💍"})
    assert name == "💍"


def test_resolve_ignores_blank_override():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    name, source = resolve_playlist_name(
        url, overrides={url: "   "}, name_cache={url: {"name": "From Cache"}}
    )
    assert (name, source) == ("From Cache", "cache")


# --------------------------------------------------------------------------- #
# uniquify
# --------------------------------------------------------------------------- #


def test_uniquify_no_collision_returns_input():
    seen: set[str] = set()
    assert uniquify("Jams", URL, seen) == "Jams"


def test_uniquify_appends_short_id_on_collision():
    assert uniquify("jams", URL, {"jams"}) == "jams (ALAyAr)"


def test_uniquify_is_case_insensitive():
    assert uniquify("Jams", URL, {"jams"}) == "Jams (ALAyAr)"


def test_uniquify_records_the_final_name():
    seen: set[str] = set()
    uniquify("Jams", URL, seen)
    assert "jams" in seen


def test_uniquify_handles_unicode_case_folding():
    # casefold(), not lower(): 'ß' and 'SS' are the same filename on macOS.
    # Callers seed `seen` with casefolded names, which is what makes this work.
    seen = {"straße".casefold()}
    assert uniquify("STRASSE", URL, seen) == "STRASSE (ALAyAr)"


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [("Jams", "jams", "jams (ALAyAr)"), ("Mix", "Mix", "Mix (ALAyAr)")],
)
def test_uniquify_two_playlist_flow(first, second, expected):
    seen: set[str] = set()
    uniquify(first, "https://music.apple.com/us/playlist/jams/pl.u-AAAAAAAAAAAA", seen)
    assert uniquify(second, URL, seen) == expected


def test_short_id_of_a_catalog_playlist_uses_six_chars():
    # Catalog ids have no hyphen; a backtracking regex used to capture just "6".
    assert (
        playlist_short_id("https://music.apple.com/us/playlist/todays-hits/pl.abc123def456")
        == "def456"
    )


def test_short_id_is_stable_for_the_same_playlist_across_storefronts():
    us = playlist_short_id("https://music.apple.com/us/playlist/a/pl.u-ABCDEFGH")
    gb = playlist_short_id("https://music.apple.com/gb/playlist/other/pl.u-ABCDEFGH")
    assert us == gb


def test_short_ids_differ_between_catalog_playlists():
    first = playlist_short_id("https://music.apple.com/us/playlist/a/pl.1111aaaa2222")
    second = playlist_short_id("https://music.apple.com/us/playlist/b/pl.3333bbbb4444")
    assert first != second


# --------------------------------------------------------------------------- #
# gamdl's --truncate changes where it writes
# --------------------------------------------------------------------------- #


def test_predict_gamdl_name_models_truncate():
    # gamdl keeps truncate - len(extension) characters of the stem. Predicting
    # the full-length name meant we looked in the wrong place and reported
    # "gamdl produced no playlist file" for every name over the limit.
    name = "A" * 46
    assert predict_gamdl_name(name, truncate=20) == "A" * 16


def test_predict_gamdl_name_without_truncate_is_unchanged():
    name = "A" * 46
    assert predict_gamdl_name(name) == name


def test_predict_gamdl_name_truncate_still_replaces_illegal_chars():
    assert predict_gamdl_name("ab/cd:ef", truncate=10) == "ab_cd_"


# --------------------------------------------------------------------------- #
# The #PLAYLIST tag carries the real title, not the filename
# --------------------------------------------------------------------------- #


def test_title_prefers_the_override_verbatim():
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    assert resolve_playlist_title(url, overrides={url: "Rock; Roll"}) == "Rock; Roll"


def test_title_is_not_sanitized():
    # The filename must lose the semicolon; the title must not.
    url = "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111"
    cache = {url: {"name": 'Best of / 2024: "Live"'}}
    filename, _ = resolve_playlist_name(url, name_cache=cache)
    title = resolve_playlist_title(url, name_cache=cache)
    assert title == 'Best of / 2024: "Live"'
    assert filename == "Best of ／ 2024： ＂Live＂"


def test_title_falls_back_to_the_slug():
    assert (
        resolve_playlist_title("https://music.apple.com/us/playlist/my-mix/pl.u-AAAAAA111111")
        == "my mix"
    )
