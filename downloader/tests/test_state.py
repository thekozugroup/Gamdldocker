"""State-store tests.

These files are read by the web UI while the daemon writes them, so the
guarantees under test are atomicity, tolerance of corruption, and merge-in-place
updates that never clobber a field the caller did not mention.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from gamdl_sync.state import (
    FileLock,
    NameCache,
    StatusStore,
    atomic_write_json,
    read_heartbeat,
    read_json,
    write_heartbeat,
)

# --------------------------------------------------------------------------- #
# Primitives
# --------------------------------------------------------------------------- #


def test_read_json_returns_default_for_a_missing_file(tmp_path: Path):
    assert read_json(tmp_path / "nope.json", {"a": 1}) == {"a": 1}


def test_read_json_returns_default_for_corrupt_content(tmp_path: Path):
    path = tmp_path / "bad.json"
    path.write_text("{{{", encoding="utf-8")
    assert read_json(path, "fallback") == "fallback"


def test_read_json_survives_invalid_utf8(tmp_path: Path):
    path = tmp_path / "bad.json"
    path.write_bytes(b"\xff\xfe\x00garbage")
    assert read_json(path, {}) == {}


def test_atomic_write_creates_parent_directories(tmp_path: Path):
    path = tmp_path / "a" / "b" / "c.json"
    atomic_write_json(path, {"x": 1})
    assert json.loads(path.read_text(encoding="utf-8")) == {"x": 1}


def test_atomic_write_leaves_no_temp_files_behind(tmp_path: Path):
    path = tmp_path / "c.json"
    atomic_write_json(path, {"x": 1})
    assert [p.name for p in tmp_path.iterdir()] == ["c.json"]


def test_atomic_write_preserves_unicode_literally(tmp_path: Path):
    path = tmp_path / "c.json"
    atomic_write_json(path, {"name": "🪨+roll"})
    assert "🪨+roll" in path.read_text(encoding="utf-8")


def test_atomic_write_applies_the_requested_mode(tmp_path: Path):
    path = tmp_path / "secret.json"
    atomic_write_json(path, {"x": 1}, mode=0o600)
    assert oct(path.stat().st_mode)[-3:] == "600"


def test_file_lock_is_exclusive(tmp_path: Path):
    path = tmp_path / "locked.json"
    order: list[str] = []
    inside = threading.Event()
    release = threading.Event()

    def hold():
        with FileLock(path):
            order.append("first-in")
            inside.set()
            release.wait(timeout=5)
            order.append("first-out")

    thread = threading.Thread(target=hold)
    thread.start()
    inside.wait(timeout=5)
    release.set()
    thread.join(timeout=5)

    with FileLock(path):
        order.append("second-in")

    assert order == ["first-in", "first-out", "second-in"]


def test_file_lock_times_out_rather_than_hanging(tmp_path: Path):
    # A process that died holding the lock must not stall the sync loop forever.
    path = tmp_path / "stuck.json"
    with FileLock(path), FileLock(path, timeout=0.1):
        pass  # proceeds unlocked after the timeout


# --------------------------------------------------------------------------- #
# StatusStore
# --------------------------------------------------------------------------- #


URL = "https://music.apple.com/us/playlist/x/pl.u-AAAAAA111111"


def test_status_update_merges_rather_than_replaces(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.update(URL, status="running", songCount=10)
    store.update(URL, status="complete")
    entry = store.read()[URL]
    assert entry["status"] == "complete"
    assert entry["songCount"] == 10


def test_status_ignores_none_values(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.update(URL, status="complete", songCount=5)
    store.update(URL, songCount=None)
    assert store.read()[URL]["songCount"] == 5


def test_mark_running_clears_a_previous_error(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.mark_finished(URL, "failed", error="boom")
    store.mark_running(URL, name="X")
    assert store.read()[URL]["lastError"] == ""


def test_mark_finished_records_the_right_timestamp_field(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.mark_finished(URL, "failed", error="boom")
    assert "failedAt" in store.read()[URL]
    store.mark_finished(URL, "complete")
    assert "lastDownloaded" in store.read()[URL]


def test_reset_to_idle_forgets_removed_playlists(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.update(URL, status="complete")
    store.update("https://music.apple.com/us/playlist/y/pl.u-BBBBBB222222", status="complete")
    store.reset_to_idle([URL])
    assert list(store.read()) == [URL]


def test_reset_to_idle_does_not_interrupt_a_running_playlist(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.mark_running(URL)
    store.reset_to_idle([URL])
    assert store.read()[URL]["status"] == "running"


def test_reset_to_idle_keeps_history_for_known_playlists(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    store.mark_finished(URL, "complete", song_count=42)
    store.reset_to_idle([URL])
    assert store.read()[URL]["songCount"] == 42


def test_status_read_of_a_corrupt_file_is_empty(tmp_path: Path):
    path = tmp_path / "status.json"
    path.write_text("garbage", encoding="utf-8")
    assert StatusStore(path).read() == {}


def test_concurrent_status_updates_do_not_lose_entries(tmp_path: Path):
    store = StatusStore(tmp_path / "status.json")
    urls = [f"https://music.apple.com/us/playlist/p{i}/pl.u-{i:012d}" for i in range(20)]

    def worker(url: str) -> None:
        store.update(url, status="complete")

    threads = [threading.Thread(target=worker, args=(u,)) for u in urls]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert set(store.read()) == set(urls)


# --------------------------------------------------------------------------- #
# NameCache
# --------------------------------------------------------------------------- #


def test_name_cache_upgrades_legacy_string_entries(tmp_path: Path):
    path = tmp_path / "cache.json"
    path.write_text(json.dumps({URL: "Old Name"}), encoding="utf-8")
    assert NameCache(path).read()[URL] == {"name": "Old Name"}


def test_name_cache_set_name_preserves_other_fields(tmp_path: Path):
    path = tmp_path / "cache.json"
    path.write_text(json.dumps({URL: {"name": "Old", "songCount": 7}}), encoding="utf-8")
    cache = NameCache(path)
    cache.set_name(URL, "New")
    assert cache.read()[URL] == {"name": "New", "songCount": 7}


def test_name_cache_is_written_with_tight_permissions(tmp_path: Path):
    path = tmp_path / "cache.json"
    NameCache(path).set_name(URL, "X")
    assert oct(path.stat().st_mode)[-3:] == "600"


def test_name_cache_prune_drops_unknown_urls(tmp_path: Path):
    path = tmp_path / "cache.json"
    cache = NameCache(path)
    cache.set_name(URL, "Keep")
    cache.set_name("https://music.apple.com/us/playlist/y/pl.u-BBBBBB222222", "Drop")
    cache.prune([URL])
    assert list(cache.read()) == [URL]


def test_name_cache_prune_is_a_noop_when_nothing_changes(tmp_path: Path):
    path = tmp_path / "cache.json"
    cache = NameCache(path)
    cache.set_name(URL, "Keep")
    before = path.stat().st_mtime_ns
    cache.prune([URL])
    assert path.stat().st_mtime_ns == before


# --------------------------------------------------------------------------- #
# Heartbeat
# --------------------------------------------------------------------------- #


def test_heartbeat_round_trips(tmp_path: Path):
    path = tmp_path / "beat"
    write_heartbeat(path, state="syncing", cycle=3, detail="Jams")
    beat = read_heartbeat(path)
    assert beat["state"] == "syncing"
    assert beat["cycle"] == 3
    assert beat["pid"] == os.getpid()
    assert beat["ts"] > 0


def test_heartbeat_read_of_a_missing_file_is_empty(tmp_path: Path):
    assert read_heartbeat(tmp_path / "nope") == {}
