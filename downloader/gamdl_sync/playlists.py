"""The playlist list itself (``/config/playlists.txt``).

Both the daemon and the web UI read this file, and the web UI writes it. It is a
plain text file on purpose: a user can edit it with a text editor and the format
survives every future version of this project. Comments and blank lines are
preserved on rewrite so the header the file ships with does not get eaten the
first time someone adds a playlist from the UI.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from .state import FileLock, atomic_write_text

log = logging.getLogger(__name__)

__all__ = [
    "canonical_key",
    "is_playlist_url",
    "load_playlist_urls",
    "normalize_url",
    "write_playlist_urls",
]

_PLAYLIST_ID_RE = re.compile(r"(pl\.[A-Za-z0-9][A-Za-z0-9._-]*)")
_APPLE_HOSTS = {"music.apple.com", "beta.music.apple.com", "embed.music.apple.com"}


def normalize_url(url: str) -> str:
    """Trim tracking parameters and fragments without changing what it points at.

    Apple's share sheet appends ``?i=`` (a track anchor) and ``&l=`` (a language
    hint); neither identifies a different playlist, and keeping them would let
    the same playlist be added twice.
    """
    text = (url or "").strip()
    if not text:
        return ""
    try:
        parsed = urlparse(text)
    except ValueError:
        return text
    if not parsed.scheme:
        parsed = urlparse("https://" + text)
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/")
    return urlunparse(("https", host, path, "", "", ""))


def canonical_key(url: str) -> str:
    """A stable identity for a playlist, used for duplicate detection.

    Apple serves the same playlist under every storefront and with an arbitrary
    slug, so only the ``pl.*`` id is meaningful. URLs without one fall back to
    the normalized form.
    """
    match = _PLAYLIST_ID_RE.search(url or "")
    if match:
        return match.group(1)
    return normalize_url(url).lower()


def is_playlist_url(url: str) -> bool:
    """True for an Apple Music *playlist* URL specifically."""
    try:
        parsed = urlparse(normalize_url(url))
    except ValueError:
        return False
    if parsed.netloc.lower() not in _APPLE_HOSTS:
        return False
    parts = [p for p in parsed.path.split("/") if p]
    return "playlist" in parts and bool(_PLAYLIST_ID_RE.search(url or ""))


def load_playlist_urls(path: Path | str) -> list[str]:
    """Read the configured playlist URLs, in order, de-duplicated."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, FileNotFoundError):
        return []

    seen: set[str] = set()
    urls: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key = canonical_key(stripped)
        if key in seen:
            log.debug("skipping duplicate playlist entry: %s", stripped)
            continue
        seen.add(key)
        urls.append(stripped)
    return urls


def write_playlist_urls(path: Path | str, urls: list[str]) -> None:
    """Rewrite the file, keeping the leading comment block intact."""
    path = Path(path)
    with FileLock(path):
        header: list[str] = []
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.strip().startswith("#") or not line.strip():
                    header.append(line)
                else:
                    break
        except (OSError, FileNotFoundError):
            header = []
        body = "\n".join([*header, *urls])
        atomic_write_text(path, body.rstrip("\n") + "\n")
