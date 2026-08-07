import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalKey,
  extractSlugName,
  fetchPlaylistMetadata,
  isPlaylistUrl,
  normalizeUrl,
} from '../lib/apple-music.ts'

const PL = 'pl.u-2aoq8mDCLqmqK1'
const CATALOG = 'pl.f4d106fed2bd41149aaacabb233eb5eb'

test('normalizeUrl strips query, fragment, www and trailing slashes', () => {
  assert.equal(
    normalizeUrl(`https://music.apple.com/us/playlist/chill/${PL}?i=123&l=en-US#section`),
    `https://music.apple.com/us/playlist/chill/${PL}`
  )
  assert.equal(
    normalizeUrl(`https://www.Music.Apple.com/us/playlist/chill/${PL}///`),
    `https://music.apple.com/us/playlist/chill/${PL}`
  )
})

test('normalizeUrl forces https and tolerates a missing scheme', () => {
  assert.equal(
    normalizeUrl(`http://music.apple.com/us/playlist/chill/${PL}`),
    `https://music.apple.com/us/playlist/chill/${PL}`
  )
  assert.equal(
    normalizeUrl(`music.apple.com/us/playlist/chill/${PL}`),
    `https://music.apple.com/us/playlist/chill/${PL}`
  )
  assert.equal(normalizeUrl(''), '')
  assert.equal(normalizeUrl('   '), '')
})

test('canonicalKey: the pl.* id is the identity', () => {
  const a = `https://music.apple.com/us/playlist/chill-mix/${PL}`
  const b = `https://music.apple.com/gb/playlist/anything-goes/${PL}?l=en-GB`
  assert.equal(canonicalKey(a), canonicalKey(b))
  assert.equal(canonicalKey(a), PL)
})

test('canonicalKey: ids are case-sensitive', () => {
  const lower = `https://music.apple.com/us/playlist/x/pl.u-abcdef`
  const upper = `https://music.apple.com/us/playlist/x/pl.u-ABCDEF`
  assert.notEqual(canonicalKey(lower), canonicalKey(upper))
})

test('canonicalKey: a URL that is a prefix of another is NOT a duplicate', () => {
  const short = 'https://music.apple.com/us/playlist/mix/pl.abc'
  const long = 'https://music.apple.com/us/playlist/mix/pl.abc123'
  assert.notEqual(canonicalKey(short), canonicalKey(long))
})

test('canonicalKey falls back to the lowercased normalized URL without an id', () => {
  assert.equal(
    canonicalKey('https://Music.Apple.com/us/browse/Top?x=1'),
    'https://music.apple.com/us/browse/top'
  )
})

test('isPlaylistUrl accepts playlist URLs on every Apple host', () => {
  for (const host of ['music.apple.com', 'beta.music.apple.com', 'embed.music.apple.com']) {
    assert.equal(isPlaylistUrl(`https://${host}/us/playlist/chill/${PL}`), true, host)
  }
  assert.equal(isPlaylistUrl(`https://www.music.apple.com/de/playlist/chill/${CATALOG}`), true)
})

test('isPlaylistUrl rejects non-playlist Apple URLs', () => {
  assert.equal(isPlaylistUrl('https://music.apple.com/us/album/thriller/269572838'), false)
  assert.equal(isPlaylistUrl('https://music.apple.com/us/song/beat-it/269573364'), false)
  assert.equal(isPlaylistUrl('https://music.apple.com/us/artist/queen/3296287'), false)
  // The path says playlist but there is no pl.* id.
  assert.equal(isPlaylistUrl('https://music.apple.com/us/playlist/chill/12345'), false)
})

test('isPlaylistUrl rejects non-Apple hosts and junk', () => {
  assert.equal(isPlaylistUrl(`https://open.spotify.com/playlist/${PL}`), false)
  assert.equal(isPlaylistUrl(`https://evil.example.com/music.apple.com/playlist/${PL}`), false)
  assert.equal(isPlaylistUrl('not a url at all'), false)
  assert.equal(isPlaylistUrl(''), false)
})

test('extractSlugName de-hyphenates ASCII slugs and strips the m- prefix', () => {
  assert.equal(extractSlugName(`https://music.apple.com/us/playlist/chill-mix-2024/${PL}`), 'chill mix 2024')
  assert.equal(extractSlugName(`https://music.apple.com/us/playlist/m-rock-classics/${PL}`), 'rock classics')
})

test('extractSlugName leaves Unicode slugs intact', () => {
  const url = `https://music.apple.com/us/playlist/${encodeURIComponent('🪨+roll')}/${PL}`
  assert.equal(extractSlugName(url), '🪨+roll')
})

test('extractSlugName falls back to "playlist"', () => {
  assert.equal(extractSlugName('https://music.apple.com/us/browse'), 'playlist')
  assert.equal(extractSlugName(''), 'playlist')
})

/**
 * Drives the real fetchPlaylistMetadata with a stubbed response, so the parsing
 * under test is the parsing that ships.
 */
async function titleFrom(html: string): Promise<string | undefined> {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
  try {
    const meta = await fetchPlaylistMetadata('https://music.apple.com/us/playlist/x/pl.u-AAA')
    return meta.name
  } finally {
    globalThis.fetch = original
  }
}

// --------------------------------------------------------------------------
// Title extraction — the value here becomes the on-disk filename
// --------------------------------------------------------------------------

test('an apostrophe in the title is not a truncation point', async () => {
  // `content=["']([^"']+)["']` captured just "Today". Apostrophes are common
  // enough in playlist names that this shipped as a silent rename.
  const html = `<meta property="og:title" content="Today's Hits on Apple Music">`
  assert.equal(await titleFrom(html), "Today's Hits")
})

test('named entities are decoded', async () => {
  const html = `<meta property="og:title" content="Rock &amp; Roll on Apple Music">`
  assert.equal(await titleFrom(html), 'Rock & Roll')
})

test('numeric entities are decoded', async () => {
  const html = `<meta property="og:title" content="90&#39;s Classics on Apple Music">`
  assert.equal(await titleFrom(html), "90's Classics")
})

test('hex entities are decoded, including emoji', async () => {
  const html = `<meta property="og:title" content="&#x1F3B5; Mix on Apple Music">`
  assert.equal(await titleFrom(html), '🎵 Mix')
})

test('a double-encoded entity decodes exactly once', async () => {
  // &amp;#39; must yield the literal text "&#39;", not an apostrophe — a second
  // pass would let a crafted title smuggle characters past the sanitizer.
  const html = `<meta property="og:title" content="A&amp;#39;B on Apple Music">`
  assert.equal(await titleFrom(html), 'A&#39;B')
})

test('single-quoted content attributes still work', async () => {
  const html = `<meta property='og:title' content='Chill "Vibes" on Apple Music'>`
  assert.equal(await titleFrom(html), 'Chill "Vibes"')
})

test('a lone surrogate is dropped rather than emitted', async () => {
  const html = `<meta property="og:title" content="Bad&#xD800; Mix on Apple Music">`
  assert.equal(await titleFrom(html), 'Bad Mix')
})

test('falls back to the title tag when og:title is absent', async () => {
  assert.equal(await titleFrom('<title>Deep Focus on Apple Music</title>'), 'Deep Focus')
})
