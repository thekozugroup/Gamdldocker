"""Keeping gamdl and N_m3u8DL-RE current.

Apple changes its web player often enough that a pinned gamdl stops working
within weeks, so the container updates itself. The risk is obvious: an
auto-update that installs a broken release turns a working stack into a silent
outage. Every upgrade here is therefore verified before it is accepted, and
rolled back if it is not.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .gamdl_runner import gamdl_version, probe_capabilities

log = logging.getLogger(__name__)

__all__ = ["UpdateOutcome", "Updater"]

_NM3U8DLRE_RELEASES = "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest"
_HTTP_TIMEOUT = 30
_ARCH_PATTERNS = {
    "x86_64": re.compile(r"linux-x64.*\.tar\.gz$", re.IGNORECASE),
    "amd64": re.compile(r"linux-x64.*\.tar\.gz$", re.IGNORECASE),
    "aarch64": re.compile(r"linux-arm64.*\.tar\.gz$", re.IGNORECASE),
    "arm64": re.compile(r"linux-arm64.*\.tar\.gz$", re.IGNORECASE),
}


@dataclass
class UpdateOutcome:
    gamdl_before: str = ""
    gamdl_after: str = ""
    gamdl_rolled_back: bool = False
    nm3u8dlre_updated: bool = False
    errors: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []

    @property
    def gamdl_changed(self) -> bool:
        return bool(self.gamdl_after) and self.gamdl_after != self.gamdl_before


class Updater:
    """Runs at most once per ``interval`` seconds."""

    def __init__(
        self,
        *,
        nm3u8dlre_path: Path | str,
        state_path: Path | str,
        interval: int = 86400,
    ) -> None:
        self.nm3u8dlre_path = Path(nm3u8dlre_path)
        self.state_path = Path(state_path)
        self.interval = interval

    # ----------------------------------------------------------------- #
    # Scheduling
    # ----------------------------------------------------------------- #

    def _last_run(self) -> float:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            return float(data.get("lastRun", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            return 0.0

    def _record_run(self, outcome: UpdateOutcome) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps(
                    {
                        "lastRun": time.time(),
                        "gamdlVersion": outcome.gamdl_after or outcome.gamdl_before,
                        "rolledBack": outcome.gamdl_rolled_back,
                        "errors": outcome.errors,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError as exc:
            log.debug("could not record update state: %s", exc)

    def due(self) -> bool:
        return (time.time() - self._last_run()) >= self.interval

    # ----------------------------------------------------------------- #
    # Entry point
    # ----------------------------------------------------------------- #

    def run(self, *, update_gamdl: bool, update_nm3u8dlre: bool = True) -> UpdateOutcome:
        outcome = UpdateOutcome(gamdl_before=gamdl_version())
        log.info("checking for tool updates (current gamdl %s)", outcome.gamdl_before or "unknown")

        if update_gamdl:
            self._update_gamdl(outcome)
        else:
            outcome.gamdl_after = outcome.gamdl_before

        if update_nm3u8dlre:
            self._update_nm3u8dlre(outcome)

        self._record_run(outcome)
        if outcome.gamdl_changed:
            log.info("gamdl updated: %s -> %s", outcome.gamdl_before, outcome.gamdl_after)
        for error in outcome.errors:
            log.warning("update: %s", error)
        return outcome

    # ----------------------------------------------------------------- #
    # gamdl
    # ----------------------------------------------------------------- #

    def _pip(self, *args: str, timeout: int = 240) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--no-cache-dir",
                "--disable-pip-version-check",
                *args,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def _update_gamdl(self, outcome: UpdateOutcome) -> None:
        previous = outcome.gamdl_before
        try:
            result = self._pip("--upgrade", "gamdl")
        except subprocess.TimeoutExpired:
            outcome.errors.append("gamdl upgrade timed out; keeping the installed version")
            outcome.gamdl_after = previous
            return
        except (OSError, subprocess.SubprocessError) as exc:
            outcome.errors.append(f"gamdl upgrade could not run: {exc}")
            outcome.gamdl_after = previous
            return

        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
            outcome.errors.append("gamdl upgrade failed: " + " | ".join(tail))
            outcome.gamdl_after = previous
            return

        # Verify the new build before trusting it. A gamdl that cannot report its
        # own version or list its options will not download anything either.
        current = gamdl_version()
        caps = probe_capabilities()
        healthy = bool(current) and caps.has("--save-playlist")

        if healthy:
            outcome.gamdl_after = current
            return

        outcome.errors.append(
            f"gamdl {current or 'unknown'} failed its post-upgrade check; rolling back to {previous or 'previous'}"
        )
        if previous:
            rollback = self._pip(f"gamdl=={previous}", "--force-reinstall")
            outcome.gamdl_rolled_back = rollback.returncode == 0
            if not outcome.gamdl_rolled_back:
                outcome.errors.append("rollback failed — the container may need rebuilding")
        outcome.gamdl_after = gamdl_version() or previous

    # ----------------------------------------------------------------- #
    # N_m3u8DL-RE
    # ----------------------------------------------------------------- #

    def _update_nm3u8dlre(self, outcome: UpdateOutcome) -> None:
        url = self._latest_nm3u8dlre_url()
        if not url:
            return

        with tempfile.TemporaryDirectory(prefix="nm3u8dlre-") as tmpdir:
            tmp = Path(tmpdir)
            archive = tmp / "release.tar.gz"
            try:
                _download(url, archive)
                _safe_extract(archive, tmp)
            except (OSError, urllib.error.URLError, tarfile.TarError, ValueError) as exc:
                outcome.errors.append(f"N_m3u8DL-RE download failed: {exc}")
                return

            candidate = next((p for p in tmp.rglob("N_m3u8DL-RE") if p.is_file()), None)
            if candidate is None:
                outcome.errors.append("N_m3u8DL-RE not found inside the downloaded archive")
                return

            candidate.chmod(0o755)
            if not _binary_runs(candidate):
                outcome.errors.append(
                    "downloaded N_m3u8DL-RE did not run; keeping the existing binary"
                )
                return

            try:
                self.nm3u8dlre_path.parent.mkdir(parents=True, exist_ok=True)
                if self.nm3u8dlre_path.exists():
                    backup = self.nm3u8dlre_path.with_suffix(".bak")
                    shutil.copy2(self.nm3u8dlre_path, backup)
                # copy2 then replace: the source is on a different filesystem
                # (tmpfs) so os.replace across devices would fail.
                staged = self.nm3u8dlre_path.with_suffix(".new")
                shutil.copy2(candidate, staged)
                staged.chmod(0o755)
                staged.replace(self.nm3u8dlre_path)
                outcome.nm3u8dlre_updated = True
            except OSError as exc:
                outcome.errors.append(f"could not install N_m3u8DL-RE: {exc}")

    def _latest_nm3u8dlre_url(self) -> str:
        pattern = _ARCH_PATTERNS.get(os.uname().machine.lower())
        try:
            request = urllib.request.Request(
                _NM3U8DLRE_RELEASES,
                headers={"Accept": "application/vnd.github+json", "User-Agent": "gamdl-sync"},
            )
            with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            log.info("could not check N_m3u8DL-RE releases: %s", exc)
            return ""

        if pattern is None:
            # Installing a wrong-architecture binary over a working one is worse
            # than not updating: the replacement cannot execute at all.
            log.info(
                "no N_m3u8DL-RE build known for %s — keeping the installed binary",
                os.uname().machine,
            )
            return ""

        for asset in data.get("assets", []):
            url = asset.get("browser_download_url", "")
            if pattern.search(url):
                return url
        return ""


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "gamdl-sync"})
    with (
        urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response,
        destination.open("wb") as handle,
    ):
        shutil.copyfileobj(response, handle)


def _safe_extract(archive: Path, destination: Path) -> None:
    """Extract a tarball, refusing members that escape ``destination``.

    A release asset is not attacker-controlled in any realistic sense, but a
    path-traversal entry would write outside the temp directory as root, and the
    check costs nothing.
    """
    destination = destination.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = (destination / member.name).resolve()
            # startswith alone would accept /tmp/re-evil for a destination of
            # /tmp/re. relative_to enforces a real path boundary.
            if target != destination and destination not in target.parents:
                raise ValueError(f"refusing unsafe archive member: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"refusing link member in archive: {member.name}")
        # Python 3.12+ understands the filter argument; older runtimes ignore it.
        try:
            tar.extractall(destination, filter="data")  # type: ignore[call-arg]
        except TypeError:
            tar.extractall(destination)


def _binary_runs(path: Path) -> bool:
    for flag in ("--version", "--help"):
        try:
            result = subprocess.run(
                [str(path), flag], capture_output=True, text=True, timeout=30, check=False
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 or result.stdout or result.stderr:
            return True
    return False
