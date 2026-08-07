"""Guards against the failure modes that turn a sync tool into a silent outage.

Each test here corresponds to a defect that shipped once: a wedged child process
nobody noticed, two playlists quietly sharing one file, a lock that did not lock.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from gamdl_sync.gamdl_runner import run_gamdl
from gamdl_sync.naming import uniquify
from gamdl_sync.state import FileLock, atomic_write_json, read_json

# --------------------------------------------------------------------------- #
# A silent child must not wedge the cycle
# --------------------------------------------------------------------------- #


def _sleeper(seconds: int = 300) -> list[str]:
    """A child that produces no output at all — the shape of a stalled download."""
    return ["-c", f"import time; time.sleep({seconds})"]


def test_a_silent_child_is_killed_by_the_idle_timeout():
    started = time.monotonic()
    result = run_gamdl(_sleeper(), executable=sys.executable, idle_timeout=2, overall_timeout=60)
    assert time.monotonic() - started < 20
    assert result.returncode != 0
    assert any("no output" in line for line in result.lines)


def test_a_stop_signal_reaches_a_silent_child():
    # The reader blocks in readline, so only the watchdog can act on this.
    stop = threading.Event()
    threading.Timer(1.0, stop.set).start()
    started = time.monotonic()
    result = run_gamdl(
        _sleeper(),
        executable=sys.executable,
        stop_event=stop,
        idle_timeout=600,
        overall_timeout=600,
    )
    assert time.monotonic() - started < 20
    assert any("stopped" in line for line in result.lines)


def test_the_overall_timeout_bounds_a_chatty_child():
    # Output keeps the idle timeout at bay forever; the ceiling still applies.
    chatty = [
        "-c",
        "import time\nwhile True:\n    print('working', flush=True)\n    time.sleep(0.05)",
    ]
    started = time.monotonic()
    result = run_gamdl(chatty, executable=sys.executable, idle_timeout=600, overall_timeout=2)
    assert time.monotonic() - started < 20
    assert any("exceeded" in line for line in result.lines)


def test_a_normal_child_is_not_disturbed():
    result = run_gamdl(
        ["-c", "print('Track 1/3'); print('done')"],
        executable=sys.executable,
        idle_timeout=30,
        overall_timeout=60,
    )
    assert result.returncode == 0
    assert result.track_total == 3
    assert not any("stopped" in line for line in result.lines)


# --------------------------------------------------------------------------- #
# Collision handling
# --------------------------------------------------------------------------- #


def test_two_playlists_with_the_same_title_get_different_names():
    # The bug: clearing "my own existing file" from the tracker also cleared the
    # reservation an earlier playlist had made, so both resolved to "Jams".
    claimed: set[str] = set()
    on_disk = {"jams"}

    first = uniquify(
        "Jams", "https://music.apple.com/us/playlist/a/pl.u-AAAAAA111111", claimed | on_disk
    )
    claimed.add(first.casefold())
    on_disk.discard("jams")

    second = uniquify(
        "Jams", "https://music.apple.com/us/playlist/b/pl.u-BBBBBB222222", claimed | on_disk
    )
    assert first != second


# --------------------------------------------------------------------------- #
# The lock has to be a real lock, and to the other language too
# --------------------------------------------------------------------------- #


def test_the_lock_is_exclusive_between_processes(tmp_path: Path):
    target = tmp_path / "state.json"
    atomic_write_json(target, {})
    probe = (
        "import os,sys\n"
        "try:\n"
        f"    os.open({str(target) + '.lock'!r}, os.O_CREAT | os.O_EXCL | os.O_WRONLY)\n"
        "    print('acquired')\n"
        "except FileExistsError:\n"
        "    print('blocked')\n"
    )
    with FileLock(target):
        out = subprocess.run(
            [sys.executable, "-c", probe], capture_output=True, text=True, timeout=30
        )
        assert out.stdout.strip() == "blocked"
    out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=30)
    assert out.stdout.strip() == "acquired"


def test_the_lock_is_released_even_when_the_body_raises(tmp_path: Path):
    target = tmp_path / "state.json"
    lock = Path(str(target) + ".lock")
    try:
        with FileLock(target):
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert not lock.exists()


def test_a_stale_lock_is_broken_rather_than_waited_out(tmp_path: Path):
    target = tmp_path / "state.json"
    lock = Path(str(target) + ".lock")
    lock.write_text('{"pid": 999999, "ts": 0}', encoding="utf-8")
    # Backdate it well past the staleness threshold.
    os.utime(lock, (time.time() - 3600, time.time() - 3600))

    started = time.monotonic()
    with FileLock(target, timeout=5):
        assert time.monotonic() - started < 3
    assert not lock.exists()


def test_a_lock_file_left_behind_does_not_corrupt_the_data(tmp_path: Path):
    target = tmp_path / "state.json"
    atomic_write_json(target, {"keep": 1})
    Path(str(target) + ".lock").write_text("{}", encoding="utf-8")
    # Even having given up on the lock, the write must be all-or-nothing.
    with FileLock(target, timeout=0.2):
        atomic_write_json(target, {"keep": 2})
    assert read_json(target, {}) == {"keep": 2}
    assert json.loads(target.read_text(encoding="utf-8")) == {"keep": 2}
