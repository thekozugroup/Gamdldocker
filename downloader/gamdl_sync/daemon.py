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

from .compat import apply_compat_patches
from .config import Settings, load_settings, migrate_settings_file
from .control import CANCEL, RELOAD, SYNC_NOW, ControlChannel
from .gamdl_runner import GamdlCapabilities, build_args, probe_capabilities, run_gamdl
from .m3u import repair_playlist
from .migrations import run_migrations
from .naming import (
    predict_gamdl_name,
    resolve_playlist_name,
    resolve_playlist_title,
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

#: Where gamdl is told to write playlist files, relative to the library root.
#: Deliberately not the published playlist directory — see sync_one.
STAGING_DIRNAME = ".gamdl-staging"


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
        self._state_since = time.monotonic()
        #: Lowercased filenames claimed by the current plan. Read by
        #: _drop_previous_file so cleanup cannot delete a sibling's file.
        self._claimed_names: set[str] = set()

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

        Tying the heartbeat *write* to the loop's own progress meant an hour-long
        download looked identical to a wedged process. But a thread that only
        republishes a timestamp would report health forever while the sync thread
        is stuck, so the record also carries when the daemon last actually
        changed what it was doing. The healthcheck reads that, not the write time.
        """
        while not self.stop_event.wait(HEARTBEAT_INTERVAL):
            write_heartbeat(
                self.paths.heartbeat,
                state=self._state,
                cycle=self.cycle,
                detail=self._detail,
                stalled_for=time.monotonic() - self._state_since,
            )

    def run(self) -> int:
        self.install_signal_handlers()
        self.control.ensure()
        self._beat("starting", force=True)
        heartbeat = threading.Thread(target=self._heartbeat_loop, name="heartbeat", daemon=True)
        heartbeat.start()
        run_migrations(self.paths)
        migrate_settings_file(self.paths.settings)
        apply_compat_patches()

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

            # `configured` is every playlist the user has; `targets` is the
            # subset to sync now. They differ when the web UI asks for a scoped
            # sync — which it does every time a playlist is added. Housekeeping
            # must always reason about the full set: scoping it would treat the
            # other playlists as though the user had deleted them.
            configured = load_playlist_urls(self.paths.playlists)
            targets = configured
            if self._scoped_urls:
                scoped = [u for u in configured if u in self._scoped_urls]
                if scoped:
                    targets = scoped
                self._scoped_urls = []

            if not configured:
                log.info("no playlists configured; waiting %ss", EMPTY_RETRY_SECONDS)
                self._beat("idle-no-playlists")
                self._sleep(EMPTY_RETRY_SECONDS)
                continue

            self.cancel_event.clear()
            try:
                self._run_cycle(settings, configured, targets)
            except Exception:
                # Housekeeping runs outside any per-playlist guard, so an ENOSPC
                # on /config or a transient volume error used to propagate out of
                # run() and end the daemon. Log it and try again next cycle.
                log.exception("cycle %d failed; retrying at the next interval", self.cycle)

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

    def _run_cycle(
        self, settings: Settings, configured: list[str], targets: list[str] | None = None
    ) -> None:
        """Sync ``targets`` (default: everything) out of the ``configured`` set.

        Every step that decides what to *keep* — the status file, the name cache,
        the playlist folder — is driven by ``configured``. Only the download loop
        is driven by ``targets``.
        """
        started = time.monotonic()
        targets = configured if targets is None else targets
        target_set = set(targets)

        m3u_dir = Path(settings.playlist_m3u_dir)
        m3u_dir.mkdir(parents=True, exist_ok=True)
        Path(settings.output_location).mkdir(parents=True, exist_ok=True)
        Path(settings.temp_path).mkdir(parents=True, exist_ok=True)

        self.status.reset_to_idle(configured)
        self.names.prune(configured)

        overrides = self._read_overrides()
        name_cache = self.names.read()

        # Two separate sets, because they mean different things.
        #
        # `on_disk` is what already exists in the folder. A playlist finding its
        # own file there is not a collision, so that entry gets cleared as it is
        # matched — otherwise every playlist would gain a suffix on the second run.
        #
        # `claimed` is what playlists earlier in this plan have taken. Those are
        # real collisions and must never be cleared. Keeping both in one set let
        # the clear-my-own-file step erase an earlier playlist's reservation, so
        # two playlists with the same title both resolved to the same filename
        # and silently overwrote each other every cycle.
        on_disk: set[str] = {
            path.stem.casefold() for path in m3u_dir.glob("*.m3u*") if path.is_file()
        }
        claimed: set[str] = set()

        # Names are resolved for every configured playlist even on a scoped run:
        # the collision suffixes depend on the whole set, and the orphan sweep
        # needs to know which filenames are legitimately claimed.
        # (url, filename stem, display title). The last two differ whenever the
        # title contained something a filename cannot carry, which is exactly
        # when the #PLAYLIST tag earns its keep.
        plan: list[tuple[str, str, str]] = []
        for url in configured:
            resolved, source = resolve_playlist_name(
                url, overrides=overrides, name_cache=name_cache, safe=settings.safe_filenames
            )
            title = resolve_playlist_title(url, overrides=overrides, name_cache=name_cache)
            lowered = resolved.casefold()
            if lowered not in claimed:
                on_disk.discard(lowered)
            unique = uniquify(resolved, url, claimed | on_disk)
            claimed.add(unique.casefold())
            plan.append((url, unique, title))
            log.debug("resolved %s -> %r (via %s)", url, unique, source)

        self._claimed_names = {name.casefold() for _, name, _ in plan}

        work = [item for item in plan if item[0] in target_set]
        if len(work) != len(plan):
            log.info("syncing %d of %d playlist(s) this cycle", len(work), len(plan))

        if settings.concurrency > 1 and len(work) > 1:
            log.info("syncing %d playlists (%d at a time)", len(work), settings.concurrency)
            with ThreadPoolExecutor(max_workers=settings.concurrency) as pool:
                list(pool.map(lambda item: self._sync_guarded(settings, *item), work))
        else:
            for url, name, _title in work:
                # Between playlists is the only safe point to notice a cancel,
                # and it is the only place the control directory gets read while
                # a cycle is running.
                self._handle_commands()
                if self.stop_event.is_set() or self.cancel_event.is_set():
                    log.info(
                        "cycle cancelled after %d playlist(s)", work.index((url, name, _title))
                    )
                    break
                self._sync_guarded(settings, url, name, _title)

        self._sweep_orphans(settings, [name for _, name, _ in plan])
        log.info("cycle %d finished in %.1fs", self.cycle, time.monotonic() - started)

    def _sync_guarded(self, settings: Settings, url: str, name: str, title: str = "") -> None:
        if self.stop_event.is_set() or self.cancel_event.is_set():
            return
        started = time.monotonic()
        self.status.mark_running(url, name=name)
        self._beat("syncing", detail=name)
        try:
            outcome = self.sync_one(settings, url, name, title or name)
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

    def sync_one(self, settings: Settings, url: str, name: str, title: str = "") -> SyncOutcome:
        output_root = Path(settings.output_location)
        m3u_dir = Path(settings.playlist_m3u_dir)

        # gamdl always writes into a staging folder, never into the published
        # playlist directory.
        #
        # It has to be a separate directory because the file must be deleted
        # before each run — gamdl only overwrites the lines it touches and never
        # truncates, so a surviving file would keep tracks the playlist no longer
        # contains. Pointing gamdl straight at the published path meant that
        # delete removed the live playlist, and a run that then failed left the
        # user with no playlist file at all.
        #
        # gamdl can only write beneath its own --output-path, so staging lives
        # there, hidden, and is emptied as we go.
        staging_dir = output_root / STAGING_DIRNAME
        staging_dir.mkdir(parents=True, exist_ok=True)

        # gamdl replaces its own illegal characters, so the file it writes may
        # not carry the name we asked for.
        gamdl_stem = predict_gamdl_name(name, settings.truncate)
        staged = staging_dir / f"{gamdl_stem}.m3u"
        target = m3u_dir / f"{name}.m3u8"

        for stale in (staged, staged.with_suffix(".m3u8"), staging_dir / f"{name}.m3u"):
            stale.unlink(missing_ok=True)

        folder_template = STAGING_DIRNAME

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

        produced = _first_existing(staged, staged.with_suffix(".m3u8"), staging_dir / f"{name}.m3u")

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
            title=title or name,
            prune_missing=settings.prune_playlist_entries,
            source_dir=produced.parent,
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
        """Remove the file this playlist used to occupy after a rename.

        The check against ``_claimed_names`` matters when two playlists swap
        titles through the overrides file: the second one to sync would otherwise
        delete the file the first had just written, because that path is still
        recorded as the second one's previous location.
        """
        entry = self.status.read().get(url) or {}
        previous = entry.get("playlistFile")
        if not previous or previous == str(current):
            return
        path = Path(previous)
        if not path.is_file() or path.parent != current.parent:
            return
        if path.stem.casefold() in self._claimed_names:
            log.info("keeping %s — another playlist now claims that name", path.name)
            return
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
        if state != self._state or detail != self._detail:
            self._state_since = time.monotonic()
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
