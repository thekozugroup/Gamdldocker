"""Invoking gamdl.

Two things matter here. First, every argument is rebuilt from the current
:class:`~gamdl_sync.config.Settings` on every playlist, so a setting changed in
the web UI takes effect on the next playlist rather than the next container
restart. Second, we only pass flags this build of gamdl actually advertises —
gamdl renames and moves options between releases, and a stack that dies on
``no such option`` after an auto-update is not a stack anyone can leave running.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .naming import escape_for_gamdl_template

log = logging.getLogger(__name__)

__all__ = ["GamdlCapabilities", "GamdlResult", "build_args", "probe_capabilities", "run_gamdl"]


# gamdl's human-readable progress line. The structlog output uses key=value
# pairs instead, so both shapes are matched.
_TRACK_RE = re.compile(r"[Tt]rack\s+(\d+)\s*/\s*(\d+)")
_STRUCTLOG_TRACK_RE = re.compile(r"\bmedia_num=(\d+)\b.*?\bmedia_total=(\d+)\b")

#: Kill gamdl if it produces no output at all for this long. A real download
#: prints steadily; silence means a stalled connection or a wedged helper.
DEFAULT_IDLE_TIMEOUT = 900.0
#: A ceiling for one playlist, so a pathological run cannot occupy the loop
#: forever. Large playlists on slow links still fit comfortably.
DEFAULT_OVERALL_TIMEOUT = 6 * 3600.0


@dataclass(frozen=True)
class GamdlCapabilities:
    """Which options the installed gamdl understands."""

    flags: frozenset[str]
    version: str = ""

    def has(self, flag: str) -> bool:
        return flag in self.flags

    @classmethod
    def permissive(cls) -> GamdlCapabilities:
        """Used when probing fails — assume everything and let gamdl complain."""
        return cls(flags=frozenset(_ALL_KNOWN_FLAGS))


_ALL_KNOWN_FLAGS = {
    "--cookies-path",
    "--output-path",
    "--temp-path",
    "--download-mode",
    "--nm3u8dlre-path",
    "--ffmpeg-path",
    "--save-playlist",
    "--playlist-folder-template",
    "--playlist-file-template",
    "--album-folder-template",
    "--compilation-folder-template",
    "--no-album-folder-template",
    "--single-disc-file-template",
    "--multi-disc-file-template",
    "--no-album-file-template",
    "--song-codec-priority",
    "--synced-lyrics-format",
    "--no-synced-lyrics",
    "--save-cover",
    "--cover-format",
    "--cover-size",
    "--overwrite",
    "--truncate",
    "--language",
    "--log-level",
    "--no-exceptions",
    "--no-config-file",
}


def probe_capabilities(executable: str = "gamdl", timeout: float = 30.0) -> GamdlCapabilities:
    """Ask gamdl what it supports. Cached by the caller for the process lifetime."""
    resolved = shutil.which(executable)
    if not resolved:
        log.error("gamdl executable %r not found in PATH", executable)
        return GamdlCapabilities(flags=frozenset())

    flags: set[str] = set()
    try:
        proc = subprocess.run(
            [resolved, "--help"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        for match in re.finditer(r"(--[a-z0-9][a-z0-9-]*)", proc.stdout or ""):
            flags.add(match.group(1))
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("could not probe gamdl options (%s); assuming a full feature set", exc)
        return GamdlCapabilities.permissive()

    version = ""
    try:
        proc = subprocess.run(
            [resolved, "--version"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        version = (
            (proc.stdout or proc.stderr or "").strip().splitlines()[0]
            if proc.stdout or proc.stderr
            else ""
        )
    except (OSError, subprocess.SubprocessError, IndexError):
        version = ""

    if not flags:
        return GamdlCapabilities.permissive()
    log.info(
        "gamdl capabilities: %d options detected (%s)", len(flags), version or "unknown version"
    )
    return GamdlCapabilities(flags=frozenset(flags), version=version)


def build_args(
    settings: Settings,
    url: str,
    *,
    playlist_folder_template: str,
    playlist_file_template: str,
    caps: GamdlCapabilities,
) -> list[str]:
    """Assemble the full gamdl argv for one playlist.

    ``playlist_folder_template`` and ``playlist_file_template`` are literal names
    (already sanitised); they are brace-escaped here because gamdl renders
    templates through ``string.Formatter`` and a literal ``{`` would raise.
    """
    args: list[str] = []

    def add(flag: str, *values: str) -> None:
        if caps.has(flag):
            args.append(flag)
            args.extend(values)
        else:
            log.debug("skipping %s — not supported by this gamdl build", flag)

    def add_switch(flag: str, enabled: bool) -> None:
        if enabled and caps.has(flag):
            args.append(flag)

    # An unexpected ~/.gamdl/config.ini on a bind-mounted home would silently
    # override everything we pass, so opt out of it entirely.
    add_switch("--no-config-file", True)

    add("--cookies-path", settings.cookies_path)
    add("--output-path", settings.output_location)
    add("--temp-path", settings.temp_path)
    add("--download-mode", settings.download_mode)
    add("--nm3u8dlre-path", settings.nm3u8dlre_path)
    add("--ffmpeg-path", settings.ffmpeg_path)

    add_switch("--save-playlist", True)
    add("--playlist-folder-template", escape_for_gamdl_template(playlist_folder_template))
    add("--playlist-file-template", escape_for_gamdl_template(playlist_file_template))

    add("--album-folder-template", settings.album_folder_template)
    add("--compilation-folder-template", settings.compilation_folder_template)
    add("--no-album-folder-template", settings.no_album_folder_template)
    add("--single-disc-file-template", settings.single_disc_file_template)
    add("--multi-disc-file-template", settings.multi_disc_file_template)
    add("--no-album-file-template", settings.no_album_file_template)

    add("--song-codec-priority", settings.song_codec_priority)
    add("--language", settings.language)

    if settings.download_lyrics:
        add("--synced-lyrics-format", settings.lyrics_format)
    else:
        add_switch("--no-synced-lyrics", True)

    if settings.save_cover:
        add_switch("--save-cover", True)
        add("--cover-format", settings.cover_format)
        add("--cover-size", str(settings.cover_size))

    add_switch("--overwrite", settings.overwrite)
    if settings.truncate:
        add("--truncate", str(settings.truncate))

    add("--log-level", "INFO")
    add_switch("--no-exceptions", True)

    # Deliberately NOT passed: --database-path. Its flat filter short-circuits
    # media before gamdl's _initial_processing runs, and _initial_processing is
    # what writes the m3u lines — so a "already downloaded" track would silently
    # vanish from the playlist file.

    args.append(url)
    return args


@dataclass
class GamdlResult:
    returncode: int
    lines: list[str]
    track_total: int = 0
    track_current: int = 0

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run_gamdl(
    args: Iterable[str],
    *,
    executable: str = "gamdl",
    on_line: Callable[[str], None] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
    stop_event: threading.Event | None = None,
    env: dict[str, str] | None = None,
    max_retained_lines: int = 400,
    idle_timeout: float = DEFAULT_IDLE_TIMEOUT,
    overall_timeout: float = DEFAULT_OVERALL_TIMEOUT,
) -> GamdlResult:
    """Run gamdl, streaming its output.

    Output is streamed rather than buffered so the UI shows progress while a long
    playlist downloads. Only the tail is retained in memory — a 2,000-track
    playlist would otherwise accumulate megabytes of log lines per cycle.
    """
    resolved = shutil.which(executable) or executable
    argv = [resolved, *args]
    log.debug("running: %s", " ".join(argv))

    process_env = {**os.environ, **(env or {})}
    # gamdl uses rich/structlog; forcing plain output keeps the log file readable
    # and stops ANSI escapes from reaching the web UI's log view.
    process_env.setdefault("NO_COLOR", "1")
    process_env.setdefault("TERM", "dumb")
    process_env.setdefault("PYTHONUNBUFFERED", "1")
    process_env.setdefault("COLUMNS", "200")

    retained: list[str] = []
    current = total = 0

    try:
        proc = subprocess.Popen(
            argv,
            # gamdl prompts on stdin when something is missing — a absent
            # cookies file makes it ask for a new path and wait. With no stdin
            # it aborts immediately instead of hanging the cycle forever.
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            # Its own process group, so a stop signal reaches N_m3u8DL-RE and
            # ffmpeg too rather than orphaning them.
            start_new_session=True,
            env=process_env,
        )
    except (OSError, ValueError) as exc:
        log.error("failed to start gamdl: %s", exc)
        return GamdlResult(returncode=127, lines=[f"failed to start gamdl: {exc}"])

    # Reading gamdl's output blocks in readline, so a child that goes quiet —
    # a stalled TLS connection, a hung N_m3u8DL-RE — would never return and
    # nothing in the loop would notice, not even a stop signal. A watchdog
    # thread owns the two deadlines instead, because it can act while the reader
    # is blocked.
    last_output = [time.monotonic()]
    reason: list[str] = []
    watchdog_done = threading.Event()

    def watchdog() -> None:
        started = time.monotonic()
        while not watchdog_done.wait(1.0):
            now = time.monotonic()
            if stop_event is not None and stop_event.is_set():
                reason.append("stopped")
                _terminate(proc)
                return
            if idle_timeout and (now - last_output[0]) > idle_timeout:
                reason.append(f"no output for {int(now - last_output[0])}s")
                _terminate(proc)
                return
            if overall_timeout and (now - started) > overall_timeout:
                reason.append(f"exceeded the {int(overall_timeout)}s limit")
                _terminate(proc)
                return

    guard = threading.Thread(target=watchdog, name="gamdl-watchdog", daemon=True)
    guard.start()

    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            last_output[0] = time.monotonic()
            line = raw.rstrip("\n")
            if on_line:
                on_line(line)
            retained.append(line)
            if len(retained) > max_retained_lines:
                del retained[: len(retained) - max_retained_lines]

            match = _TRACK_RE.search(line) or _STRUCTLOG_TRACK_RE.search(line)
            if match:
                current, total = int(match.group(1)), int(match.group(2))
                if on_progress:
                    on_progress(current, total)
    finally:
        watchdog_done.set()
        guard.join(timeout=5)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _terminate(proc, force=True)
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()

    if reason:
        message = f"gamdl was stopped: {reason[0]}"
        log.warning("%s", message)
        retained.append(message)

    return GamdlResult(
        returncode=proc.returncode if proc.returncode is not None else 1,
        lines=retained,
        track_total=total,
        track_current=current,
    )


def _terminate(proc: subprocess.Popen, *, force: bool = False) -> None:
    """Signal the whole process group so helper binaries die with gamdl."""
    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (OSError, ProcessLookupError):
        with contextlib.suppress(OSError):
            proc.kill() if force else proc.terminate()


def gamdl_version(executable: str = "gamdl") -> str:
    """Installed gamdl version, or an empty string if it cannot be determined."""
    resolved = shutil.which(executable)
    if not resolved:
        return ""
    try:
        proc = subprocess.run(
            [resolved, "--version"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (proc.stdout or proc.stderr or "").strip()
    match = re.search(r"(\d+\.\d+(?:\.\d+)?)", text)
    return match.group(1) if match else text.splitlines()[0] if text else ""


def find_binary(name: str, fallback: str = "") -> str:
    return shutil.which(name) or fallback or name


def ensure_directories(*paths: Path | str) -> None:
    for path in paths:
        try:
            Path(path).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("could not create %s: %s", path, exc)
