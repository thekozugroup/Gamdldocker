"""Command-line entry point: ``python -m gamdl_sync``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import load_settings
from .control import SYNC_NOW, ControlChannel
from .daemon import Daemon, Paths
from .logging_setup import setup_logging


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gamdl-sync",
        description="Keep Apple Music playlists mirrored to a local library.",
    )
    parser.add_argument(
        "--config-dir", default="/config", help="directory holding settings and state"
    )
    parser.add_argument("--log-level", default=None, help="DEBUG, INFO, WARNING or ERROR")
    parser.add_argument("--version", action="version", version=f"gamdl-sync {__version__}")

    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="run the sync daemon (default)")
    sub.add_parser("sync-now", help="ask a running daemon to start a cycle immediately")
    sub.add_parser("show-config", help="print the effective configuration and exit")
    sub.add_parser(
        "doctor", help="check the environment and report anything that would break a sync"
    )

    args = parser.parse_args(argv)
    paths = Paths(config_dir=Path(args.config_dir))

    if args.command == "sync-now":
        ControlChannel(paths.control).emit(SYNC_NOW)
        print("requested an immediate sync")
        return 0

    if args.command == "show-config":
        print(json.dumps(load_settings(paths.settings).to_json(), indent=2, ensure_ascii=False))
        return 0

    setup_logging(paths.logs, level=args.log_level)

    if args.command == "doctor":
        from .doctor import run_doctor

        return run_doctor(paths)

    return Daemon(paths).run()


if __name__ == "__main__":
    sys.exit(main())
