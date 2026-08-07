'use client'

/*
 * The client's whole view of the server.
 *
 * v1 called fetch() inline all over the page component, and three of those calls
 * had no error handling at all — a network blip produced an unhandled rejection
 * and a UI that silently did nothing. Everything goes through `request` here, so
 * a failure always has a message the caller can show.
 */

export interface PlaylistProgress {
  current: number
  total: number
}

export type PlaylistStatus = 'idle' | 'running' | 'complete' | 'partial' | 'failed'

export interface Playlist {
  url: string
  name: string
  status: PlaylistStatus
  songCount: number
  availableCount: number | null
  missingCount: number | null
  progress: PlaylistProgress | null
  lastDownloaded: string | null
  startedAt: string | null
  failedAt: string | null
  lastError: string
  playlistFile: string | null
}

export interface DownloaderState {
  alive: boolean
  state: string | null
  cycle: number | null
  lastHeartbeat: string | null
  detail: string
}

export interface CookieState {
  exists: boolean
  activeFile: string | null
  updatedAt: string | null
  /** ISO timestamp of the earliest cookie expiry, or null if none carry one. */
  soonestExpiry: string | null
  daysUntilExpiry: number | null
  expired: boolean
}

export interface StatusSummary {
  total: number
  idle: number
  running: number
  complete: number
  partial: number
  failed: number
  songs: number
}

export interface StatusSnapshot {
  playlists: Playlist[]
  summary: StatusSummary
  downloader: DownloaderState
  cookies: CookieState
  settings: {
    frequency: number
    outputLocation: string
    playlistM3uDir: string
    songCodec: string
    downloadMode: string
  }
}

export interface Settings {
  schemaVersion: number
  frequency: number
  outputLocation: string
  playlistM3uDir: string
  albumFolderTemplate: string
  compilationFolderTemplate: string
  noAlbumFolderTemplate: string
  singleDiscFileTemplate: string
  multiDiscFileTemplate: string
  noAlbumFileTemplate: string
  songCodec: string
  downloadMode: string
  language: string
  truncate: number | null
  overwrite: boolean
  downloadLyrics: boolean
  lyricsFormat: string
  saveCover: boolean
  coverFormat: string
  coverSize: number
  safeFilenames: boolean
  prunePlaylistEntries: boolean
  concurrency: number
  autoUpdate: boolean
  autoUpdateInterval: number
  autoUpdateGamdl: boolean
}

export class ApiError extends Error {
  readonly status: number
  readonly detail?: string

  constructor(message: string, status: number, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { cache: 'no-store', ...init })
  } catch {
    // A rejected fetch means the browser could not reach the server at all —
    // usually the container restarting. Say that, rather than "failed to fetch".
    throw new ApiError('Cannot reach the server. Is the container running?', 0)
  }

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; detail?: string }
    throw new ApiError(
      body.error || `Request failed (${response.status})`,
      response.status,
      body.detail,
    )
  }

  return payload as T
}

/*
 * The type argument to `request` is an assertion, not a check: nothing makes
 * TypeScript compare it against what the route hands back. Every shape below is
 * therefore copied from the route in app/api/**, which is the contract — a
 * declared key the route never sends reads as `undefined` at runtime, silently.
 */
export const api = {
  status: () => request<StatusSnapshot>('/api/status'),
  settings: () => request<Settings>('/api/settings'),

  /** The saved settings, flat, plus whether the daemon could be woken. */
  saveSettings: (settings: Partial<Settings>) =>
    request<Settings & { reloadRequested: boolean }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),

  addPlaylist: (url: string) =>
    request<{ url: string; name: string | null; syncRequested: boolean; detail?: string }>(
      '/api/playlists',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
    ),

  /** `removed` lists every stored spelling of the URL that was dropped. */
  removePlaylist: (url: string) =>
    request<{ removed: string[] }>('/api/playlists', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  resolveName: (url: string) =>
    request<{ url: string; name: string | null; songCount: number | null }>(
      '/api/playlists/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
    ),

  /** `scope` is the requested URLs, or the string 'all'. */
  sync: (urls?: string[]) =>
    request<{ requested: boolean; scope: string[] | 'all' }>('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(urls?.length ? { urls } : {}),
    }),

  cookies: () => request<CookieState>('/api/cookies'),

  uploadCookies: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ files: string[]; status: CookieState }>('/api/cookies', {
      method: 'POST',
      body: form,
    })
  },

  deleteCookies: () => request<{ removed: string[] }>('/api/cookies', { method: 'DELETE' }),

  logs: (lines = 300) =>
    request<{ logs: string; missing: boolean; lines?: number; message?: string; updatedAt: string }>(
      `/api/logs?lines=${lines}`,
    ),
}
