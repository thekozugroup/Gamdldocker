"""gamdl argv-building tests.

The v1 bug this suite exists to prevent: seven settings the UI exposed were never
passed to gamdl, so toggling them in the web UI did nothing at all. Every setting
below is asserted to reach the command line.
"""

from __future__ import annotations

import string

import pytest

from gamdl_sync.config import Settings
from gamdl_sync.gamdl_runner import GamdlCapabilities, build_args

URL = "https://music.apple.com/us/playlist/jams/pl.u-ABC"


def args_for(
    settings: Settings | None = None,
    *,
    name: str = "Jams",
    folder: str = "playlists",
    caps: GamdlCapabilities | None = None,
) -> list[str]:
    return build_args(
        settings or Settings(),
        URL,
        playlist_folder_template=folder,
        playlist_file_template=name,
        caps=caps or GamdlCapabilities.permissive(),
    )


def value_after(args: list[str], flag: str) -> str:
    return args[args.index(flag) + 1]


# --------------------------------------------------------------------------- #
# Every setting reaches gamdl
# --------------------------------------------------------------------------- #


def test_url_is_the_last_argument():
    assert args_for()[-1] == URL


def test_core_paths_are_passed():
    args = args_for(
        Settings(output_location="/mnt/music", temp_path="/tmp/x", cookies_path="/config/c.txt")
    )
    assert value_after(args, "--output-path") == "/mnt/music"
    assert value_after(args, "--temp-path") == "/tmp/x"
    assert value_after(args, "--cookies-path") == "/config/c.txt"


def test_download_mode_is_passed():
    assert value_after(args_for(Settings(download_mode="ytdlp")), "--download-mode") == "ytdlp"


def test_song_codec_becomes_a_priority_list():
    assert value_after(args_for(Settings(song_codec="alac")), "--song-codec-priority") == (
        "alac,aac,aac-web"
    )


def test_language_is_passed():
    assert value_after(args_for(Settings(language="ja-JP")), "--language") == "ja-JP"


def test_folder_and_file_templates_are_passed():
    args = args_for(
        Settings(
            album_folder_template="{album}",
            single_disc_file_template="{title}",
            multi_disc_file_template="{disc} {title}",
        )
    )
    assert value_after(args, "--album-folder-template") == "{album}"
    assert value_after(args, "--single-disc-file-template") == "{title}"
    assert value_after(args, "--multi-disc-file-template") == "{disc} {title}"


def test_lyrics_enabled_passes_the_format():
    args = args_for(Settings(download_lyrics=True, lyrics_format="ttml"))
    assert value_after(args, "--synced-lyrics-format") == "ttml"
    assert "--no-synced-lyrics" not in args


def test_lyrics_disabled_passes_the_switch():
    args = args_for(Settings(download_lyrics=False))
    assert "--no-synced-lyrics" in args
    assert "--synced-lyrics-format" not in args


def test_cover_options_only_appear_when_enabled():
    assert "--save-cover" not in args_for(Settings(save_cover=False))
    args = args_for(Settings(save_cover=True, cover_format="png", cover_size=3000))
    assert "--save-cover" in args
    assert value_after(args, "--cover-format") == "png"
    assert value_after(args, "--cover-size") == "3000"


def test_overwrite_is_a_switch():
    assert "--overwrite" not in args_for(Settings(overwrite=False))
    assert "--overwrite" in args_for(Settings(overwrite=True))


def test_truncate_is_omitted_when_unset():
    assert "--truncate" not in args_for(Settings(truncate=None))
    assert value_after(args_for(Settings(truncate=120)), "--truncate") == "120"


def test_save_playlist_is_always_on():
    assert "--save-playlist" in args_for()


def test_config_file_is_disabled():
    # A stray ~/.gamdl/config.ini would otherwise override everything we pass.
    assert "--no-config-file" in args_for()


def test_database_path_is_never_passed():
    # Its flat filter skips media before gamdl writes the m3u line, which would
    # silently drop already-downloaded tracks from the playlist file.
    assert "--database-path" not in args_for()


# --------------------------------------------------------------------------- #
# Template escaping
# --------------------------------------------------------------------------- #


def test_playlist_name_with_braces_is_escaped():
    args = args_for(name="{Best} of 2024")
    assert value_after(args, "--playlist-file-template") == "{{Best}} of 2024"


def test_escaped_template_renders_back_to_the_original():
    name = "🪨+roll {2024}"
    rendered = string.Formatter().vformat(
        value_after(args_for(name=name), "--playlist-file-template"), (), {}
    )
    assert rendered == name


def test_emoji_names_pass_through_unchanged():
    assert value_after(args_for(name="🪨+roll"), "--playlist-file-template") == "🪨+roll"


def test_folder_template_is_escaped_too():
    assert value_after(args_for(folder="my {lists}"), "--playlist-folder-template") == (
        "my {{lists}}"
    )


# --------------------------------------------------------------------------- #
# Capability gating
# --------------------------------------------------------------------------- #


def test_unsupported_flags_are_dropped():
    caps = GamdlCapabilities(
        flags=frozenset({"--cookies-path", "--output-path", "--save-playlist"})
    )
    args = args_for(caps=caps)
    assert "--song-codec-priority" not in args
    assert "--cookies-path" in args
    assert args[-1] == URL


def test_a_build_with_no_known_flags_still_passes_the_url():
    args = args_for(caps=GamdlCapabilities(flags=frozenset()))
    assert args == [URL]


def test_value_flags_do_not_leave_an_orphan_value_when_dropped():
    caps = GamdlCapabilities(flags=frozenset({"--save-playlist"}))
    args = args_for(caps=caps)
    assert args == ["--save-playlist", URL]


@pytest.mark.parametrize("flag", ["--output-path", "--download-mode", "--song-codec-priority"])
def test_permissive_capabilities_include_the_common_flags(flag: str):
    assert GamdlCapabilities.permissive().has(flag)
