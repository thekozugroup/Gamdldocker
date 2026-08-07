// "Sync now" is a control file, not a container restart: the daemon watches
// /config/control every second and picks the command up without aborting
// whatever is already in flight.
import { NextResponse } from 'next/server'
import { requestSync } from '@/lib/control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let urls: string[] = []
  try {
    const text = await request.text()
    if (text.trim()) {
      const body = JSON.parse(text)
      if (Array.isArray(body?.urls)) {
        urls = body.urls.filter((u: unknown): u is string => typeof u === 'string' && u.trim() !== '')
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Request body must be JSON', detail: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    )
  }

  try {
    await requestSync(urls)
    return NextResponse.json({ requested: true, scope: urls.length ? urls : 'all' }, { status: 202 })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to write the sync-now control file', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
