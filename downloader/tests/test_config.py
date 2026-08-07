"""Configuration tests.

Two properties matter most: a settings.json written by v1 must keep working, and
no input may crash the loader. Every branch of the coercion helpers is exercised
with hostile values.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gamdl_sync.config import (
    SCHEMA_VERSION,
    SONG_CODEC_PRIORITIES,
    Settings,
    load_settings,
    migrate_settings_file,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch):
    for name in list(__import__("os").environ):
        if name in {
            "FREQUENCY",
            "OUTPUT_DIR",
            "OUTPUT_LOCATION",
            "PLAYLIST_M3U_DIR",
            "TEMP_PATH",
            "COOKIES_PATH",
            "NM3U8DLRE_PATH",
            "FFMPEG_PATH",
            "DOWNLOAD_MODE",
            "SONG_CODEC",
            "LANGUAGE",
            "SAFE_FILENAMES",
            "PRUNE_PLAYLIST_ENTRIES",
            "CONCURRENCY",
            "AUTO_UPDATE",
            "AUTO_UPDATE_INTERVAL",
            "AUTO_UPDATE_GAMDL",
            "DOWNLOAD_LYRICS",
            "LYRICS_FORMAT",
            "OVERWRITE",
            "OUTPUT_STRUCTURE",
        }:
            monkeypatch.delenv(name, raising=False)


def write(path: Path, data: dict) -> Path:
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# Defaults and precedence
# --------------------------------------------------------------------------- #


def test_defaults_when_no_file_exists(tmp_path: Path):
    settings = load_settings(tmp_path / "missing.json")
    assert settings.frequency == 3600
    assert settings.output_location == "/data/music"
    assert settings.download_mode == "nm3u8dlre"


def test_env_overrides_defaults(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FREQUENCY", "1800")
    monkeypatch.setenv("OUTPUT_DIR", "/mnt/library/")
    settings = load_settings(tmp_path / "missing.json")
    assert settings.frequency == 1800
    assert settings.output_location == "/mnt/library"


def test_settings_file_overrides_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # The UI writes settings.json, so a UI change must win over a compose value.
    monkeypatch.setenv("FREQUENCY", "1800")
    path = write(tmp_path / "settings.json", {"frequency": 7200})
    assert load_settings(path).frequency == 7200


def test_playlist_dir_follows_the_library_root(tmp_path: Path):
    path = write(tmp_path / "s.json", {"outputLocation": "/mnt/music"})
    assert load_settings(path).playlist_m3u_dir == "/mnt/music/playlists"


def test_explicit_playlist_dir_is_respected(tmp_path: Path):
    path = write(
        tmp_path / "s.json",
        {"outputLocation": "/mnt/music", "playlistM3uDir": "/mnt/lists"},
    )
    assert load_settings(path).playlist_m3u_dir == "/mnt/lists"


# --------------------------------------------------------------------------- #
# Hostile input
# --------------------------------------------------------------------------- #


def test_corrupt_json_falls_back_to_defaults(tmp_path: Path):
    path = tmp_path / "s.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_settings(path).frequency == 3600


def test_frequency_below_the_floor_is_clamped(tmp_path: Path):
    path = write(tmp_path / "s.json", {"frequency": 5})
    assert load_settings(path).frequency == 60


def test_non_numeric_frequency_falls_back(tmp_path: Path):
    path = write(tmp_path / "s.json", {"frequency": "soon"})
    assert load_settings(path).frequency == 3600


def test_unknown_download_mode_falls_back(tmp_path: Path):
    path = write(tmp_path / "s.json", {"downloadMode": "bittorrent"})
    assert load_settings(path).download_mode == "nm3u8dlre"


def test_legacy_txt_lyrics_format_becomes_lrc(tmp_path: Path):
    # gamdl has no txt synced-lyrics format; the old UI offered it anyway.
    path = write(tmp_path / "s.json", {"lyricsFormat": "txt"})
    assert load_settings(path).lyrics_format == "lrc"


def test_string_booleans_are_understood(tmp_path: Path):
    path = write(tmp_path / "s.json", {"autoUpdate": "false", "overwrite": "yes"})
    settings = load_settings(path)
    assert settings.auto_update is False
    assert settings.overwrite is True


def test_concurrency_is_bounded(tmp_path: Path):
    assert load_settings(write(tmp_path / "a.json", {"concurrency": 99})).concurrency == 8
    assert load_settings(write(tmp_path / "b.json", {"concurrency": 0})).concurrency == 1


def test_a_json_array_instead_of_an_object_is_ignored(tmp_path: Path):
    path = tmp_path / "s.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    assert load_settings(path).frequency == 3600


# --------------------------------------------------------------------------- #
# v1 compatibility
# --------------------------------------------------------------------------- #


V1_SETTINGS = {
    "frequency": 3600,
    "outputLocation": "/data/music",
    "playlistM3uDir": "/data/music/playlists",
    "outputStructure": "{artist}/{album}/{title}",
    "fileFormat": "m4a",
    "downloadLyrics": True,
    "lyricsFormat": "lrc",
    "quality": "high",
    "savePlaylist": True,
    "overwrite": False,
    "downloadMode": "nm3u8dlre",
    "autoUpdate": True,
    "autoUpdateInterval": 86400,
}


def test_v1_settings_file_loads(tmp_path: Path):
    settings = load_settings(write(tmp_path / "s.json", V1_SETTINGS))
    assert settings.frequency == 3600
    assert settings.download_mode == "nm3u8dlre"
    assert settings.download_lyrics is True


def test_legacy_quality_maps_to_a_codec(tmp_path: Path):
    assert load_settings(write(tmp_path / "a.json", {"quality": "high"})).song_codec == "aac-legacy"
    assert load_settings(write(tmp_path / "b.json", {"quality": "lossless"})).song_codec == "alac"


def test_legacy_flac_file_format_maps_to_alac(tmp_path: Path):
    # Apple Music never yields FLAC; ALAC is the lossless intent behind it.
    assert load_settings(write(tmp_path / "s.json", {"fileFormat": "flac"})).song_codec == "alac"


def test_legacy_output_structure_becomes_gamdl_templates(tmp_path: Path):
    settings = load_settings(
        write(tmp_path / "s.json", {"outputStructure": "{artist}/{album}/{title}"})
    )
    assert settings.album_folder_template == "{album_artist}/{album}"
    assert settings.single_disc_file_template == "{track:02d} {title}"
    assert "{disc}" in settings.multi_disc_file_template


def test_explicit_templates_beat_legacy_output_structure(tmp_path: Path):
    settings = load_settings(
        write(
            tmp_path / "s.json",
            {"outputStructure": "{artist}/{title}", "albumFolderTemplate": "{album}"},
        )
    )
    assert settings.album_folder_template == "{album}"


# --------------------------------------------------------------------------- #
# Migration
# --------------------------------------------------------------------------- #


def test_migration_rewrites_a_v1_file(tmp_path: Path):
    path = write(tmp_path / "s.json", V1_SETTINGS)
    assert migrate_settings_file(path) is True
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["schemaVersion"] == SCHEMA_VERSION
    assert "fileFormat" not in data
    assert "quality" not in data
    assert data["songCodec"] == "aac-legacy"


def test_migration_is_idempotent(tmp_path: Path):
    path = write(tmp_path / "s.json", V1_SETTINGS)
    migrate_settings_file(path)
    assert migrate_settings_file(path) is False


def test_migration_keeps_unrecognised_keys(tmp_path: Path):
    path = write(tmp_path / "s.json", {**V1_SETTINGS, "futureKey": "keep me"})
    migrate_settings_file(path)
    assert json.loads(path.read_text(encoding="utf-8"))["futureKey"] == "keep me"


def test_migration_on_a_missing_file_is_a_noop(tmp_path: Path):
    assert migrate_settings_file(tmp_path / "nope.json") is False


# --------------------------------------------------------------------------- #
# Derived values
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("codec", sorted(SONG_CODEC_PRIORITIES))
def test_every_codec_choice_yields_a_priority_list(codec: str):
    assert Settings(song_codec=codec).song_codec_priority


def test_unknown_codec_falls_back_to_the_default_priority():
    assert (
        Settings(song_codec="nonsense").song_codec_priority == SONG_CODEC_PRIORITIES["aac-legacy"]
    )


def test_to_json_round_trips(tmp_path: Path):
    original = Settings(frequency=900, song_codec="alac", safe_filenames=True)
    path = tmp_path / "s.json"
    path.write_text(json.dumps(original.to_json()), encoding="utf-8")
    reloaded = load_settings(path)
    assert reloaded.frequency == 900
    assert reloaded.song_codec == "alac"
    assert reloaded.safe_filenames is True


# --------------------------------------------------------------------------- #
# Migration must not freeze the environment into the file
# --------------------------------------------------------------------------- #


def test_migration_does_not_bake_env_values_into_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # settings.json outranks the environment at load time, so writing env values
    # here would silently kill every documented .env knob from upgrade day on.
    monkeypatch.setenv("FREQUENCY", "900")
    monkeypatch.setenv("SAFE_FILENAMES", "true")
    path = write(tmp_path / "s.json", V1_SETTINGS)
    migrate_settings_file(path)

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["frequency"] == 3600  # the v1 file's own value, not the env's
    assert "safeFilenames" not in data  # never set by the user, so never written


def test_env_still_applies_after_migration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = write(tmp_path / "s.json", V1_SETTINGS)
    migrate_settings_file(path)
    monkeypatch.setenv("SAFE_FILENAMES", "true")
    monkeypatch.setenv("DOWNLOAD_MODE", "ytdlp")
    settings = load_settings(path)
    assert settings.safe_filenames is True
    assert settings.download_mode == "nm3u8dlre"  # the file set this one, so it wins


def test_migration_writes_only_what_the_v1_file_carried(tmp_path: Path):
    path = write(tmp_path / "s.json", {"frequency": 1800, "quality": "lossless"})
    migrate_settings_file(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["frequency"] == 1800
    assert data["songCodec"] == "alac"  # translated from the deprecated key
    assert "coverSize" not in data  # a default the user never expressed
    assert "quality" not in data


def test_migrated_deprecated_keys_still_translate(tmp_path: Path):
    path = write(tmp_path / "s.json", {"outputStructure": "{artist}/{album}/{title}"})
    migrate_settings_file(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["albumFolderTemplate"] == "{album_artist}/{album}"
    assert data["singleDiscFileTemplate"] == "{track:02d} {title}"
