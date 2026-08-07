"""Playlist and filename naming.

Every function here is pure: no filesystem, no network, no globals. That is what
makes the whole naming pipeline testable, and naming is the part of this project
that users notice when it goes wrong.

The guiding rule is *visual fidelity*: a playlist called ``🪨+roll`` should land on
disk as ``🪨+roll.m3u8``, not ``_ roll.m3u8``. Characters that a filesystem
genuinely cannot store are mapped to fullwidth lookalikes rather than deleted, so
the rendered name still reads the same.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import unquote, urlparse

__all__ = [
    "GAMDL_ILLEGAL_RE",
    "UNSAFE_MAP",
    "escape_for_gamdl_template",
    "playlist_short_id",
    "playlist_slug_from_url",
    "predict_gamdl_name",
    "resolve_playlist_name",
    "sanitize_filename",
    "uniquify",
]


# Characters that are unsafe on at least one mainstream filesystem, mapped to
# single-codepoint fullwidth lookalikes from the U+FF00 block. All nine of the
# Windows-reserved characters are here, plus ';' — gamdl's own sanitizer
# (downloader/constants.py: ILLEGAL_CHARS_RE) rewrites ';' to '_', so mapping it
# ourselves keeps the character visible instead of letting gamdl eat it.
UNSAFE_MAP = {
    "\\": "＼",  # U+FF3C FULLWIDTH REVERSE SOLIDUS
    "/": "／",  # U+FF0F FULLWIDTH SOLIDUS
    ":": "：",  # U+FF1A FULLWIDTH COLON
    "*": "＊",  # U+FF0A FULLWIDTH ASTERISK
    "?": "？",  # U+FF1F FULLWIDTH QUESTION MARK
    '"': "＂",  # U+FF02 FULLWIDTH QUOTATION MARK
    "<": "＜",  # U+FF1C FULLWIDTH LESS-THAN SIGN
    ">": "＞",  # U+FF1E FULLWIDTH GREATER-THAN SIGN
    "|": "｜",  # U+FF5C FULLWIDTH VERTICAL LINE
    ";": "；",  # U+FF1B FULLWIDTH SEMICOLON
}

_UNSAFE_TABLE = str.maketrans(UNSAFE_MAP)

# gamdl's sanitizer, reproduced exactly so we can predict where it will write.
# Kept in sync with gamdl/downloader/constants.py.
GAMDL_ILLEGAL_RE = re.compile(r'[\\/:*?"<>|;]')
GAMDL_ILLEGAL_REPLACEMENT = "_"

# ASCII control characters plus DEL. Never representable in a filename.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# Bidirectional control characters. These are invisible but reorder the rendered
# filename, which is both confusing and a classic filename-spoofing vector.
_BIDI_RE = re.compile(r"[‎‏‪-‮⁦-⁩]")

_WHITESPACE_RE = re.compile(r"\s+")
_TRAILING_JUNK_RE = re.compile(r"[.\s]+$")
_ALNUM_RE = re.compile(r"[A-Za-z0-9]")

# Playlist ids come in two shapes: user playlists (``pl.u-2aBcDeF``) and catalog
# playlists (``pl.1234abcd...``, no hyphen). Capturing the whole id and reducing
# it afterwards handles both — an earlier ``pl\.[A-Za-z0-9]+-?([A-Za-z0-9]+)``
# backtracked on the hyphenless form and captured a single character, so every
# catalog playlist got the same one-letter collision suffix.
_PLAYLIST_ID_RE = re.compile(r"pl\.([A-Za-z0-9][A-Za-z0-9._-]*)")
_NON_ALNUM_RE = re.compile(r"[^A-Za-z0-9]")

# Minimum alphanumeric characters an ASCII-folded name must retain before we
# decide it has been gutted into a meaningless stub ("¯\_(ツ)_/¯" -> "_()_") and
# fall back to the playlist's short id. Three keeps real short names like "Mix".
_SAFE_MIN_ALNUM = 3

# Most filesystems cap a single path component at 255 bytes. We leave headroom
# for the extension and for a possible " (abc123)" collision suffix.
DEFAULT_MAX_BYTES = 200


def sanitize_filename(
    raw: str,
    fallback: str = "playlist",
    *,
    safe: bool = False,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> str:
    """Turn an arbitrary title into a filename component.

    ``safe=True`` additionally folds the name down to ASCII, for legacy SMB and
    exFAT shares that mishandle UTF-8. Everyone else keeps their emoji.
    """
    name = unicodedata.normalize("NFC", raw or "")
    name = _CONTROL_RE.sub("", name)
    name = _BIDI_RE.sub("", name)
    name = name.translate(_UNSAFE_TABLE)

    if safe:
        # Decompose first so accented letters degrade to their base letter
        # ("café" -> "cafe") instead of vanishing entirely ("caf").
        name = unicodedata.normalize("NFKD", name)
        name = name.encode("ascii", "ignore").decode("ascii")

    name = _WHITESPACE_RE.sub(" ", name).strip()
    name = _TRAILING_JUNK_RE.sub("", name)
    name = _truncate_bytes(name, max_bytes)
    # Truncation can expose a new trailing dot or space; Windows refuses both.
    name = _TRAILING_JUNK_RE.sub("", name)

    if safe and len(_ALNUM_RE.findall(name)) < _SAFE_MIN_ALNUM:
        return fallback or "playlist"

    return name or fallback or "playlist"


def _truncate_bytes(name: str, max_bytes: int) -> str:
    """Trim to ``max_bytes`` UTF-8 bytes without splitting a grapheme cluster.

    Cutting mid-codepoint would corrupt the name; cutting mid-cluster would strip
    a skin-tone modifier or ZWJ join off an emoji and leave a different picture
    behind. We drop whole clusters from the end until it fits.
    """
    if max_bytes <= 0 or len(name.encode("utf-8")) <= max_bytes:
        return name

    clusters = _grapheme_clusters(name)
    out: list[str] = []
    used = 0
    for cluster in clusters:
        size = len(cluster.encode("utf-8"))
        if used + size > max_bytes:
            break
        out.append(cluster)
        used += size
    return "".join(out)


# Codepoints that bind to the preceding character rather than standing alone.
_ZWJ = "‍"
_VARIATION_SELECTORS = range(0xFE00, 0xFE10)
_SKIN_TONES = range(0x1F3FB, 0x1F400)
_REGIONAL_INDICATORS = range(0x1F1E6, 0x1F200)
_TAG_CHARS = range(0xE0020, 0xE0080)
_KEYCAP = 0x20E3


def _grapheme_clusters(text: str) -> list[str]:
    """Approximate grapheme cluster segmentation.

    The stdlib has no segmenter and we refuse to add a dependency for this. The
    approximation covers what actually shows up in music metadata: combining
    marks, emoji ZWJ sequences, skin-tone modifiers, variation selectors, keycaps
    and flag pairs.
    """
    clusters: list[str] = []
    i = 0
    length = len(text)
    while i < length:
        start = i
        i += 1
        # A flag is exactly two regional indicators.
        if ord(text[start]) in _REGIONAL_INDICATORS:
            if i < length and ord(text[i]) in _REGIONAL_INDICATORS:
                i += 1
            clusters.append(text[start:i])
            continue
        while i < length:
            ch = text[i]
            code = ord(ch)
            if (
                unicodedata.combining(ch)
                or code == _KEYCAP
                or code in _VARIATION_SELECTORS
                or code in _SKIN_TONES
                or code in _TAG_CHARS
                or unicodedata.category(ch) == "Mn"
            ):
                i += 1
                continue
            if ch == _ZWJ:
                # Consume the joiner and whatever it joins to.
                i += 2 if i + 1 < length else 1
                continue
            break
        clusters.append(text[start:i])
    return clusters


def escape_for_gamdl_template(name: str) -> str:
    """Escape a literal name for use as a gamdl ``--*-template`` value.

    gamdl renders templates through :class:`string.Formatter`, so an unescaped
    ``{`` in a playlist title raises inside gamdl and aborts the download.
    """
    return name.replace("{", "{{").replace("}", "}}")


def predict_gamdl_name(name: str) -> str:
    """Return the filename gamdl will actually produce for ``name``.

    Mirrors ``AppleMusicBaseDownloader._sanitize_string``. Knowing this lets us
    look for gamdl's output at an exact path instead of scanning the library for
    recently-modified files and hoping we picked the right one.
    """
    return GAMDL_ILLEGAL_RE.sub(GAMDL_ILLEGAL_REPLACEMENT, name).strip()


def playlist_short_id(url: str) -> str:
    """A short, stable, filename-safe discriminator for a playlist URL."""
    match = _PLAYLIST_ID_RE.search(url or "")
    if match:
        compact = _NON_ALNUM_RE.sub("", match.group(1))
        if compact:
            return compact[-6:]
    return hashlib.sha1((url or "").encode("utf-8")).hexdigest()[:6]


def playlist_slug_from_url(url: str) -> str:
    """Best-effort human name from the URL path, used only as a last resort.

    Apple's slugs are lowercase ASCII with hyphens for spaces, so de-hyphenating
    reads better. Percent-encoded Unicode slugs are left alone — their hyphens
    and pluses are real characters, not word separators.
    """
    raw = ""
    try:
        parts = [p for p in urlparse(url).path.split("/") if p]
        if "playlist" in parts:
            index = parts.index("playlist")
            if index + 1 < len(parts):
                raw = unquote(parts[index + 1])
    except (ValueError, AttributeError):
        raw = ""

    if not raw:
        return "playlist"

    if raw.isascii():
        raw = re.sub(r"^m-", "", raw, flags=re.IGNORECASE)
        raw = raw.replace("-", " ")

    name = unicodedata.normalize("NFC", raw)
    name = _WHITESPACE_RE.sub(" ", name).strip()
    return name or "playlist"


def resolve_playlist_name(
    url: str,
    *,
    overrides: dict[str, str] | None = None,
    name_cache: dict[str, dict] | None = None,
    safe: bool = False,
) -> tuple[str, str]:
    """Resolve a playlist URL to its display name.

    Precedence, highest first:

    1. ``playlist-overrides.json`` — the user said so explicitly.
    2. ``playlist-name-cache.json`` — Apple's own stored title.
    3. The URL slug — a guess, and the only source we are willing to override
       with whatever gamdl reports later.

    Returns ``(name, source)`` where source is ``override``/``cache``/``slug``.
    The caller needs the source to decide whether gamdl's own filename is allowed
    to win.
    """
    fallback = playlist_short_id(url)

    override = (overrides or {}).get(url)
    if isinstance(override, str) and override.strip():
        return sanitize_filename(override, fallback, safe=safe), "override"

    entry = (name_cache or {}).get(url)
    cached = entry.get("name") if isinstance(entry, dict) else entry
    if isinstance(cached, str) and cached.strip():
        return sanitize_filename(cached, fallback, safe=safe), "cache"

    return sanitize_filename(playlist_slug_from_url(url), fallback, safe=safe), "slug"


def uniquify(name: str, url: str, seen: set[str]) -> str:
    """Disambiguate names that collide case-insensitively.

    macOS APFS, Windows NTFS and exFAT all treat ``Jams`` and ``jams`` as the same
    file, so without this the second playlist silently overwrites the first.
    ``seen`` is mutated with the lowercased result and must be seeded from the
    names already on disk, not just from this cycle, or the suffix would flap
    between runs.
    """
    lowered = name.casefold()
    if lowered in seen:
        name = f"{name} ({playlist_short_id(url)})"
        lowered = name.casefold()
    seen.add(lowered)
    return name
