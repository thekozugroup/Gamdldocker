// Readers and writers for the state the daemon shares through /config, plus
// the mtime-cached m3u scanner the dashboard endpoints lean on. Everything
// here is filesystem-only; nothing may reach out to the network.
import fsp from 'fs/promises'
import path from 'path'
// Relative .ts imports (not '@/lib/...') so these modules also load under
// node --test's type stripping, which does not resolve tsconfig path aliases.
import {
  APPLE_COOKIES_FILE,
  COOKIES_FILE,
  HEARTBEAT_FILE,
  NAME_CACHE_FILE,
  PLAYLISTS_FILE,
  STATUS_FILE,
} from './paths.ts'
import { atomicWriteJson, atomicWriteText, readJson, withFileLock } from './fsx.ts'
import { canonicalKey, extractSlugName } from './apple-music.ts'

export interface StatusEntry {
  status?: string
  name?: string
  playlistFile?: string
  songCount?: number
  availableCount?: number
  missingCount?: number
  durationSeconds?: number
  lastError?: string
  lastDownloaded?: string
  failedAt?: string
  startedAt?: string
  progress?: { current: number; total: number }
}

export interface NameCacheEntry {
  name?: string
  songCount?: number
}

export interface Heartbeat {
  ts?: number
  iso?: string
  pid?: number
  state?: string
  cycle?: number
  detail?: string
}

export async function readStatusMap(): Promise<Record<string, StatusEntry>> {
  const data = await readJson<unknown>(STATUS_FILE, {})
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const out: Record<string, StatusEntry> = {}
  for (const [url, entry] of Object.entries(data as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[url] = entry as StatusEntry
  }
  return out
}

export async function removeStatusEntry(url: string): Promise<void> {
  await withFileLock(STATUS_FILE, async () => {
    const data = await readStatusMap()
    if (url in data) {
      delete data[url]
      await atomicWriteJson(STATUS_FILE, data)
    }
  })
}

export async function readNameCache(): Promise<Record<string, NameCacheEntry>> {
  const raw = await readJson<unknown>(NAME_CACHE_FILE, {})
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, NameCacheEntry> = {}
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    // Legacy files stored a bare string per URL; upgrade on read like NameCache.
    if (typeof value === 'string') out[url] = { name: value }
    else if (value && typeof value === 'object' && !Array.isArray(value)) out[url] = value as NameCacheEntry
  }
  return out
}

export async function writeNameCacheEntry(url: string, entry: NameCacheEntry): Promise<void> {
  await withFileLock(NAME_CACHE_FILE, async () => {
    const data = await readNameCache()
    const merged = { ...(data[url] || {}) }
    if (entry.name !== undefined) merged.name = entry.name
    if (entry.songCount !== undefined) merged.songCount = entry.songCount
    data[url] = merged
    // 0600 to match NameCache.set_name: not secret, but it lives beside
    // cookies.txt and inherits the same posture.
    await atomicWriteJson(NAME_CACHE_FILE, data, 0o600)
  })
}

export async function readHeartbeat(): Promise<Heartbeat> {
  const data = await readJson<unknown>(HEARTBEAT_FILE, {})
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  return data as Heartbeat
}

// Matches the doctor's "daemon" check: a heartbeat older than this means the
// loop is stuck or the container is down.
export const HEARTBEAT_STALE_SECONDS = 120

export function heartbeatAlive(beat: Heartbeat, now = Date.now()): boolean {
  const ts = Number(beat.ts)
  if (!Number.isFinite(ts) || ts <= 0) return false
  return now / 1000 - ts < HEARTBEAT_STALE_SECONDS
}

// --------------------------------------------------------------------------
// playlists.txt
// --------------------------------------------------------------------------

export async function readPlaylistUrls(): Promise<string[]> {
  let text: string
  try {
    text = await fsp.readFile(PLAYLISTS_FILE, 'utf-8')
  } catch {
    return []
  }
  const seen = new Set<string>()
  const urls: string[] = []
  for (const line of text.split('\n')) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#')) continue
    const key = canonicalKey(stripped)
    if (seen.has(key)) continue
    seen.add(key)
    urls.push(stripped)
  }
  return urls
}

export async function writePlaylistUrls(urls: string[]): Promise<void> {
  await withFileLock(PLAYLISTS_FILE, async () => {
    await writePlaylistUrlsLocked(urls)
  })
}

// Split out so add/remove can do read-check-write under one lock acquisition.
async function writePlaylistUrlsLocked(urls: string[]): Promise<void> {
  // Preserve the leading comment block so the header the file ships with is
  // not eaten the first time someone adds a playlist from the UI.
  const header: string[] = []
  try {
    const text = await fsp.readFile(PLAYLISTS_FILE, 'utf-8')
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('#') || !line.trim()) header.push(line)
      else break
    }
  } catch {
    // no existing file, no header to keep
  }
  const body = [...header, ...urls].join('\n')
  await atomicWriteText(PLAYLISTS_FILE, body.replace(/\n+$/, '') + '\n')
}

export async function addPlaylistUrl(url: string): Promise<{ added: boolean; duplicate?: string }> {
  return withFileLock(PLAYLISTS_FILE, async () => {
    const urls = await readPlaylistUrls()
    const key = canonicalKey(url)
    const existing = urls.find((u) => canonicalKey(u) === key)
    if (existing) return { added: false, duplicate: existing }
    await writePlaylistUrlsLocked([...urls, url])
    return { added: true }
  })
}

export async function removePlaylistUrl(url: string): Promise<{ removed: string[] }> {
  return withFileLock(PLAYLISTS_FILE, async () => {
    const urls = await readPlaylistUrls()
    const key = canonicalKey(url)
    const removed = urls.filter((u) => u === url || canonicalKey(u) === key)
    if (!removed.length) return { removed: [] }
    await writePlaylistUrlsLocked(urls.filter((u) => !removed.includes(u)))
    return { removed }
  })
}

// --------------------------------------------------------------------------
// m3u scanner
// --------------------------------------------------------------------------

export interface M3uInfo {
  fileName: string
  songCount: number
  mtime: string | null
  displayName: string | null
}

interface M3uCacheSlot {
  stamp: string
  info: M3uInfo
}

// Keyed on absolute file path; validated per request against mtime + size so a
// poll only re-reads the files that actually changed since the last poll.
const m3uCache = new Map<string, M3uCacheSlot>()

export async function scanM3uDir(dir: string): Promise<M3uInfo[]> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const m3uNames = names.filter((n) => n.endsWith('.m3u') || n.endsWith('.m3u8'))
  const live = new Set<string>()

  const infos = await Promise.all(
    m3uNames.map(async (fileName) => {
      const filePath = path.join(dir, fileName)
      live.add(filePath)
      const stat = await fsp.stat(filePath).catch(() => null)
      if (!stat || !stat.isFile()) return null
      const stamp = `${stat.mtimeMs}:${stat.size}`
      const cached = m3uCache.get(filePath)
      if (cached && cached.stamp === stamp) return cached.info

      const content = await fsp.readFile(filePath, 'utf-8').catch(() => '')
      const lines = content.split('\n').map((l) => l.trim())
      const songCount = lines.filter((l) => l && !l.startsWith('#')).length
      const playlistTag = lines.find((l) => l.toUpperCase().startsWith('#PLAYLIST:'))
      const info: M3uInfo = {
        fileName,
        songCount,
        mtime: stat.mtime.toISOString(),
        displayName: playlistTag ? playlistTag.slice('#PLAYLIST:'.length).trim() || null : null,
      }
      m3uCache.set(filePath, { stamp, info })
      return info
    })
  )

  // Drop cache entries for files that vanished so the map cannot grow forever.
  for (const key of Array.from(m3uCache.keys())) {
    if (key.startsWith(dir + path.sep) && !live.has(key)) m3uCache.delete(key)
  }

  return infos.filter((i): i is M3uInfo => i !== null)
}

// --------------------------------------------------------------------------
// Cookies
// --------------------------------------------------------------------------

export interface CookieStatus {
  exists: boolean
  activeFile: string | null
  updatedAt: string | null
  soonestExpiry: string | null
  daysUntilExpiry: number | null
  expired: boolean
}

// Port of doctor._soonest_expiry: earliest non-session expiry in a Netscape
// cookie jar, expressed in epoch seconds.
export function soonestExpiry(netscapeText: string): number | null {
  let soonest: number | null = null
  for (const line of netscapeText.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    const fields = line.split('\t')
    if (fields.length < 7) continue
    const expiry = Number(fields[4])
    if (!Number.isFinite(expiry)) continue
    if (expiry <= 0) continue
    soonest = soonest === null ? expiry : Math.min(soonest, expiry)
  }
  return soonest
}

export async function readCookieStatus(): Promise<CookieStatus> {
  // Same candidate order as doctor._check_cookies.
  for (const [file, label] of [
    [COOKIES_FILE, 'cookies.txt'],
    [APPLE_COOKIES_FILE, 'music.apple.com_cookies.txt'],
  ] as const) {
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) continue
    const text = await fsp.readFile(file, 'utf-8').catch(() => '')
    const expiry = soonestExpiry(text)
    const days = expiry === null ? null : (expiry - Date.now() / 1000) / 86400
    return {
      exists: true,
      activeFile: label,
      updatedAt: stat.mtime.toISOString(),
      soonestExpiry: expiry === null ? null : new Date(expiry * 1000).toISOString(),
      daysUntilExpiry: days === null ? null : Math.floor(days),
      expired: days !== null && days < 0,
    }
  }
  return {
    exists: false,
    activeFile: null,
    updatedAt: null,
    soonestExpiry: null,
    daysUntilExpiry: null,
    expired: false,
  }
}

// --------------------------------------------------------------------------
// Dashboard snapshot pieces
// --------------------------------------------------------------------------

export interface PlaylistView {
  url: string
  name: string
  status: string
  songCount: number
  availableCount: number | null
  missingCount: number | null
  lastDownloaded: string | null
  startedAt: string | null
  failedAt: string | null
  lastError: string
  progress: { current: number; total: number } | null
  playlistFile: string | null
}

export async function buildPlaylistViews(playlistM3uDir: string): Promise<PlaylistView[]> {
  const [urls, statusMap, nameCache, m3uInfos] = await Promise.all([
    readPlaylistUrls(),
    readStatusMap(),
    readNameCache(),
    scanM3uDir(playlistM3uDir),
  ])

  return urls.map((url) => {
    const entry = statusMap[url] || {}
    const cache = nameCache[url] || {}
    const name = entry.name || cache.name || extractSlugName(url)

    const statusFileBase = (entry.playlistFile || '').split('/').pop() || ''
    const matched =
      (statusFileBase && m3uInfos.find((m) => m.fileName === statusFileBase)) ||
      m3uInfos.find((m) => m.fileName.replace(/\.m3u8?$/, '').toLowerCase() === name.toLowerCase()) ||
      null

    return {
      url,
      name,
      status: entry.status || 'idle',
      songCount: Number(entry.songCount ?? cache.songCount ?? matched?.songCount ?? 0),
      availableCount: entry.availableCount ?? null,
      missingCount: entry.missingCount ?? null,
      lastDownloaded: entry.lastDownloaded || matched?.mtime || null,
      startedAt: entry.startedAt || null,
      failedAt: entry.failedAt || null,
      lastError: entry.lastError || '',
      progress: entry.progress || null,
      playlistFile: entry.playlistFile || null,
    }
  })
}
