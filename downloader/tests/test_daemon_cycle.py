"""Cycle-level behaviour.

These exercise `_run_cycle` against a fake gamdl rather than the real one, which
is what makes it possible to test the parts that decide what to keep and what to
throw away — historically the code most able to lose a user's data.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gamdl_sync.config import Settings
from gamdl_sync.daemon import Daemon, Paths

ROCK = "https://music.apple.com/us/playlist/rock/pl.u-AAAAAA111111"
JAZZ = "https://music.apple.com/us/playlist/jazz/pl.u-BBBBBB222222"
FOLK = "https://music.apple.com/us/playlist/folk/pl.u-CCCCCC333333"


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A daemon whose downloads are stubbed out, over a populated config dir."""
    config = tmp_path / "config"
    music = tmp_path / "music"
    playlists = music / "playlists"
    playlists.mkdir(parents=True)
    config.mkdir()

    (config / "playlists.txt").write_text(f"{ROCK}\n{JAZZ}\n{FOLK}\n", encoding="utf-8")
    (config / "playlist-status.json").write_text(
        json.dumps(
            {
                url: {"status": "complete", "name": name, "songCount": count}
                for url, name, count in ((ROCK, "Rock", 10), (JAZZ, "Jazz", 20), (FOLK, "Folk", 30))
            }
        ),
        encoding="utf-8",
    )
    (config / "playlist-name-cache.json").write_text(
        json.dumps({ROCK: {"name": "Rock"}, JAZZ: {"name": "Jazz"}, FOLK: {"name": "Folk"}}),
        encoding="utf-8",
    )
    for name in ("Rock", "Jazz", "Folk"):
        (playlists / f"{name}.m3u8").write_text(f"#EXTM3U\n#PLAYLIST:{name}\n", encoding="utf-8")

    daemon = Daemon(Paths(config_dir=config))
    settings = Settings(output_location=str(music), playlist_m3u_dir=str(playlists))

    synced: list[str] = []

    def fake_sync(_settings, url, name, title=""):
        synced.append(url)
        from gamdl_sync.daemon import SyncOutcome

        return SyncOutcome(
            status="complete", name=name, playlist_file=str(playlists / f"{name}.m3u8")
        )

    monkeypatch.setattr(daemon, "sync_one", fake_sync)
    return daemon, settings, playlists, synced


def names_on_disk(playlists: Path) -> set[str]:
    return {p.stem for p in playlists.glob("*.m3u8")}


# --------------------------------------------------------------------------- #
# A scoped cycle must not behave as though the other playlists were deleted
# --------------------------------------------------------------------------- #


def test_scoped_cycle_only_syncs_the_requested_playlist(env):
    daemon, settings, _playlists, synced = env
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK], [JAZZ])
    assert synced == [JAZZ]


def test_scoped_cycle_keeps_the_other_playlist_files(env):
    # The regression: adding a playlist triggers a scoped sync, and the orphan
    # sweep treated every unsynced playlist as unclaimed and moved it to .trash.
    daemon, settings, playlists, _ = env
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK], [JAZZ])
    assert names_on_disk(playlists) == {"Rock", "Jazz", "Folk"}
    assert not (playlists / ".trash").exists()


def test_scoped_cycle_keeps_the_other_status_entries(env):
    daemon, settings, _playlists, _ = env
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK], [JAZZ])
    status = daemon.status.read()
    assert set(status) == {ROCK, JAZZ, FOLK}
    assert status[FOLK]["songCount"] == 30


def test_scoped_cycle_keeps_the_other_cached_names(env):
    daemon, settings, _playlists, _ = env
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK], [JAZZ])
    assert set(daemon.names.read()) == {ROCK, JAZZ, FOLK}


# --------------------------------------------------------------------------- #
# A full cycle still cleans up
# --------------------------------------------------------------------------- #


def test_full_cycle_syncs_everything(env):
    daemon, settings, _playlists, synced = env
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK])
    assert set(synced) == {ROCK, JAZZ, FOLK}


def test_removing_a_playlist_quarantines_its_file(env):
    daemon, settings, playlists, _ = env
    daemon._run_cycle(settings, [ROCK, JAZZ])
    assert names_on_disk(playlists) == {"Rock", "Jazz"}
    assert (playlists / ".trash" / "Folk.m3u8").is_file()


def test_removing_a_playlist_drops_its_status_and_cache(env):
    daemon, settings, _playlists, _ = env
    daemon._run_cycle(settings, [ROCK, JAZZ])
    assert set(daemon.status.read()) == {ROCK, JAZZ}
    assert set(daemon.names.read()) == {ROCK, JAZZ}


def test_quarantine_never_deletes(env):
    # A file in the user's music library is not this code's to destroy.
    daemon, settings, playlists, _ = env
    (playlists / "Stray.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK])
    assert (playlists / ".trash" / "Stray.m3u8").read_text(encoding="utf-8") == "#EXTM3U\n"


# --------------------------------------------------------------------------- #
# Collision suffixes must not depend on which playlists happened to sync
# --------------------------------------------------------------------------- #


def test_scoped_cycle_resolves_names_against_the_full_set(env):
    daemon, settings, _playlists, _ = env
    # Two playlists whose names differ only by case: the suffix the second one
    # gets must be the same whether or not the first one is in scope.
    cache = {ROCK: {"name": "Mix"}, JAZZ: {"name": "mix"}, FOLK: {"name": "Folk"}}
    (daemon.paths.name_cache).write_text(json.dumps(cache), encoding="utf-8")

    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK], [JAZZ])
    scoped_name = daemon.status.read()[JAZZ]["name"]

    daemon._run_cycle(settings, [ROCK, JAZZ, FOLK])
    full_name = daemon.status.read()[JAZZ]["name"]

    assert scoped_name == full_name
    assert scoped_name != "Mix"
