import { NextResponse } from 'next/server'
import { canonicalKey, fetchPlaylistMetadata, isPlaylistUrl, normalizeUrl } from '@/lib/apple-music'
import { requestSync } from '@/lib/control'
import { jsonWithEtag } from '@/lib/etag'
import { readSettings } from '@/lib/settings'
import {
  addPlaylistUrl,
  buildPlaylistViews,
  removePlaylistUrl,
  removeStatusEntry,
  writeNameCacheEntry,
} from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function GET(request: Request) {
  try {
    const settings = await readSettings()
    const playlists = await buildPlaylistViews(settings.playlistM3uDir)
    return jsonWithEtag(request, { playlists })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read playlists', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  let url: string
  try {
    const body = await request.json()
    // Store the normalized form so playlists.txt, the status file and the name
    // cache all key on the same string the daemon will see.
    url = normalizeUrl(typeof body?.url === 'string' ? body.url : '')
  } catch (error) {
    return NextResponse.json(
      { error: 'Request body must be JSON', detail: errorDetail(error) },
      { status: 400 }
    )
  }

  if (!isPlaylistUrl(url)) {
    return NextResponse.json(
      {
        error: 'Not an Apple Music playlist URL',
        detail: 'Expected https://music.apple.com/<storefront>/playlist/<name>/pl.<id> — album, song and artist links cannot be synced.',
      },
      { status: 400 }
    )
  }

  try {
    const result = await addPlaylistUrl(url)
    if (!result.added) {
      return NextResponse.json(
        { error: 'Playlist already exists', detail: `Already configured as ${result.duplicate}`, key: canonicalKey(url) },
        { status: 409 }
      )
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to write playlists.txt', detail: errorDetail(error) },
      { status: 500 }
    )
  }

  // Resolve the Apple title exactly once, at add time. Failure is non-fatal:
  // the slug name stands in until the daemon records the real one.
  let name: string | undefined
  try {
    const meta = await fetchPlaylistMetadata(url, 5000)
    if (meta.name || meta.songCount !== undefined) {
      await writeNameCacheEntry(url, meta)
      name = meta.name
    }
  } catch {
    // ignored — see above
  }

  try {
    await requestSync([url])
  } catch (error) {
    // The playlist is saved; it will sync on the next scheduled cycle anyway.
    return NextResponse.json(
      { url: normalizeUrl(url), name: name || null, syncRequested: false, detail: errorDetail(error) },
      { status: 201 }
    )
  }

  return NextResponse.json({ url: normalizeUrl(url), name: name || null, syncRequested: true }, { status: 201 })
}

export async function DELETE(request: Request) {
  let url: string
  try {
    const body = await request.json()
    url = typeof body?.url === 'string' ? body.url.trim() : ''
  } catch (error) {
    return NextResponse.json(
      { error: 'Request body must be JSON', detail: errorDetail(error) },
      { status: 400 }
    )
  }
  if (!url) {
    return NextResponse.json({ error: 'url is required', detail: 'Pass {"url": "..."}' }, { status: 400 })
  }

  try {
    const { removed } = await removePlaylistUrl(url)
    if (!removed.length) {
      return NextResponse.json(
        { error: 'Playlist not found', detail: `${url} is not in playlists.txt` },
        { status: 404 }
      )
    }
    for (const entry of removed) {
      await removeStatusEntry(entry)
    }
    return NextResponse.json({ removed })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to remove playlist', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}
