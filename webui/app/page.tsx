"use client"

import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/card'
import { Button } from './components/button'
import { Input } from './components/input'
import { Badge } from './components/badge'
import { Switch } from './components/switch'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  HardDrive,
  Loader2,
  Monitor,
  Moon,
  Music2,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Sun,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react'

interface Playlist {
  id: number
  url: string
  name: string
  active: boolean
  songCount: number
  lastDownloaded: string | null
  status: 'idle' | 'running' | 'complete' | 'failed'
  startedAt?: string | null
  failedAt?: string | null
}

interface SettingsState {
  frequency: number
  outputLocation: string
  playlistM3uDir: string
  outputStructure: string
  fileFormat: string
  downloadLyrics: boolean
  lyricsFormat: string
  quality: string
  savePlaylist: boolean
  overwrite: boolean
  downloadMode: string
  autoUpdate: boolean
  autoUpdateInterval: number
}

type ThemeMode = 'light' | 'dark' | 'system'

interface CookieStatus {
  exists?: boolean
  activeFile?: string | null
  preferredFile?: string
  updatedAt?: string | null
}

interface LogsPayload {
  logs?: string
  statusSummary?: Record<string, number>
  updatedAt?: string
}

const defaultSettings: SettingsState = {
  frequency: 3600,
  outputLocation: '/data/music',
  playlistM3uDir: '/data/music/playlists',
  outputStructure: '{artist}/{album}/{title}',
  fileFormat: 'm4a',
  downloadLyrics: true,
  lyricsFormat: 'lrc',
  quality: 'high',
  savePlaylist: true,
  overwrite: false,
  downloadMode: 'nm3u8dlre',
  autoUpdate: true,
  autoUpdateInterval: 86400,
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusDot(status: Playlist['status']) {
  const colors: Record<string, string> = {
    running: 'bg-amber-400',
    complete: 'bg-emerald-500',
    failed: 'bg-rose-500',
    idle: 'bg-zinc-400 dark:bg-zinc-500',
  }
  return (
    <span className="relative flex h-2 w-2">
      {status === 'running' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colors[status] || colors.idle}`} />
    </span>
  )
}

function statusLabel(status: Playlist['status']) {
  const labels: Record<string, string> = {
    running: 'Syncing',
    complete: 'Synced',
    failed: 'Failed',
    idle: 'Idle',
  }
  return labels[status] || 'Idle'
}

function formatRelative(value: string | null) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

function formatFrequency(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [newPlaylistUrl, setNewPlaylistUrl] = useState('')
  const [activeTab, setActiveTab] = useState<'playlists' | 'settings'>('playlists')
  const [settings, setSettings] = useState<SettingsState>(defaultSettings)
  const [cookieStatus, setCookieStatus] = useState<CookieStatus>({})
  const [uploadingCookies, setUploadingCookies] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [logsText, setLogsText] = useState('')
  const [logsUpdatedAt, setLogsUpdatedAt] = useState<string | null>(null)
  const [logsSummary, setLogsSummary] = useState<Record<string, number>>({})
  const [isLogsLoading, setIsLogsLoading] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)

  // ---- Data fetching ----

  useEffect(() => {
    void fetchPlaylists()
    void fetchSettings()
    void fetchCookies()

    const storedTheme = localStorage.getItem('theme-mode') as ThemeMode | null
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      setThemeMode(storedTheme)
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      const resolved = themeMode === 'system' ? (mediaQuery.matches ? 'dark' : 'light') : themeMode
      root.classList.toggle('dark', resolved === 'dark')
    }

    localStorage.setItem('theme-mode', themeMode)
    applyTheme()

    if (themeMode === 'system') {
      mediaQuery.addEventListener('change', applyTheme)
      return () => mediaQuery.removeEventListener('change', applyTheme)
    }
  }, [themeMode])

  useEffect(() => {
    if (activeTab !== 'settings') return
    void fetchLogs()
    const timer = window.setInterval(() => void fetchLogs(), 20000)
    return () => window.clearInterval(timer)
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'playlists') return
    const timer = window.setInterval(() => void fetchPlaylists(), 8000)
    return () => window.clearInterval(timer)
  }, [activeTab])

  const summary = useMemo(() => ({
    count: playlists.length,
    syncing: playlists.filter((p) => p.status === 'running').length,
    totalSongs: playlists.reduce((sum, p) => sum + (p.songCount || 0), 0),
  }), [playlists])

  const flash = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text })
    setTimeout(() => setNotice(null), 3000)
  }

  // ---- API calls ----

  const fetchPlaylists = async () => {
    try {
      const response = await fetch('/api/playlists')
      const data = await response.json()
      setPlaylists(data.playlists || [])
    } catch {
      flash('error', 'Could not load playlists')
    }
  }

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings')
      const data = await response.json()
      setSettings({ ...defaultSettings, ...data })
    } catch {
      flash('error', 'Could not load settings')
    }
  }

  const fetchCookies = async () => {
    try {
      const response = await fetch('/api/cookies')
      const data = await response.json()
      setCookieStatus(data)
    } catch {
      setCookieStatus({ exists: false })
    }
  }

  const fetchLogs = async () => {
    setIsLogsLoading(true)
    try {
      const response = await fetch('/api/logs?lines=160', { cache: 'no-store' })
      const data: LogsPayload = await response.json()
      setLogsText(data.logs || '')
      setLogsSummary(data.statusSummary || {})
      setLogsUpdatedAt(data.updatedAt || null)
    } catch {
      setLogsText('Failed to load logs.')
    } finally {
      setIsLogsLoading(false)
    }
  }

  const addPlaylist = async () => {
    if (!newPlaylistUrl.trim()) return
    setIsLoading(true)
    try {
      const response = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newPlaylistUrl.trim() }),
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to add playlist' }))
        flash('error', error.error || 'Failed to add playlist')
        return
      }
      setNewPlaylistUrl('')
      flash('success', 'Playlist added')
      await fetchPlaylists()
    } finally {
      setIsLoading(false)
    }
  }

  const removePlaylist = async (url: string) => {
    const response = await fetch('/api/playlists', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!response.ok) {
      flash('error', 'Failed to remove playlist')
      return
    }
    flash('success', 'Playlist removed')
    await fetchPlaylists()
  }

  const triggerDownload = async () => {
    setIsDownloading(true)
    try {
      const response = await fetch('/api/download', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        flash('error', data.error || 'Failed to start downloader')
      } else {
        flash('success', data.message || 'Downloader restarted')
        await fetchPlaylists()
        await fetchLogs()
      }
    } catch {
      flash('error', 'Failed to start downloader')
    } finally {
      setIsDownloading(false)
    }
  }

  const saveSettings = async () => {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!response.ok) {
        flash('error', 'Failed to save settings')
        return
      }
      flash('success', 'Settings saved')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCookieUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    setUploadingCookies(true)
    try {
      const response = await fetch('/api/cookies', { method: 'POST', body: formData })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        flash('error', data.error || 'Failed to upload cookies')
        return
      }
      flash('success', 'Cookies uploaded')
      await fetchCookies()
    } finally {
      setUploadingCookies(false)
      event.target.value = ''
    }
  }

  // ---- Theme toggle ----

  const nextTheme = () => {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    setThemeMode(order[(order.indexOf(themeMode) + 1) % order.length])
  }
  const ThemeIcon = themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor

  // ---- Render ----

  return (
    <div className="min-h-screen bg-background">
      {/* ---- Toolbar ---- */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <Music2 className="h-5 w-5 text-foreground/80" />
            <span className="text-[15px] font-semibold tracking-tight">Gamdl</span>
          </div>

          <div className="flex items-center gap-1">
            {/* Tab switcher */}
            <div className="mr-2 flex rounded-lg border bg-muted/50 p-0.5">
              <button
                onClick={() => setActiveTab('playlists')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === 'playlists'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Playlists
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === 'settings'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Settings
              </button>
            </div>

            {/* Theme toggle */}
            <button
              onClick={nextTheme}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={`Theme: ${themeMode}`}
            >
              <ThemeIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        {/* ---- Toast ---- */}
        {notice && (
          <div
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
              notice.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300'
            }`}
          >
            {notice.type === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
            {notice.text}
          </div>
        )}

        {/* ============================================================ */}
        {/* PLAYLISTS TAB                                                 */}
        {/* ============================================================ */}
        {activeTab === 'playlists' ? (
          <>
            {/* ---- Stats row ---- */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border bg-card p-3.5">
                <p className="text-xs text-muted-foreground">Playlists</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.count}</p>
              </div>
              <div className="rounded-lg border bg-card p-3.5">
                <p className="text-xs text-muted-foreground">Total Songs</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.totalSongs.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border bg-card p-3.5">
                <p className="text-xs text-muted-foreground">Interval</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatFrequency(settings.frequency)}</p>
              </div>
            </div>

            {/* ---- Add playlist ---- */}
            <Card>
              <CardContent className="flex gap-2 pt-5 pb-5">
                <Input
                  value={newPlaylistUrl}
                  onChange={(e) => setNewPlaylistUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addPlaylist()}
                  placeholder="Paste Apple Music playlist URL..."
                  className="h-9 text-sm"
                />
                <Button onClick={addPlaylist} disabled={!newPlaylistUrl.trim() || isLoading} size="sm" className="h-9 shrink-0 gap-1.5">
                  {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Add
                </Button>
              </CardContent>
            </Card>

            {/* ---- Playlist list ---- */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base font-semibold">Library</CardTitle>
                <Button
                  onClick={triggerDownload}
                  disabled={isDownloading || playlists.length === 0}
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                >
                  {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Sync Now
                </Button>
              </CardHeader>
              <CardContent className="pt-0">
                {playlists.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
                    <Music2 className="mb-3 h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No playlists yet</p>
                    <p className="mt-1 text-xs text-muted-foreground/60">Add an Apple Music URL above to get started</p>
                  </div>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {playlists.map((playlist) => (
                      <div key={playlist.id} className="flex items-center gap-3 px-3.5 py-3">
                        {/* Status dot */}
                        <div className="flex shrink-0 items-center">{statusDot(playlist.status)}</div>

                        {/* Name + URL */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium leading-snug">{playlist.name}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{playlist.url}</p>
                        </div>

                        {/* Meta */}
                        <div className="hidden shrink-0 text-right sm:block">
                          <p className="text-xs tabular-nums text-muted-foreground">
                            {playlist.songCount ? `${playlist.songCount} songs` : ''}
                          </p>
                          <p className="text-xs text-muted-foreground/60">
                            {formatRelative(playlist.lastDownloaded)}
                          </p>
                        </div>

                        {/* Status label */}
                        <Badge
                          variant="secondary"
                          className={`hidden shrink-0 text-[11px] sm:inline-flex ${
                            playlist.status === 'running'
                              ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
                              : playlist.status === 'failed'
                              ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300'
                              : playlist.status === 'complete'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                              : ''
                          }`}
                        >
                          {statusLabel(playlist.status)}
                        </Badge>

                        {/* Delete */}
                        <button
                          onClick={() => removePlaylist(playlist.url)}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : (
          /* ============================================================ */
          /* SETTINGS TAB                                                  */
          /* ============================================================ */
          <>
            {/* ---- Cookie auth ---- */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Shield className="h-4 w-4 text-muted-foreground" /> Authentication
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`inline-flex h-2 w-2 rounded-full ${cookieStatus.exists ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
                  <span className="text-muted-foreground">
                    {cookieStatus.exists ? 'Cookie loaded' : 'No cookie file'}
                  </span>
                  {cookieStatus.updatedAt && (
                    <span className="text-xs text-muted-foreground/60">
                      Updated {formatRelative(cookieStatus.updatedAt)}
                    </span>
                  )}
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input className="hidden" type="file" accept=".txt" onChange={handleCookieUpload} />
                  <span className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted">
                    {uploadingCookies ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading...</>
                    ) : (
                      <><Upload className="h-3.5 w-3.5" /> Upload cookies.txt</>
                    )}
                  </span>
                </label>
              </CardContent>
            </Card>

            {/* ---- Downloader settings ---- */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Settings2 className="h-4 w-4 text-muted-foreground" /> Downloader
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                {/* Row: frequency + format */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Sync Interval (seconds)</label>
                    <Input
                      value={String(settings.frequency)}
                      onChange={(e) => setSettings({ ...settings, frequency: Number(e.target.value) || 3600 })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Format</label>
                    <div className="flex gap-1.5">
                      {['m4a', 'mp3', 'flac'].map((format) => (
                        <button
                          key={format}
                          onClick={() => setSettings({ ...settings, fileFormat: format })}
                          className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                            settings.fileFormat === format
                              ? 'border-foreground/20 bg-foreground text-background'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {format.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Row: output location */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Output Location</label>
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                    <Input
                      value={settings.outputLocation}
                      onChange={(e) => {
                        const outputLocation = e.target.value
                        const currentDefault = `${settings.outputLocation.replace(/\/$/, '')}/playlists`
                        const playlistM3uDir =
                          settings.playlistM3uDir === currentDefault
                            ? `${outputLocation.replace(/\/$/, '')}/playlists`
                            : settings.playlistM3uDir
                        setSettings({ ...settings, outputLocation, playlistM3uDir })
                      }}
                      className="h-9 font-mono text-xs"
                    />
                  </div>
                </div>

                {/* Row: playlist m3u dir */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Playlist M3U Folder</label>
                  <Input
                    value={settings.playlistM3uDir}
                    onChange={(e) => setSettings({ ...settings, playlistM3uDir: e.target.value })}
                    className="h-9 font-mono text-xs"
                  />
                </div>

                {/* Row: output structure */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Folder Structure</label>
                  <Input
                    value={settings.outputStructure}
                    onChange={(e) => setSettings({ ...settings, outputStructure: e.target.value })}
                    className="h-9 font-mono text-xs"
                  />
                </div>

                {/* Row: download mode */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Download Engine</label>
                  <div className="flex gap-1.5">
                    {[
                      { value: 'nm3u8dlre', label: 'N_m3u8DL-RE' },
                      { value: 'ffmpeg', label: 'FFmpeg' },
                    ].map((mode) => (
                      <button
                        key={mode.value}
                        onClick={() => setSettings({ ...settings, downloadMode: mode.value })}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                          settings.downloadMode === mode.value
                            ? 'border-foreground/20 bg-foreground text-background'
                            : 'border-border bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Toggles */}
                <div className="space-y-3 rounded-lg border p-3.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Auto-update tools</p>
                      <p className="text-xs text-muted-foreground">Keep gamdl and N_m3u8DL-RE current</p>
                    </div>
                    <Switch
                      checked={settings.autoUpdate}
                      onCheckedChange={(checked) => setSettings({ ...settings, autoUpdate: checked })}
                    />
                  </div>
                  {settings.autoUpdate && (
                    <div className="flex items-center justify-between border-t pt-3">
                      <label className="text-xs text-muted-foreground">Update interval</label>
                      <Input
                        value={String(settings.autoUpdateInterval)}
                        onChange={(e) => setSettings({ ...settings, autoUpdateInterval: Number(e.target.value) || 86400 })}
                        className="h-7 w-24 text-right font-mono text-xs"
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ---- Save bar ---- */}
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => void fetchSettings()} className="h-8 gap-1.5 text-xs">
                <RefreshCw className="h-3.5 w-3.5" /> Reset
              </Button>
              <Button size="sm" onClick={saveSettings} disabled={isSaving} className="h-8 gap-1.5 text-xs">
                {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Save
              </Button>
            </div>

            {/* ---- Logs ---- */}
            <Card>
              <CardHeader className="pb-2">
                <button
                  onClick={() => { setLogsExpanded(!logsExpanded); if (!logsExpanded) void fetchLogs() }}
                  className="flex w-full items-center justify-between"
                >
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Terminal className="h-4 w-4 text-muted-foreground" /> Logs
                  </CardTitle>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${logsExpanded ? 'rotate-180' : ''}`} />
                </button>
              </CardHeader>
              {logsExpanded && (
                <CardContent className="space-y-3 pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">{logsSummary.complete || 0} synced</span>
                      <span className="text-border">/</span>
                      <span className="tabular-nums">{logsSummary.running || 0} active</span>
                      <span className="text-border">/</span>
                      <span className="tabular-nums">{logsSummary.failed || 0} failed</span>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      {logsUpdatedAt && (
                        <span className="text-xs text-muted-foreground/50">
                          {new Date(logsUpdatedAt).toLocaleTimeString()}
                        </span>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => void fetchLogs()} disabled={isLogsLoading} className="h-7 w-7 p-0">
                        <RefreshCw className={`h-3.5 w-3.5 ${isLogsLoading ? 'animate-spin' : ''}`} />
                      </Button>
                    </div>
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {logsText || 'No logs available.'}
                  </pre>
                </CardContent>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  )
}
