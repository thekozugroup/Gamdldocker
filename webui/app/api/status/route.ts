// The one snapshot the dashboard polls. Everything here is read from the
// filesystem the daemon shares with us — no outbound HTTP on this path, ever,
// or a slow Apple response would make the whole UI feel broken.
import { NextResponse } from 'next/server'
import { jsonWithEtag } from '@/lib/etag'
import { readSettings } from '@/lib/settings'
import {
  buildPlaylistViews,
  heartbeatAlive,
  readCookieStatus,
  readHeartbeat,
} from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const settings = await readSettings()
    const [playlists, beat, cookies] = await Promise.all([
      buildPlaylistViews(settings.playlistM3uDir),
      readHeartbeat(),
      readCookieStatus(),
    ])

    const summary = { total: playlists.length, idle: 0, running: 0, complete: 0, partial: 0, failed: 0, songs: 0 }
    for (const playlist of playlists) {
      const status = playlist.status as keyof typeof summary
      if (status in summary && status !== 'total' && status !== 'songs') summary[status] += 1
      summary.songs += playlist.songCount || 0
    }

    return jsonWithEtag(request, {
      playlists,
      summary,
      downloader: {
        alive: heartbeatAlive(beat),
        lastHeartbeat: beat.iso || null,
        state: beat.state || null,
        cycle: beat.cycle ?? null,
        detail: beat.detail || '',
      },
      cookies,
      settings: {
        frequency: settings.frequency,
        outputLocation: settings.outputLocation,
        playlistM3uDir: settings.playlistM3uDir,
        songCodec: settings.songCodec,
        downloadMode: settings.downloadMode,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to build status snapshot', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
