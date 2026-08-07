"""Runtime configuration.

Precedence is defaults < environment < ``/config/settings.json``. The JSON file
wins because it is what the web UI writes; a user who changes a setting in the UI
expects it to take effect even though compose also passes an environment
variable for it.

Settings are re-read at the top of every cycle, so edits apply without a
restart. Nothing here raises on bad input: an out-of-range number is clamped and
an unrecognised enum falls back to the default, both with a warning. A daemon
that refuses to start because someone typed ``"frequency": "soon"`` is worse than
one that logs the problem and keeps syncing.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from .state import atomic_write_json, read_json

log = logging.getLogger(__name__)

__all__ = ["SCHEMA_VERSION", "Settings", "load_settings", "migrate_settings_file"]

SCHEMA_VERSION = 2

MIN_FREQUENCY = 60
MIN_UPDATE_INTERVAL = 300

LYRICS_FORMATS = ("lrc", "srt", "ttml")
DOWNLOAD_MODES = ("nm3u8dlre", "ytdlp")
COVER_FORMATS = ("jpg", "png", "raw")

# What the UI calls "quality" mapped to gamdl's --song-codec-priority. Ordered
# lists, so a codec that needs a Widevine device file degrades to one that does
# not rather than failing the track outright.
SONG_CODEC_PRIORITIES: dict[str, str] = {
    "aac-legacy": "aac-web,aac",
    "aac": "aac,aac-web",
    "aac-he": "aac-he,aac-he-web,aac-web",
    "alac": "alac,aac,aac-web",
    "atmos": "atmos,alac,aac,aac-web",
}

# gamdl only ever produces m4a from Apple Music, so the old `fileFormat` and
# `quality` keys were describing something the downloader could not deliver.
# They are still read, translated, and then dropped.
_LEGACY_QUALITY_TO_CODEC = {
    "high": "aac-legacy",
    "standard": "aac-legacy",
    "low": "aac-he",
    "lossless": "alac",
    "hi-res": "alac",
    "hi-res-lossless": "alac",
    "atmos": "atmos",
}
_LEGACY_FORMAT_TO_CODEC = {"flac": "alac", "alac": "alac"}

DEPRECATED_KEYS = ("fileFormat", "quality", "savePlaylist", "outputStructure")


@dataclass(frozen=True)
class Settings:
    """The complete, validated runtime configuration."""

    # Scheduling
    frequency: int = 3600

    # Paths
    output_location: str = "/data/music"
    playlist_m3u_dir: str = "/data/music/playlists"
    temp_path: str = "/data/temp"
    cookies_path: str = "/config/cookies.txt"
    nm3u8dlre_path: str = "/usr/local/bin/N_m3u8DL-RE"
    ffmpeg_path: str = "ffmpeg"

    # gamdl output templates
    album_folder_template: str = "{album_artist}/{album}"
    compilation_folder_template: str = "Compilations/{album}"
    no_album_folder_template: str = "{artist}/Unknown Album"
    single_disc_file_template: str = "{track:02d} {title}"
    multi_disc_file_template: str = "{disc}-{track:02d} {title}"
    no_album_file_template: str = "{title}"

    # Media selection
    song_codec: str = "aac-legacy"
    download_mode: str = "nm3u8dlre"
    language: str = "en-US"
    truncate: int | None = None
    overwrite: bool = False

    # Extras
    download_lyrics: bool = True
    lyrics_format: str = "lrc"
    save_cover: bool = False
    cover_format: str = "jpg"
    cover_size: int = 1200

    # Behaviour
    safe_filenames: bool = False
    prune_playlist_entries: bool = True
    concurrency: int = 1

    # Self-update
    auto_update: bool = True
    auto_update_interval: int = 86400
    auto_update_gamdl: bool = True

    @property
    def song_codec_priority(self) -> str:
        return SONG_CODEC_PRIORITIES.get(self.song_codec, SONG_CODEC_PRIORITIES["aac-legacy"])

    def to_json(self) -> dict[str, Any]:
        """Serialise back to the camelCase shape the web UI reads and writes."""
        return {
            "schemaVersion": SCHEMA_VERSION,
            "frequency": self.frequency,
            "outputLocation": self.output_location,
            "playlistM3uDir": self.playlist_m3u_dir,
            "albumFolderTemplate": self.album_folder_template,
            "compilationFolderTemplate": self.compilation_folder_template,
            "noAlbumFolderTemplate": self.no_album_folder_template,
            "singleDiscFileTemplate": self.single_disc_file_template,
            "multiDiscFileTemplate": self.multi_disc_file_template,
            "noAlbumFileTemplate": self.no_album_file_template,
            "songCodec": self.song_codec,
            "downloadMode": self.download_mode,
            "language": self.language,
            "truncate": self.truncate,
            "overwrite": self.overwrite,
            "downloadLyrics": self.download_lyrics,
            "lyricsFormat": self.lyrics_format,
            "saveCover": self.save_cover,
            "coverFormat": self.cover_format,
            "coverSize": self.cover_size,
            "safeFilenames": self.safe_filenames,
            "prunePlaylistEntries": self.prune_playlist_entries,
            "concurrency": self.concurrency,
            "autoUpdate": self.auto_update,
            "autoUpdateInterval": self.auto_update_interval,
            "autoUpdateGamdl": self.auto_update_gamdl,
        }


# --------------------------------------------------------------------------- #
# Coercion helpers
# --------------------------------------------------------------------------- #


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _as_int(
    value: Any,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
    label: str = "",
) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        if value not in (None, ""):
            log.warning("%s: %r is not a number, using %s", label or "setting", value, default)
        return default
    if minimum is not None and parsed < minimum:
        log.warning("%s: %s is below the minimum %s, clamping", label or "setting", parsed, minimum)
        parsed = minimum
    if maximum is not None and parsed > maximum:
        parsed = maximum
    return parsed


def _as_choice(value: Any, choices: tuple[str, ...], default: str, *, label: str = "") -> str:
    text = str(value).strip().lower() if value is not None else ""
    if text in choices:
        return text
    if text:
        log.warning(
            "%s: %r is not one of %s, using %r",
            label or "setting",
            value,
            ", ".join(choices),
            default,
        )
    return default


def _as_path(value: Any, default: str) -> str:
    text = str(value).strip() if value is not None else ""
    return text.rstrip("/") or default


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #


def _from_env(base: Settings) -> Settings:
    """Overlay environment variables onto ``base``.

    Only variables that are actually set are consulted, so an unset variable
    never clobbers a default with an empty string.
    """
    env = os.environ

    def get(*names: str) -> str | None:
        for name in names:
            if env.get(name) not in (None, ""):
                return env[name]
        return None

    values: dict[str, Any] = {}

    if (raw := get("FREQUENCY")) is not None:
        values["frequency"] = _as_int(raw, base.frequency, minimum=MIN_FREQUENCY, label="FREQUENCY")
    if (raw := get("OUTPUT_DIR", "OUTPUT_LOCATION")) is not None:
        values["output_location"] = _as_path(raw, base.output_location)
    if (raw := get("PLAYLIST_M3U_DIR")) is not None:
        values["playlist_m3u_dir"] = _as_path(raw, base.playlist_m3u_dir)
    if (raw := get("TEMP_PATH")) is not None:
        values["temp_path"] = _as_path(raw, base.temp_path)
    if (raw := get("COOKIES_PATH")) is not None:
        values["cookies_path"] = str(raw).strip()
    if (raw := get("NM3U8DLRE_PATH")) is not None:
        values["nm3u8dlre_path"] = str(raw).strip()
    if (raw := get("FFMPEG_PATH")) is not None:
        values["ffmpeg_path"] = str(raw).strip()
    if (raw := get("DOWNLOAD_MODE")) is not None:
        values["download_mode"] = _as_choice(
            raw, DOWNLOAD_MODES, base.download_mode, label="DOWNLOAD_MODE"
        )
    if (raw := get("SONG_CODEC")) is not None:
        values["song_codec"] = _as_choice(
            raw, tuple(SONG_CODEC_PRIORITIES), base.song_codec, label="SONG_CODEC"
        )
    if (raw := get("LANGUAGE")) is not None:
        values["language"] = str(raw).strip()
    if (raw := get("SAFE_FILENAMES")) is not None:
        values["safe_filenames"] = _as_bool(raw, base.safe_filenames)
    if (raw := get("PRUNE_PLAYLIST_ENTRIES")) is not None:
        values["prune_playlist_entries"] = _as_bool(raw, base.prune_playlist_entries)
    if (raw := get("CONCURRENCY")) is not None:
        values["concurrency"] = _as_int(
            raw, base.concurrency, minimum=1, maximum=8, label="CONCURRENCY"
        )
    if (raw := get("AUTO_UPDATE")) is not None:
        values["auto_update"] = _as_bool(raw, base.auto_update)
    if (raw := get("AUTO_UPDATE_INTERVAL")) is not None:
        values["auto_update_interval"] = _as_int(
            raw,
            base.auto_update_interval,
            minimum=MIN_UPDATE_INTERVAL,
            label="AUTO_UPDATE_INTERVAL",
        )
    if (raw := get("AUTO_UPDATE_GAMDL")) is not None:
        values["auto_update_gamdl"] = _as_bool(raw, base.auto_update_gamdl)
    if (raw := get("DOWNLOAD_LYRICS")) is not None:
        values["download_lyrics"] = _as_bool(raw, base.download_lyrics)
    if (raw := get("LYRICS_FORMAT")) is not None:
        values["lyrics_format"] = _normalize_lyrics_format(raw, base.lyrics_format)
    if (raw := get("OVERWRITE")) is not None:
        values["overwrite"] = _as_bool(raw, base.overwrite)
    if (raw := get("OUTPUT_STRUCTURE")) is not None:
        values.update(_templates_from_output_structure(str(raw), base))

    return replace(base, **values)


def _normalize_lyrics_format(value: Any, default: str) -> str:
    """Accept the legacy ``txt`` value, which gamdl has no equivalent for."""
    text = str(value).strip().lower()
    if text == "txt":
        log.warning("lyricsFormat 'txt' is not supported by gamdl; using 'lrc'")
        return "lrc"
    return _as_choice(text, LYRICS_FORMATS, default, label="lyricsFormat")


def _templates_from_output_structure(structure: str, base: Settings) -> dict[str, str]:
    """Translate the old single ``outputStructure`` string into gamdl templates.

    The legacy value looked like ``{artist}/{album}/{title}``: everything before
    the last separator described folders, the remainder described the file.
    """
    parts = [p for p in structure.replace("\\", "/").split("/") if p.strip()]
    if len(parts) < 2:
        return {}
    folder = "/".join(parts[:-1]).replace("{artist}", "{album_artist}")
    file_part = parts[-1]
    single = file_part if "{track" in file_part else "{track:02d} " + file_part
    multi = single if "{disc}" in single else "{disc}-" + single.lstrip()
    return {
        "album_folder_template": folder,
        "single_disc_file_template": single,
        "multi_disc_file_template": multi,
        "no_album_file_template": file_part,
    }


def _from_json(base: Settings, data: dict[str, Any]) -> Settings:
    """Overlay a settings.json document onto ``base``."""
    values: dict[str, Any] = {}

    def has(key: str) -> bool:
        return key in data and data[key] not in (None, "")

    if has("frequency"):
        values["frequency"] = _as_int(
            data["frequency"], base.frequency, minimum=MIN_FREQUENCY, label="frequency"
        )
    if has("outputLocation"):
        values["output_location"] = _as_path(data["outputLocation"], base.output_location)

    output_location = values.get("output_location", base.output_location)
    if has("playlistM3uDir"):
        values["playlist_m3u_dir"] = _as_path(
            data["playlistM3uDir"], f"{output_location}/playlists"
        )
    elif "output_location" in values:
        # The playlist folder tracks the library root unless it was set apart.
        values["playlist_m3u_dir"] = f"{output_location}/playlists"

    for json_key, attr in (
        ("albumFolderTemplate", "album_folder_template"),
        ("compilationFolderTemplate", "compilation_folder_template"),
        ("noAlbumFolderTemplate", "no_album_folder_template"),
        ("singleDiscFileTemplate", "single_disc_file_template"),
        ("multiDiscFileTemplate", "multi_disc_file_template"),
        ("noAlbumFileTemplate", "no_album_file_template"),
        ("language", "language"),
    ):
        if has(json_key):
            values[attr] = str(data[json_key]).strip()

    if has("downloadMode"):
        values["download_mode"] = _as_choice(
            data["downloadMode"], DOWNLOAD_MODES, base.download_mode, label="downloadMode"
        )
    if has("coverFormat"):
        values["cover_format"] = _as_choice(
            data["coverFormat"], COVER_FORMATS, base.cover_format, label="coverFormat"
        )
    if has("lyricsFormat"):
        values["lyrics_format"] = _normalize_lyrics_format(data["lyricsFormat"], base.lyrics_format)
    if has("coverSize"):
        values["cover_size"] = _as_int(
            data["coverSize"], base.cover_size, minimum=64, maximum=10000, label="coverSize"
        )
    if has("truncate"):
        values["truncate"] = _as_int(
            data["truncate"], base.truncate or 0, minimum=20, maximum=255, label="truncate"
        )
    if has("concurrency"):
        values["concurrency"] = _as_int(
            data["concurrency"], base.concurrency, minimum=1, maximum=8, label="concurrency"
        )
    if has("autoUpdateInterval"):
        values["auto_update_interval"] = _as_int(
            data["autoUpdateInterval"],
            base.auto_update_interval,
            minimum=MIN_UPDATE_INTERVAL,
            label="autoUpdateInterval",
        )

    for json_key, attr in (
        ("downloadLyrics", "download_lyrics"),
        ("saveCover", "save_cover"),
        ("overwrite", "overwrite"),
        ("safeFilenames", "safe_filenames"),
        ("prunePlaylistEntries", "prune_playlist_entries"),
        ("autoUpdate", "auto_update"),
        ("autoUpdateGamdl", "auto_update_gamdl"),
    ):
        if json_key in data:
            values[attr] = _as_bool(data[json_key], getattr(base, attr))

    # Song codec: the modern key wins, then the two legacy spellings.
    codec = None
    if has("songCodec"):
        codec = _as_choice(
            data["songCodec"], tuple(SONG_CODEC_PRIORITIES), base.song_codec, label="songCodec"
        )
    elif has("quality"):
        codec = _LEGACY_QUALITY_TO_CODEC.get(str(data["quality"]).strip().lower())
    if codec is None and has("fileFormat"):
        codec = _LEGACY_FORMAT_TO_CODEC.get(str(data["fileFormat"]).strip().lower())
    if codec:
        values["song_codec"] = codec

    if has("outputStructure") and not any(
        k in data for k in ("albumFolderTemplate", "singleDiscFileTemplate")
    ):
        merged = replace(base, **values)
        values.update(_templates_from_output_structure(str(data["outputStructure"]), merged))

    return replace(base, **values)


def load_settings(settings_path: Path | str) -> Settings:
    """Build the effective configuration for this cycle."""
    settings = _from_env(Settings())
    data = read_json(settings_path, {})
    if isinstance(data, dict) and data:
        settings = _from_json(settings, data)
    # A playlist folder that was never set explicitly follows the library root.
    if not settings.playlist_m3u_dir:
        settings = replace(settings, playlist_m3u_dir=f"{settings.output_location}/playlists")
    return settings


def migrate_settings_file(settings_path: Path | str) -> bool:
    """Rewrite a v1 settings.json in the v2 shape. Returns True if it changed.

    Runs once at startup. Values are preserved through the same translation the
    loader uses, so nothing a user configured is silently lost — the keys just
    stop describing capabilities the downloader never had.
    """
    path = Path(settings_path)
    data = read_json(path, None)
    if not isinstance(data, dict):
        return False
    if data.get("schemaVersion") == SCHEMA_VERSION and not any(
        key in data for key in DEPRECATED_KEYS
    ):
        return False

    migrated = _from_json(_from_env(Settings()), data).to_json()
    # Keep any unrecognised keys; a future version may know what they mean.
    for key, value in data.items():
        if key not in migrated and key not in DEPRECATED_KEYS and key != "schemaVersion":
            migrated[key] = value

    atomic_write_json(path, migrated)
    log.info("migrated %s to schema v%s", path, SCHEMA_VERSION)
    return True
