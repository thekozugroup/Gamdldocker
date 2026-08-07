"""``gamdl-sync doctor`` — answer "why isn't it downloading?" without guesswork.

Most support questions for a stack like this come down to one of five things:
missing cookies, expired cookies, an unwritable volume, a missing helper binary,
or an empty playlist list. Each check names the exact fix rather than reporting
a symptom.
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .config import load_settings
from .gamdl_runner import gamdl_version, probe_capabilities
from .playlists import load_playlist_urls
from .state import read_heartbeat

if TYPE_CHECKING:  # pragma: no cover
    from .daemon import Paths

__all__ = ["run_doctor"]

OK, WARN, FAIL = "ok", "warn", "fail"


@dataclass
class Check:
    name: str
    status: str
    detail: str


def run_doctor(paths: Paths) -> int:
    settings = load_settings(paths.settings)
    checks: list[Check] = []

    version = gamdl_version()
    checks.append(
        Check(
            "gamdl",
            OK if version else FAIL,
            f"version {version}" if version else "not installed — rebuild the image",
        )
    )

    caps = probe_capabilities()
    checks.append(
        Check(
            "gamdl options",
            OK if caps.has("--save-playlist") else FAIL,
            f"{len(caps.flags)} options detected" if caps.flags else "could not run `gamdl --help`",
        )
    )

    nm3u8dlre = Path(settings.nm3u8dlre_path)
    if settings.download_mode == "nm3u8dlre":
        present = nm3u8dlre.is_file() and os.access(nm3u8dlre, os.X_OK)
        checks.append(
            Check(
                "N_m3u8DL-RE",
                OK if present else FAIL,
                str(nm3u8dlre)
                if present
                else f"not executable at {nm3u8dlre} — set DOWNLOAD_MODE=ytdlp or rebuild",
            )
        )
    checks.append(
        Check(
            "ffmpeg",
            OK if shutil.which(settings.ffmpeg_path) else FAIL,
            shutil.which(settings.ffmpeg_path) or "not found in PATH",
        )
    )

    checks.append(_check_cookies(Path(settings.cookies_path), paths))

    urls = load_playlist_urls(paths.playlists)
    checks.append(
        Check(
            "playlists",
            OK if urls else WARN,
            f"{len(urls)} configured" if urls else "none configured — add one in the web UI",
        )
    )

    for label, directory in (
        ("library", Path(settings.output_location)),
        ("playlist folder", Path(settings.playlist_m3u_dir)),
        ("temp folder", Path(settings.temp_path)),
        ("config", paths.config_dir),
    ):
        checks.append(_check_writable(label, directory))

    beat = read_heartbeat(paths.heartbeat)
    if beat:
        age = time.time() - float(beat.get("ts", 0))
        checks.append(
            Check(
                "daemon",
                OK if age < 120 else WARN,
                f"last heartbeat {int(age)}s ago (state: {beat.get('state', '?')})",
            )
        )

    width = max(len(c.name) for c in checks)
    symbols = {OK: "✓", WARN: "!", FAIL: "✗"}
    print()
    for check in checks:
        print(f" {symbols[check.status]}  {check.name.ljust(width)}   {check.detail}")
    print()

    failures = sum(1 for c in checks if c.status == FAIL)
    warnings = sum(1 for c in checks if c.status == WARN)
    if failures:
        print(f"{failures} problem(s) will stop downloads from working.")
        return 1
    if warnings:
        print(f"{warnings} thing(s) worth a look, but syncing should work.")
    else:
        print("Everything checks out.")
    return 0


def _check_cookies(primary: Path, paths: Paths) -> Check:
    candidates = [primary, paths.config_dir / "music.apple.com_cookies.txt"]
    found = next((p for p in candidates if p.is_file() and p.stat().st_size > 0), None)
    if found is None:
        return Check("cookies", FAIL, "no cookie file — upload cookies.txt in the web UI")

    try:
        text = found.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return Check("cookies", FAIL, f"{found} is unreadable: {exc}")

    if "apple.com" not in text:
        return Check("cookies", FAIL, f"{found.name} has no apple.com entries — wrong export?")

    soonest = _soonest_expiry(text)
    if soonest is None:
        return Check("cookies", OK, f"{found.name} looks valid")
    days = (soonest - time.time()) / 86400
    if days < 0:
        return Check(
            "cookies", FAIL, f"{found.name} expired {abs(int(days))} day(s) ago — re-export it"
        )
    if days < 7:
        return Check("cookies", WARN, f"{found.name} expires in {int(days)} day(s)")
    return Check("cookies", OK, f"{found.name} valid for another {int(days)} day(s)")


def _soonest_expiry(netscape_text: str) -> float | None:
    """Earliest non-session expiry in a Netscape cookie jar."""
    soonest: float | None = None
    for line in netscape_text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 7:
            continue
        try:
            expiry = float(fields[4])
        except ValueError:
            continue
        if expiry <= 0:  # session cookie
            continue
        soonest = expiry if soonest is None else min(soonest, expiry)
    return soonest


def _check_writable(label: str, directory: Path) -> Check:
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return Check(label, FAIL, f"cannot create {directory}: {exc}")
    probe = directory / f".write-test-{os.getpid()}"
    try:
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return Check(
            label,
            FAIL,
            f"{directory} is not writable ({exc}) — check volume permissions or set PUID/PGID",
        )
    return Check(label, OK, str(directory))
