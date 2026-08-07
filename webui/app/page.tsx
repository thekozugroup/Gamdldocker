'use client'

import * as React from 'react'
import { Loader2, Music2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { PlaylistRow } from '@/components/playlist-row'
import { StatTile } from '@/components/stat-tile'
import { SetupChecklist } from '@/components/setup-checklist'
import { api, ApiError } from '@/lib/api'
import { useStatus } from '@/hooks/use-status'
import { formatInterval } from '@/lib/format'

export default function LibraryPage() {
  const { data, error, loading, refresh, mutate } = useStatus()
  const [url, setUrl] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [syncing, setSyncing] = React.useState(false)

  const playlists = data?.playlists ?? []
  const summary = data?.summary

  const addPlaylist = async () => {
    const trimmed = url.trim()
    if (!trimmed || adding) return
    setAdding(true)
    try {
      const result = await api.addPlaylist(trimmed)
      setUrl('')
      toast.success(result.name ? `Added “${result.name}”` : 'Playlist added', {
        // The route reports whether it managed to wake the downloader. Claiming
        // a sync started when it did not is how someone ends up waiting an hour
        // wondering why nothing happened.
        description: result.syncRequested
          ? 'Starting a sync now.'
          : result.detail || 'It will sync on the next scheduled cycle.',
      })
      await refresh()
    } catch (err) {
      toast.error('Could not add that playlist', {
        description:
          err instanceof ApiError
            ? err.message
            : 'Check that the link is an Apple Music playlist URL.',
      })
    } finally {
      setAdding(false)
    }
  }

  const removePlaylist = async (target: string) => {
    setRemoving(target)
    // Optimistic: the row disappears immediately and comes back if the server
    // disagrees, so the UI never feels like it ignored the click.
    const previous = data
    mutate((snapshot) => ({
      ...snapshot,
      playlists: snapshot.playlists.filter((p) => p.url !== target),
      summary: { ...snapshot.summary, total: Math.max(0, snapshot.summary.total - 1) },
    }))
    try {
      await api.removePlaylist(target)
      toast.success('Playlist removed')
      await refresh()
    } catch (err) {
      if (previous) mutate(() => previous)
      toast.error('Could not remove that playlist', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    } finally {
      setRemoving(null)
    }
  }

  const syncOne = async (target: string) => {
    try {
      await api.sync([target])
      toast.success('Sync started for that playlist')
      setTimeout(() => void refresh(), 1500)
    } catch (err) {
      toast.error('Could not start a sync', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    }
  }

  const syncAll = async () => {
    setSyncing(true)
    try {
      await api.sync()
      toast.success('Sync started')
      setTimeout(() => void refresh(), 1500)
    } catch (err) {
      toast.error('Could not start a sync', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Only shown when something actually needs doing. */}
      {data ? <SetupChecklist snapshot={data} /> : null}

      <section aria-label="Library summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[98px] rounded-lg" />)
        ) : (
          <>
            <StatTile label="Playlists" value={summary?.total ?? 0} />
            <StatTile
              label="Tracks"
              value={playlists.reduce((sum, p) => sum + (p.availableCount ?? p.songCount ?? 0), 0)}
              hint="on disk"
            />
            <StatTile
              label="Syncing"
              value={summary?.running ?? 0}
              tone={summary?.running ? 'active' : undefined}
            />
            <StatTile
              label="Every"
              display={formatInterval(data?.settings.frequency ?? 3600)}
              hint="Sync interval"
            />
          </>
        )}
      </section>

      <Card className="frost frost-elevated">
        <CardContent className="p-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              void addPlaylist()
            }}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="playlist-url" className="sr-only">
                Apple Music playlist URL
              </label>
              <Input
                id="playlist-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://music.apple.com/…/playlist/…"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-footnote"
              />
            </div>
            <Button type="submit" disabled={!url.trim() || adding} className="gap-2 sm:w-auto">
              {adding ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add playlist
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="frost frost-elevated overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b py-3">
          <CardTitle className="text-headline">Playlists</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={syncAll}
            disabled={syncing || playlists.length === 0}
            className="gap-2"
          >
            <RefreshCw className={syncing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Sync all
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          {/* Announce list changes without stealing focus. */}
          <div aria-live="polite" className="sr-only">
            {loading
              ? 'Loading playlists'
              : `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`}
          </div>

          {loading ? (
            <ul className="divide-y">
              {Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="flex items-center gap-4 px-4 py-3.5">
                  <Skeleton className="size-5 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </li>
              ))}
            </ul>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <p className="text-callout text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          ) : playlists.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <Music2 className="size-8 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-callout font-medium">No playlists yet</p>
              <p className="max-w-sm text-footnote text-muted-foreground">
                Paste an Apple Music playlist link above. Open a playlist in Apple Music, choose
                Share, then Copy Link.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {playlists.map((playlist) => (
                <PlaylistRow
                  key={playlist.url}
                  playlist={playlist}
                  onRemove={(target) => void removePlaylist(target)}
                  onSync={(target) => void syncOne(target)}
                  busy={removing === playlist.url}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
