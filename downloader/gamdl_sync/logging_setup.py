"""Logging configuration.

Output goes two places: stdout, so ``docker logs`` still works the way people
expect, and a rotating file under ``/config/logs`` that the web UI reads. The
file is what removed the need to mount the docker socket into the web container
just to show a log view.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import re
import sys
from pathlib import Path

__all__ = ["DEFAULT_LOG_DIR", "setup_logging"]

DEFAULT_LOG_DIR = Path("/config/logs")
_LOG_NAME = "downloader.log"
_MAX_BYTES = 4 * 1024 * 1024
_BACKUPS = 3

# ANSI escapes from gamdl's rich output would render as noise in the web UI.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")

# Cookie values and Apple tokens must never reach a log file the UI serves.
_SECRET_PATTERNS = (
    re.compile(r"(media-user-token[=:\s\"']+)([A-Za-z0-9%_\-+/=.]{8,})", re.IGNORECASE),
    re.compile(
        r"(itua|myacinfo|dqsid|pltvcid)([=:\s\"']+)([A-Za-z0-9%_\-+/=.]{8,})", re.IGNORECASE
    ),
    re.compile(r"(authorization[=:\s\"']+bearer\s+)([A-Za-z0-9._\-]{8,})", re.IGNORECASE),
    re.compile(r"(x-apple-[a-z-]*token[=:\s\"']+)([A-Za-z0-9%_\-+/=.]{8,})", re.IGNORECASE),
)


class _SanitizingFormatter(logging.Formatter):
    """Strips ANSI sequences and redacts anything that looks like a credential."""

    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        message = _ANSI_RE.sub("", message)
        for pattern in _SECRET_PATTERNS:
            message = pattern.sub(lambda m: _redact(m), message)
        return message


def _redact(match: re.Match[str]) -> str:
    groups = match.groups()
    # The final group is always the secret itself.
    return "".join(groups[:-1]) + "«redacted»"


def setup_logging(log_dir: Path | str | None = None, *, level: str | None = None) -> Path | None:
    """Configure the root logger. Returns the log file path, if one was created."""
    resolved_level = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    numeric = getattr(logging, resolved_level, logging.INFO)

    root = logging.getLogger()
    root.setLevel(numeric)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = _SanitizingFormatter(
        fmt="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    root.addHandler(stream)

    directory = Path(log_dir) if log_dir is not None else DEFAULT_LOG_DIR
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / _LOG_NAME
        file_handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=_MAX_BYTES, backupCount=_BACKUPS, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
        return path
    except OSError as exc:
        root.warning("file logging disabled (%s); logs remain on stdout", exc)
        return None
