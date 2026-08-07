"""Control-channel tests.

This channel exists to replace the docker socket, so the properties that matter
are: a command is consumed exactly once, an unreadable command still counts as a
button press, and nothing unexpected in the directory can wedge the daemon.
"""

from __future__ import annotations

from pathlib import Path

from gamdl_sync.control import CANCEL, RELOAD, SYNC_NOW, ControlChannel


def test_emit_then_poll_returns_the_command(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW)
    commands = channel.poll()
    assert [c.name for c in commands] == [SYNC_NOW]


def test_a_command_is_consumed_exactly_once(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW)
    assert channel.poll()
    assert channel.poll() == []


def test_payload_urls_scope_the_command(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW, {"urls": ["https://music.apple.com/us/playlist/a/pl.u-1"]})
    assert channel.poll()[0].urls == ["https://music.apple.com/us/playlist/a/pl.u-1"]


def test_missing_payload_means_all_playlists(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW)
    assert channel.poll()[0].urls == []


def test_non_string_urls_in_the_payload_are_dropped(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW, {"urls": ["good", 42, None, "  "]})
    assert channel.poll()[0].urls == ["good"]


def test_an_empty_file_still_counts_as_a_command(tmp_path: Path):
    # `touch /config/control/sync-now` from a shell must work.
    directory = tmp_path / "control"
    directory.mkdir(parents=True)
    (directory / SYNC_NOW).write_text("", encoding="utf-8")
    assert [c.name for c in ControlChannel(directory).poll()] == [SYNC_NOW]


def test_malformed_json_still_counts_as_a_command(tmp_path: Path):
    directory = tmp_path / "control"
    directory.mkdir(parents=True)
    (directory / RELOAD).write_text("{not json", encoding="utf-8")
    command = ControlChannel(directory).poll()[0]
    assert command.name == RELOAD
    assert command.urls == []


def test_unknown_files_are_removed_and_ignored(tmp_path: Path):
    directory = tmp_path / "control"
    directory.mkdir(parents=True)
    (directory / "please-rm-rf").write_text("{}", encoding="utf-8")
    assert ControlChannel(directory).poll() == []
    assert not (directory / "please-rm-rf").exists()


def test_an_oversized_command_file_is_not_parsed(tmp_path: Path):
    directory = tmp_path / "control"
    directory.mkdir(parents=True)
    (directory / SYNC_NOW).write_text('{"urls": ["x"]}' + " " * 200_000, encoding="utf-8")
    command = ControlChannel(directory).poll()[0]
    assert command.name == SYNC_NOW
    assert command.urls == []


def test_polling_a_missing_directory_is_safe(tmp_path: Path):
    assert ControlChannel(tmp_path / "nope").poll() == []


def test_multiple_commands_are_returned_in_a_stable_order(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.emit(SYNC_NOW)
    channel.emit(CANCEL)
    channel.emit(RELOAD)
    assert [c.name for c in channel.poll()] == sorted([SYNC_NOW, CANCEL, RELOAD])


def test_ensure_is_idempotent(tmp_path: Path):
    channel = ControlChannel(tmp_path / "control")
    channel.ensure()
    channel.ensure()
    assert (tmp_path / "control").is_dir()
