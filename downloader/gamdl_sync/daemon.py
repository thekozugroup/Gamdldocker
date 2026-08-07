"""The sync loop.

Everything the daemon does for one playlist happens in :meth:`Daemon.sync_one`,
and everything it does over time happens in :meth:`Daemon.run`. The loop is
deliberately boring: read settings, read playlists, sync each one, publish
status, sleep in interruptible slices while watching for control commands.

Design commitments worth stating out loud:

* No single playlist can kill the loop. Every failure is caught, recorded on the
  playlist, and stepped over.
* A stop signal is honoured within a second, not at the end of an hour-long
  sleep.
* We compute where gamdl will write instead of searching for whatever changed
  recently, so two playlists syncing concurrently cannot claim each other's file.
"""

from __future__ import annotations

import contextlib
import logging
import shutil
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .config import Settings, load_settings, migrate_settings_file
from .control import CANCEL, RELOAD, SYNC_NOW, ControlChannel
from .gamdl_runner import GamdlCapabilities, build_args, probe_capabilities, run_gamdl
from .m3u import repair_playlist
from .migrations import run_migrations
from .naming import (
    predict_gamdl_name,
    resolve_playlist_name,
    uniquify,
)
from .playlists import load_playlist_urls
from .state import (
    NameCache,
    StatusStore,
    atomic_write_text,
    read_json,
    write_heartbeat,
)

log = logging.getLogger(__name__)

__all__ = ["Daemon", "Paths"]

HEARTBEAT_INTERVAL = 15.0
CONTROL_POLL_INTERVAL = 1.0
EMPTY_RETRY_SECONDS = 60


@dataclass(frozen=True)
class Paths:
    """Every path the daemon touches, resolved once."""

    config_dir: Path = Path("/config")

    @property
    def settings(self) -> Path:
        return self.config_dir / "settings.json"

    @property
    def playlists(self) -> Path:
        return self.config_dir / "playlists.txt"

    @property
    def status(self) -> Path:
        return self.config_dir / "playlist-status.json"

    @property
    def name_cache(self) -> Path:
        return self.config_dir / "playlist-name-cache.json"

    @property
    def overrides(self) -> Path:
        return self.config_dir / "playlist-overrides.json"

    @property
    def control(self) -> Path:
        return self.config_dir / "control"

    @property
    def heartbeat(self) -> Path:
        return self.config_dir / ".downloader-heartbeat"

    @property
    def update_state(self) -> Path:
        return self.config_dir / ".update-state.json"

    @property
    def migrations(self) -> Path:
        return self.config_dir / ".migrations.json"

    @property
    def logs(self) -> Path:
        return self.config_dir / "logs"


@dataclass
class SyncOutcome:
    status: str
    name: str
    playlist_file: str = ""
    total: int = 0
    available: int = 0
    missing: int = 0
    error: str = ""


class Daemon:
    def __init__(self, paths: Paths | None = None) -> None:
        self.paths = paths or Paths()
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.cancel_event = threading.Event()
        self.status = StatusStore(self.paths.status)
        self.names = NameCache(self.paths.name_cache)
        self.control = ControlChannel(self.paths.control)
        self.caps: GamdlCapabilities = GamdlCapabilities.permissive()
        self.cycle = 0
        self._scoped_urls: list[str] = []
        self._last_heartbeat = 0.0
        self._state = "starting"
        self._detail = ""
        self._seen_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def install_signal_handlers(self) -> None:
        def handle(signum: int, _frame: object) -> None:
            log.info(
                "received %s — shutting down after the current step", signal.Signals(signum).name
            )
            self.stop_event.set()
            self.cancel_event.set()
            self.wake_event.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            # Not the main thread (tests); the caller handles shutdown there.
            with contextlib.suppress(ValueError, OSError):
                signal.signal(sig, handle)

    def _heartbeat_loop(self) -> None:
        """Publish liveness on a fixed cadence, independent of the sync loop.

        Tying the heartbeat to the loop's own progress meant an hour-long
        download, or a slow update check on a blocked network, looked identical
        to a wedged process.
        """
        while not self.stop_event.wait(HEARTBEAT_INTERVAL):
            write_heartbeat(
                self.paths.heartbeat,
                state=self._state,
                cycle=self.cycle,
                detail=self._detail,
            )

    def run(self) -> int:
        self.install_signal_handlers()
        self.control.ensure()
        self._beat("starting", force=True)
        heartbeat = threading.Thread(target=self._heartbeat_loop, name="heartbeat", daemon=True)
        heartbeat.start()
        run_migrations(self.paths)
        migrate_settings_file(self.paths.settings)

        self.caps = probe_capabilities()
        if not self.caps.flags:
            log.error("gamdl is not installed or not runnable — cannot sync")
            return 1

        while not self.stop_event.is_set():
            self.cycle += 1
            settings = load_settings(self.paths.settings)
            self._beat("starting-cycle", force=True)

            try:
                self._maybe_update(settings)
            except Exception as exc:
                log.warning("update check failed: %s", exc)

            urls = load_playlist_urls(self.paths.playlists)
            if self._scoped_urls:
                scoped = [u for u in urls if u in self._scoped_urls]
                if scoped:
                    urls = scoped
                self._scoped_urls = []

            if not urls:
                log.info("no playlists configured; waiting %ss", EMPTY_RETRY_SECONDS)
                self._beat("idle-no-playlists")
                self._sleep(EMPTY_RETRY_SECONDS)
                continue

            self.cancel_event.clear()
            self._run_cycle(settings, urls)

            if self.stop_event.is_set():
                break

            log.info("cycle complete; next check in %ss", settings.frequency)
            self._beat("sleeping")
            self._sleep(settings.frequency)

        self._beat("stopped", force=True)
        log.info("downloader stopped cleanly")
        return 0

    # ------------------------------------------------------------------ #
    # A cycle
    # ------------------------------------------------------------------ #

    def _run_cycle(self, settings: Settings, urls: list[str]) -> None:
        started = time.monotonic()
        m3u_dir = Path(settings.playlist_m3u_dir)
        m3u_dir.mkdir(parents=True, exist_ok=True)
        Path(settings.output_location).mkdir(parents=True, exist_ok=True)
        Path(settings.temp_path).mkdir(parents=True, exist_ok=True)

        self.status.reset_to_idle(urls)
        self.names.prune(urls)

        overrides = self._read_overrides()
        name_cache = self.names.read()

        # Seed the collision tracker from what is already on disk so a playlist
        # keeps the same suffix across restarts instead of flapping.
        seen: set[str] = {path.stem.casefold() for path in m3u_dir.glob("*.m3u*") if path.is_file()}

        plan: list[tuple[str, str]] = []
        for url in urls:
            resolved, source = resolve_playlist_name(
                url, overrides=overrides, name_cache=name_cache, safe=settings.safe_filenames
            )
            with self._seen_lock:
                # Its own current filename must not count as a collision.
                seen.discard(resolved.casefold())
                unique = uniquify(resolved, url, seen)
            plan.append((url, unique))
            log.debug("resolved %s -> %r (via %s)", url, unique, source)

        if settings.concurrency > 1 and len(plan) > 1:
            log.info("syncing %d playlists (%d at a time)", len(plan), settings.concurrency)
            with ThreadPoolExecutor(max_workers=settings.concurrency) as pool:
                list(pool.map(lambda item: self._sync_guarded(settings, *item), plan))
        else:
            for url, name in plan:
                if self.stop_event.is_set() or self.cancel_event.is_set():
                    break
                self._sync_guarded(settings, url, name)

        self._sweep_orphans(settings, [name for _, name in plan])
        log.info("cycle %d finished in %.1fs", self.cycle, time.monotonic() - started)

    def _sync_guarded(self, settings: Settings, url: str, name: str) -> None:
        if self.stop_event.is_set() or self.cancel_event.is_set():
            return
        started = time.monotonic()
        self.status.mark_running(url, name=name)
        self._beat("syncing", detail=name)
        try:
            outcome = self.sync_one(settings, url, name)
        except Exception as exc:
            log.exception("unhandled error syncing %s", url)
            outcome = SyncOutcome(status="failed", name=name, error=f"{type(exc).__name__}: {exc}")

        self.status.mark_finished(
            url,
            outcome.status,
            name=outcome.name,
            playlist_file=outcome.playlist_file or None,
            song_count=outcome.total,
            available_count=outcome.available,
            missing_count=outcome.missing,
            duration_seconds=time.monotonic() - started,
            error=outcome.error,
        )
        if outcome.name:
            self.names.set_name(url, outcome.name)

    # ------------------------------------------------------------------ #
    # One playlist
    # ------------------------------------------------------------------ #

    def sync_one(self, settings: Settings, url: str, name: str) -> SyncOutcome:
        output_root = Path(settings.output_location)
        m3u_dir = Path(settings.playlist_m3u_dir)

        # gamdl builds the playlist path as <output>/<folder template>/<file
        # template>.m3u, so the folder template is the m3u directory expressed
        # relative to the library root.
        try:
            folder_template = m3u_dir.relative_to(output_root).as_posix()
        except ValueError:
            # The playlist directory lives outside the library. gamdl can only
            # write beneath its output path, so let it write into a staging
            # folder and move the result afterwards.
            folder_template = ".gamdl-playlists"

        # gamdl replaces its own illegal characters, so the file it writes may
        # not be the name we asked for. Compute both.
        gamdl_stem = predict_gamdl_name(name)
        gamdl_output = output_root / folder_template / f"{gamdl_stem}.m3u"
        target = m3u_dir / f"{name}.m3u8"

        # Regenerate from scratch: gamdl only overwrites the lines it touches and
        # never truncates, so a stale file would keep tracks that are no longer
        # in the playlist.
        for stale in (gamdl_output, gamdl_output.with_suffix(".m3u8")):
            stale.unlink(missing_ok=True)

        args = build_args(
            settings,
            url,
            playlist_folder_template=folder_template,
            playlist_file_template=name,
            caps=self.caps,
        )
        result = run_gamdl(
            args,
            on_line=lambda line: log.info("gamdl | %s", line),
            on_progress=lambda current, total: self.status.set_progress(url, current, total),
            stop_event=self.stop_event,
        )

        produced = _first_existing(
            gamdl_output,
            gamdl_output.with_suffix(".m3u8"),
            output_root / folder_template / f"{name}.m3u",
        )

        if produced is None:
            # No playlist file this cycle. Keep whatever is already published so
            # the library does not lose a playlist because of one bad run.
            existing = _first_existing(target, m3u_dir / f"{name}.m3u")
            if existing is not None:
                counts = _count_entries(existing)
                status = "complete" if result.ok else "failed"
                return SyncOutcome(
                    status=status,
                    name=name,
                    playlist_file=str(existing),
                    total=counts,
                    available=counts,
                    error="" if result.ok else _explain(result.lines),
                )
            return SyncOutcome(
                status="failed" if not result.ok else "complete",
                name=name,
                error=_explain(result.lines)
                if not result.ok
                else "gamdl produced no playlist file",
            )

        repaired = repair_playlist(
            produced,
            m3u_dir=m3u_dir,
            output_root=output_root,
            title=name,
            prune_missing=settings.prune_playlist_entries,
        )

        # A run that died partway leaves a partial file. Publishing it would
        # replace a complete playlist with a truncated one, so an incomplete
        # result is only accepted when it is not a regression.
        if not result.ok:
            existing_count = _count_entries(target) if target.is_file() else 0
            if existing_count > repaired.total:
                produced.unlink(missing_ok=True)
                log.warning(
                    "%s: gamdl failed and produced only %d of %d known track(s) — "
                    "keeping the previous playlist file",
                    name,
                    repaired.total,
                    existing_count,
                )
                return SyncOutcome(
                    status="partial",
                    name=name,
                    playlist_file=str(target),
                    total=existing_count,
                    available=existing_count,
                    error=_explain(result.lines),
                )

        m3u_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, repaired.text)
        if produced != target:
            produced.unlink(missing_ok=True)
        # An older run may have left a .m3u beside the .m3u8 we now write.
        legacy = m3u_dir / f"{name}.m3u"
        if legacy != target:
            legacy.unlink(missing_ok=True)

        self._drop_previous_file(url, target)

        status = "complete"
        error = ""
        if not result.ok:
            status = "partial" if repaired.available else "failed"
            error = _explain(result.lines)
        elif repaired.missing:
            status = "partial"
            error = f"{repaired.missing} track(s) unavailable"

        log.info(
            "%s: %d track(s), %d available%s",
            name,
            repaired.total,
            repaired.available,
            f", {repaired.missing} missing" if repaired.missing else "",
        )

        return SyncOutcome(
            status=status,
            name=name,
            playlist_file=str(target),
            total=repaired.total,
            available=repaired.available,
            missing=repaired.missing,
            error=error,
        )

    def _drop_previous_file(self, url: str, current: Path) -> None:
        """Remove the file this playlist used to occupy after a rename."""
        entry = self.status.read().get(url) or {}
        previous = entry.get("playlistFile")
        if not previous or previous == str(current):
            return
        path = Path(previous)
        if path.is_file() and path.parent == current.parent:
            path.unlink(missing_ok=True)
            log.info("removed superseded playlist file %s", path.name)

    def _sweep_orphans(self, settings: Settings, keep_names: list[str]) -> None:
        """Quarantine playlist files that no configured playlist claims.

        Moved to ``.trash`` rather than deleted: this code decides that a file in
        the user's music library is unwanted, and it should not be the last word.
        """
        m3u_dir = Path(settings.playlist_m3u_dir)
        if not m3u_dir.is_dir():
            return
        keep = {name.casefold() for name in keep_names}
        trash = m3u_dir / ".trash"
        for path in sorted(m3u_dir.glob("*.m3u*")):
            if not path.is_file() or path.stem.casefold() in keep:
                continue
            try:
                trash.mkdir(parents=True, exist_ok=True)
                destination = trash / path.name
                if destination.exists():
                    destination = trash / f"{path.stem}.{int(time.time())}{path.suffix}"
                shutil.move(str(path), str(destination))
                log.info("moved unclaimed playlist file %s to .trash", path.name)
            except OSError as exc:
                log.warning("could not quarantine %s: %s", path.name, exc)

    # ------------------------------------------------------------------ #
    # Support
    # ------------------------------------------------------------------ #

    def _read_overrides(self) -> dict[str, str]:
        data = read_json(self.paths.overrides, {})
        if not isinstance(data, dict):
            return {}
        return {
            k: v
            for k, v in data.items()
            if isinstance(k, str) and isinstance(v, str) and not k.startswith("_")
        }

    def _maybe_update(self, settings: Settings) -> None:
        if not settings.auto_update:
            return
        from .updater import Updater  # imported lazily; only needed on update cycles

        updater = Updater(
            nm3u8dlre_path=settings.nm3u8dlre_path,
            state_path=self.paths.update_state,
            interval=settings.auto_update_interval,
        )
        if not updater.due():
            return
        self._beat("updating-tools")
        outcome = updater.run(update_gamdl=settings.auto_update_gamdl)
        if outcome.gamdl_changed or outcome.gamdl_rolled_back:
            # Options may have been added or removed by the new build.
            self.caps = probe_capabilities()

    def _beat(self, state: str, *, detail: str = "", force: bool = False) -> None:
        """Record what the daemon is doing, and publish it if it is time.

        The background thread republishes this on a fixed cadence, so callers
        only need to say what changed rather than remembering to tick.
        """
        self._state = state
        self._detail = detail
        now = time.monotonic()
        if not force and (now - self._last_heartbeat) < HEARTBEAT_INTERVAL:
            return
        self._last_heartbeat = now
        write_heartbeat(self.paths.heartbeat, state=state, cycle=self.cycle, detail=detail)

    def _sleep(self, seconds: float) -> None:
        """Wait, but stay responsive to signals and to the control channel."""
        deadline = time.monotonic() + max(0.0, seconds)
        self.wake_event.clear()
        while not self.stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            self._beat("sleeping")
            if self.wake_event.wait(min(CONTROL_POLL_INTERVAL, remaining)):
                return
            if self._handle_commands():
                return

    def _handle_commands(self) -> bool:
        """Apply pending control commands. Returns True if the sleep should end."""
        wake = False
        for command in self.control.poll():
            if command.name == SYNC_NOW:
                log.info("sync requested via control channel")
                self._scoped_urls = command.urls
                wake = True
            elif command.name == RELOAD:
                log.info("settings reload requested")
                wake = True
            elif command.name == CANCEL:
                log.info("cancel requested")
                self.cancel_event.set()
        return wake


def _first_existing(*candidates: Path) -> Path | None:
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _count_entries(path: Path) -> int:
    try:
        return sum(
            1
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.strip() and not line.strip().startswith("#")
        )
    except OSError:
        return 0


_KNOWN_FAILURES = (
    ("cookies", "Cookies are missing or expired — upload a fresh cookies.txt."),
    ("401", "Apple rejected the request (401) — the cookies are probably expired."),
    ("403", "Apple refused the request (403) — check the cookies and the storefront."),
    ("subscription", "This Apple Music account does not have an active subscription."),
    ("not found", "Apple could not find that playlist — check the URL."),
    ("wvd", "A .wvd device file is required for this codec; falling back is recommended."),
    ("n_m3u8dl-re", "N_m3u8DL-RE failed — try the ffmpeg download mode."),
)


def _explain(lines: list[str]) -> str:
    """Turn gamdl's output into one sentence a user can act on."""
    haystack = "\n".join(lines[-60:]).lower()
    for needle, message in _KNOWN_FAILURES:
        if needle in haystack:
            return message
    for line in reversed(lines):
        stripped = line.strip()
        if stripped and ("error" in stripped.lower() or "exception" in stripped.lower()):
            return stripped[:300]
    return "gamdl exited with an error — see the log for details."
