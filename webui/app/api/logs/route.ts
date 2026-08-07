// Logs come from the file the daemon writes into the shared volume — never
// from `docker logs`, which would require mounting the docker socket.
import { NextResponse } from 'next/server'
import { readTextTail } from '@/lib/fsx'
import { DOWNLOADER_LOG } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_LINES = 20
const MAX_LINES = 2000
const DEFAULT_LINES = 200

function clampLines(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_LINES)
  if (!Number.isFinite(parsed)) return DEFAULT_LINES
  return Math.min(MAX_LINES, Math.max(MIN_LINES, Math.floor(parsed)))
}

export async function GET(request: Request) {
  const lines = clampLines(new URL(request.url).searchParams.get('lines'))
  try {
    const tail = await readTextTail(DOWNLOADER_LOG, lines)
    if (tail === null) {
      return NextResponse.json({
        logs: '',
        missing: true,
        message: `No log file at ${DOWNLOADER_LOG} yet — the downloader has not started, or the containers do not share the /config volume.`,
        updatedAt: new Date().toISOString(),
      })
    }
    return NextResponse.json({
      logs: tail,
      missing: false,
      lines,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read the log file', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
