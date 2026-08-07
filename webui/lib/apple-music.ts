// Port of downloader/gamdl_sync/playlists.py (and the slug helper from
// naming.py). The two processes must agree on what counts as "the same
// playlist" or the UI will happily add a URL the daemon considers a duplicate.

// Case-sensitive on purpose: Apple's playlist ids are case-sensitive, and the
// daemon's regex has no IGNORECASE flag.
const PLAYLIST_ID_RE = /pl\.[A-Za-z0-9][A-Za-z0-9._-]*/

const APPLE_HOSTS = new Set(['music.apple.com', 'beta.music.apple.com', 'embed.music.apple.com'])

function parseLenient(text: string): URL | null {
  // Python's urlparse accepts scheme-less input; WHATWG URL does not, so retry
  // with the same https:// prefix playlists.py falls back to.
  try {
    const parsed = new URL(text)
    if (parsed.protocol) return parsed
  } catch {
    // fall through to the prefixed attempt
  }
  try {
    return new URL('https://' + text)
  } catch {
    return null
  }
}

export function normalizeUrl(url: string): string {
  let text = (url || '').trim()
  if (!text) return ''
  // urlparse splits query and fragment off; we drop them the same way.
  const hash = text.indexOf('#')
  if (hash >= 0) text = text.slice(0, hash)
  const query = text.indexOf('?')
  if (query >= 0) text = text.slice(0, query)

  const parsed = parseLenient(text)
  if (!parsed) return text

  let host = parsed.host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  const path = parsed.pathname.replace(/\/+$/, '')
  return `https://${host}${path}`
}

export function canonicalKey(url: string): string {
  // Only the pl.* id identifies a playlist; storefront and slug are noise. A
  // URL without an id falls back to its normalized form, so a URL that is a
  // strict prefix of another still produces a distinct key.
  const match = PLAYLIST_ID_RE.exec(url || '')
  if (match) return match[0]
  return normalizeUrl(url).toLowerCase()
}

export function isPlaylistUrl(url: string): boolean {
  const parsed = parseLenient(normalizeUrl(url))
  if (!parsed) return false
  if (!APPLE_HOSTS.has(parsed.host.toLowerCase())) return false
  const parts = parsed.pathname.split('/').filter(Boolean)
  return parts.includes('playlist') && PLAYLIST_ID_RE.test(url || '')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export interface ResolvedPlaylistMeta {
  name?: string
  songCount?: number
}

function cleanTitle(raw: string): string {
  // Apple pads page titles with invisible marks and a marketing suffix. The
  // suffix is separated by the word "on" as often as by a dash — og:title reads
  // "Today's Hits on Apple Music" — and matching only the dash form left the
  // suffix in the playlist's filename.
  const cleaned = raw
    .normalize('NFC')
    .replace(/[‎‏⁠﻿]/g, '')
    .replace(/\s*(?:[|–—-]|\bon\b)\s*Apple\s*Music\s*$/i, '')
    .replace(/\s*[–—-]\s*playlist\s+by\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Never let the stripping consume the whole name: a playlist really called
  // "Apple Music" should keep its name rather than become empty.
  return cleaned || raw.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/**
 * Pull a `<meta>` content value, matching the closing quote to the opening one.
 *
 * A naive `content=["']([^"']+)["']` stops at the first quote of *either* kind,
 * so `content="Today's Hits"` captured `Today`. Apostrophes are extremely common
 * in playlist titles, and the truncated value was cached and then used as the
 * on-disk filename.
 */
function matchMetaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<meta[^>]*\\b(?:property|name)=["']${escaped}["'][^>]*\\bcontent=(?:"([^"]*)"|'([^']*)')`,
    'i',
  )
  const match = html.match(pattern)
  if (!match) return undefined
  return match[1] ?? match[2]
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

/**
 * Decode the HTML entities Apple actually emits in a title.
 *
 * Without this, `Rock &amp; Roll` became a filename containing a literal
 * `&amp;`. `&amp;` is decoded last so `&amp;#39;` yields `'` rather than
 * re-entering the decoder — a double decode would let a crafted title smuggle
 * characters past the sanitizer.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  // Lone surrogates would produce an unpaired code unit that breaks JSON round-trips.
  if (code >= 0xd800 && code <= 0xdfff) return ''
  return String.fromCodePoint(code)
}

// The only place in the server layer allowed to talk to Apple. Called once
// when a playlist is added and on explicit re-resolve — never from a poll.
export async function fetchPlaylistMetadata(url: string, timeoutMs = 5000): Promise<ResolvedPlaylistMeta> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(normalizeUrl(url), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) return {}
    const html = await response.text()
    const ogTitle = matchMetaContent(html, 'og:title')
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    const name = cleanTitle(decodeEntities(ogTitle || titleTag || ''))
    const trackCountRaw = html.match(/"trackCount"\s*:\s*(\d{1,6})/)?.[1]
    const songCount = trackCountRaw ? Number(trackCountRaw) : undefined
    return {
      name: name || undefined,
      songCount: Number.isFinite(songCount) ? songCount : undefined,
    }
  } catch {
    // Resolution is a nicety; the slug name keeps working without it.
    return {}
  } finally {
    clearTimeout(timer)
  }
}

export function extractSlugName(url: string): string {
  // Port of naming.playlist_slug_from_url: a last-resort display name when
  // neither the daemon nor Apple has told us the real title yet.
  let raw = ''
  const parsed = parseLenient(normalizeUrl(url))
  if (parsed) {
    const parts = parsed.pathname.split('/').filter(Boolean)
    const index = parts.indexOf('playlist')
    if (index >= 0 && index + 1 < parts.length) {
      raw = safeDecode(parts[index + 1])
    }
  }
  if (!raw) return 'playlist'

  // Apple's ASCII slugs use hyphens as spaces; Unicode names keep their real
  // hyphens.
  if (/^[\x00-\x7F]*$/.test(raw)) {
    raw = raw.replace(/^m-/i, '').replace(/-/g, ' ')
  }
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim() || 'playlist'
}
