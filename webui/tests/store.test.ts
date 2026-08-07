import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// Redirect /config before lib/paths resolves its constants at import time.
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamdl-store-'))
process.env.CONFIG_DIR = tmpRoot

const { addPlaylistUrl, readNameCache, readPlaylistUrls, removePlaylistUrl, scanM3uDir, writeNameCacheEntry, writePlaylistUrls } =
  await import('../lib/store.ts')

const PLAYLISTS_FILE = path.join(tmpRoot, 'playlists.txt')

const HEADER = ['# Apple Music playlists, one per line.', '# Lines starting with # are ignored.', '']
const A = 'https://music.apple.com/us/playlist/chill/pl.aaaa1111'
const B = 'https://music.apple.com/us/playlist/focus/pl.bbbb2222'

test('writePlaylistUrls preserves the comment header', async () => {
  await fsp.writeFile(PLAYLISTS_FILE, [...HEADER, A].join('\n') + '\n', 'utf-8')
  await writePlaylistUrls([A, B])
  const text = await fsp.readFile(PLAYLISTS_FILE, 'utf-8')
  assert.equal(text, [...HEADER, A, B].join('\n') + '\n')
})

test('readPlaylistUrls skips comments, blanks and canonical duplicates', async () => {
  const sameAsA = 'https://music.apple.com/gb/playlist/other-slug/pl.aaaa1111?l=en-GB'
  await fsp.writeFile(PLAYLISTS_FILE, [...HEADER, A, '', sameAsA, B].join('\n') + '\n', 'utf-8')
  assert.deepEqual(await readPlaylistUrls(), [A, B])
})

test('addPlaylistUrl rejects duplicates by canonical key', async () => {
  await fsp.writeFile(PLAYLISTS_FILE, [...HEADER, A].join('\n') + '\n', 'utf-8')
  const dupe = await addPlaylistUrl('https://music.apple.com/de/playlist/anders/pl.aaaa1111')
  assert.equal(dupe.added, false)
  assert.equal(dupe.duplicate, A)
  const added = await addPlaylistUrl(B)
  assert.equal(added.added, true)
  assert.deepEqual(await readPlaylistUrls(), [A, B])
})

test('removePlaylistUrl removes by canonical key and reports what went', async () => {
  await fsp.writeFile(PLAYLISTS_FILE, [...HEADER, A, B].join('\n') + '\n', 'utf-8')
  const result = await removePlaylistUrl('https://music.apple.com/fr/playlist/x/pl.aaaa1111')
  assert.deepEqual(result.removed, [A])
  assert.deepEqual(await readPlaylistUrls(), [B])
  assert.deepEqual((await removePlaylistUrl(A)).removed, [])
})

test('name cache upgrades legacy string entries and merges writes', async () => {
  const cacheFile = path.join(tmpRoot, 'playlist-name-cache.json')
  await fsp.writeFile(cacheFile, JSON.stringify({ [A]: 'Old Style Name' }), 'utf-8')
  assert.deepEqual(await readNameCache(), { [A]: { name: 'Old Style Name' } })

  await writeNameCacheEntry(A, { songCount: 12 })
  assert.deepEqual(await readNameCache(), { [A]: { name: 'Old Style Name', songCount: 12 } })
})

test('scanM3uDir counts entries, reads #PLAYLIST and caches by mtime', async () => {
  const dir = path.join(tmpRoot, 'm3u')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'Chill.m3u8')
  await fsp.writeFile(file, '#EXTM3U\n#PLAYLIST:Chill Vibes\n#EXTINF:1,a\nA.m4a\nB.m4a\n', 'utf-8')

  const first = await scanM3uDir(dir)
  assert.equal(first.length, 1)
  assert.equal(first[0].songCount, 2)
  assert.equal(first[0].displayName, 'Chill Vibes')

  // Unchanged mtime+size must serve the cached object, not a re-read.
  const second = await scanM3uDir(dir)
  assert.equal(second[0], first[0])

  await fsp.writeFile(file, '#EXTM3U\nA.m4a\n', 'utf-8')
  const third = await scanM3uDir(dir)
  assert.equal(third[0].songCount, 1)
  assert.equal(third[0].displayName, null)
})
