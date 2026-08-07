import { NextResponse } from 'next/server'
import { fetchPlaylistMetadata, isPlaylistUrl } from '@/lib/apple-music'
import { writeNameCacheEntry } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let url: string
  try {
    const body = await request.json()
    url = typeof body?.url === 'string' ? body.url.trim() : ''
  } catch (error) {
    return NextResponse.json(
      { error: 'Request body must be JSON', detail: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    )
  }
  if (!isPlaylistUrl(url)) {
    return NextResponse.json(
      { error: 'Not an Apple Music playlist URL', detail: `Cannot resolve a title for ${url || '(empty)'}` },
      { status: 400 }
    )
  }

  const meta = await fetchPlaylistMetadata(url, 5000)
  if (!meta.name && meta.songCount === undefined) {
    return NextResponse.json(
      { error: 'Could not resolve playlist title', detail: 'Apple did not return a usable title within 5s — the playlist may be private or the URL stale.' },
      { status: 502 }
    )
  }

  try {
    await writeNameCacheEntry(url, meta)
  } catch (error) {
    return NextResponse.json(
      { error: 'Resolved but failed to update the name cache', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
  return NextResponse.json({ url, name: meta.name || null, songCount: meta.songCount ?? null })
}
