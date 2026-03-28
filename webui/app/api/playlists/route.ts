import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR || '/config'
const PLAYLISTS_FILE = path.join(CONFIG_DIR, 'playlists.txt')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
const STATUS_FILE = path.join(CONFIG_DIR, 'playlist-status.json')
const NAME_CACHE_FILE = path.join(CONFIG_DIR, 'playlist-name-cache.json')

type PlaylistStatus = 'idle' | 'running' | 'complete' | 'failed'

interface StatusEntry {
  status?: PlaylistStatus
  lastDownloaded?: string | null
  songCount?: number
  startedAt?: string | null
  failedAt?: string | null
  playlistFile?: string | null
}

interface M3uStat {
  fileName: string
  key: string
  songCount: number
  mtime: string | null
  displayName: string | null
}

interface CacheEntry {
  name?: string
  songCount?: number
}

function normalizeKey(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/[\s\-_]/g, '')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function getPlaylistM3uDir(): Promise<string> {
  const raw = await fs.readFile(SETTINGS_FILE, 'utf-8').catch(() => '')
  if (!raw) return '/data/music/playlists'
  try {
    const parsed = JSON.parse(raw)
    return parsed.playlistM3uDir || '/data/music/playlists'
  } catch {
    return '/data/music/playlists'
  }
}

async function readStatusMap(): Promise<Record<string, StatusEntry>> {
  const raw = await fs.readFile(STATUS_FILE, 'utf-8').catch(() => '')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function readNameCache(): Promise<Record<string, CacheEntry>> {
  const raw = await fs.readFile(NAME_CACHE_FILE, 'utf-8').catch(() => '')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    const normalized: Record<string, CacheEntry> = {}
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === 'string') {
        normalized[key] = { name: value }
      } else if (value && typeof value === 'object') {
        const entry = value as CacheEntry
        normalized[key] = {
          name: typeof entry.name === 'string' ? entry.name : undefined,
          songCount: Number.isFinite(Number(entry.songCount)) ? Number(entry.songCount) : undefined,
        }
      }
    }
    return normalized
  } catch {
    return {}
  }
}

async function writeNameCache(cache: Record<string, CacheEntry>) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(NAME_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8')
}

async function buildM3uStats(playlistM3uDir: string): Promise<M3uStat[]> {
  const files = await fs.readdir(playlistM3uDir).catch(() => [])
  const m3uFiles = files.filter((file) => file.endsWith('.m3u') || file.endsWith('.m3u8'))

  const stats = await Promise.all(
    m3uFiles.map(async (fileName) => {
      const filePath = path.join(playlistM3uDir, fileName)
      const content = await fs.readFile(filePath, 'utf-8').catch(() => '')
      const fileStats = await fs.stat(filePath).catch(() => null)
      const songCount = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')).length

      const playlistTag = content
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.toUpperCase().startsWith('#PLAYLIST:'))

      const displayName = playlistTag
        ? playlistTag.slice('#PLAYLIST:'.length).trim()
        : safeDecode(fileName.replace(/\.m3u8?$/i, '')).trim()

      return {
        fileName,
        key: normalizeKey(fileName.replace(/\.m3u8?$/i, '')),
        songCount,
        mtime: fileStats?.mtime?.toISOString?.() || null,
        displayName: displayName || null,
      }
    })
  )

  return stats
}

function needsResolvedName(name: string) {
  const normalized = name.trim().toLowerCase()
  return !normalized || normalized === 'unknown playlist' || normalized.startsWith('pl.u ')
}

function sanitizePlaylistName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/\s*[|-]\s*Apple Music.*$/i, '')
    .replace(/\s+by\s+.*$/i, '')
    .replace(/^m\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchPlaylistMetadataFromWeb(url: string): Promise<CacheEntry> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) return {}

    const html = await response.text()
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1]
    const titleTag = html.match(/<title>([^<]+)<\/title>/i)?.[1]
    const candidate = sanitizePlaylistName(ogTitle || titleTag || '')
    const trackCountRaw = html.match(/"trackCount"\s*:\s*(\d{1,6})/i)?.[1]
    const songCount = trackCountRaw ? Number(trackCountRaw) : undefined
    return {
      name: candidate && !/^pl\.u[-\s]/i.test(candidate) ? candidate : undefined,
      songCount: Number.isFinite(songCount) ? songCount : undefined,
    }
  } catch {
    return {}
  } finally {
    clearTimeout(timeout)
  }
}

export async function GET() {
  try {
    const [content, statusMap, playlistM3uDir, nameCache] = await Promise.all([
      fs.readFile(PLAYLISTS_FILE, 'utf-8').catch(() => ''),
      readStatusMap(),
      getPlaylistM3uDir(),
      readNameCache(),
    ])

    const lines = content.split('\n').filter((line) => line.trim() && !line.startsWith('#'))
    const m3uStats = await buildM3uStats(playlistM3uDir)

    const playlists = lines.map((line, index) => {
      const url = line.trim()
      const extractedName = sanitizePlaylistName(extractPlaylistName(url))
      const cacheEntry = nameCache[url] || {}
      const cachedName = sanitizePlaylistName(cacheEntry.name || '')
      const name = cachedName || extractedName
      const lookupKey = normalizeKey(name)
      const statusEntry = statusMap[url] || {}
      const statusFileBase = (statusEntry.playlistFile || '').split('/').pop() || ''

      const matched =
        m3uStats.find((entry) => statusFileBase && entry.fileName === statusFileBase) ||
        m3uStats.find((entry) => entry.key.includes(lookupKey) || lookupKey.includes(entry.key)) ||
        null

      return {
        id: index,
        url,
        name: sanitizePlaylistName(matched?.displayName || name),
        active: true,
        songCount: Number(statusEntry.songCount ?? cacheEntry.songCount ?? matched?.songCount ?? 0),
        lastDownloaded: statusEntry.lastDownloaded || matched?.mtime || null,
        status: statusEntry.status || 'idle',
        startedAt: statusEntry.startedAt || null,
        failedAt: statusEntry.failedAt || null,
      }
    })

    const unresolved = playlists.filter((playlist) => needsResolvedName(playlist.name) || (playlist.songCount || 0) === 0)
    if (unresolved.length > 0) {
      let cacheUpdated = false
      await Promise.all(
        unresolved.map(async (playlist) => {
          const fetched = await fetchPlaylistMetadataFromWeb(playlist.url)
          const currentCache = nameCache[playlist.url] || {}
          const merged: CacheEntry = {
            name: fetched.name || currentCache.name,
            songCount: fetched.songCount ?? currentCache.songCount,
          }

          if (merged.name && needsResolvedName(playlist.name)) {
            playlist.name = sanitizePlaylistName(merged.name)
          }
          if ((playlist.songCount || 0) === 0 && Number.isFinite(Number(merged.songCount))) {
            playlist.songCount = Number(merged.songCount)
          }

          if (merged.name || Number.isFinite(Number(merged.songCount))) {
            nameCache[playlist.url] = merged
            cacheUpdated = true
          }
        })
      )
      if (cacheUpdated) {
        await writeNameCache(nameCache)
      }
    }

    return NextResponse.json({ playlists })
  } catch (error) {
    return NextResponse.json({ playlists: [] }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { url } = await request.json()
    
    if (!url || !url.includes('music.apple.com')) {
      return NextResponse.json(
        { error: 'Invalid Apple Music URL' },
        { status: 400 }
      )
    }
    
    let content = await fs.readFile(PLAYLISTS_FILE, 'utf-8').catch(() => '')
    
    if (content.includes(url)) {
      return NextResponse.json(
        { error: 'Playlist already exists' },
        { status: 409 }
      )
    }
    
    content = content.trim() + '\n' + url + '\n'
    await fs.writeFile(PLAYLISTS_FILE, content, 'utf-8')

    return NextResponse.json({ success: true, url })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to add playlist' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: Request) {
  try {
    const { url } = await request.json()
    
    let content = await fs.readFile(PLAYLISTS_FILE, 'utf-8').catch(() => '')
    const lines = content.split('\n').filter((line) => line.trim() !== url)

    await fs.writeFile(PLAYLISTS_FILE, lines.join('\n') + '\n', 'utf-8')

    const statusMap = await readStatusMap()
    if (statusMap[url]) {
      delete statusMap[url]
      await fs.writeFile(STATUS_FILE, JSON.stringify(statusMap, null, 2), 'utf-8')
    }
    
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to remove playlist' },
      { status: 500 }
    )
  }
}

function isAsciiSlug(value: string): boolean {
  // Returns true if the string only contains ASCII characters (URL slug)
  return /^[\x00-\x7F]+$/.test(value)
}

function extractPlaylistName(url: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const playlistIndex = parts.findIndex((segment) => segment === 'playlist')
    const slugPart = playlistIndex >= 0 ? parts[playlistIndex + 1] : ''
    if (slugPart) {
      const decoded = safeDecode(slugPart).normalize('NFC')
      // Only dehyphenate ASCII slugs; preserve Unicode/emoji names as-is
      if (isAsciiSlug(decoded)) {
        return decoded
          .replace(/^m-/i, '')
          .replace(/-/g, ' ')
          .replace(/\+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }
      // Non-ASCII: keep the original characters intact
      return decoded.replace(/\s+/g, ' ').trim()
    }
  } catch {
    // fallback below
  }

  const match = url.match(/playlist\/([^/?#]+)/)
  if (!match) return 'Unknown Playlist'
  const decoded = safeDecode(match[1]).normalize('NFC')
  if (isAsciiSlug(decoded)) {
    return decoded
      .replace(/^m-/i, '')
      .replace(/-/g, ' ')
      .replace(/\+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown Playlist'
  }
  return decoded.replace(/\s+/g, ' ').trim() || 'Unknown Playlist'
}
