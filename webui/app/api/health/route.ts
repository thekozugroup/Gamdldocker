import { NextResponse } from 'next/server'
import pkg from '@/package.json'
import { heartbeatAlive, readHeartbeat } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const beat = await readHeartbeat()
    return NextResponse.json({
      ok: true,
      version: pkg.version,
      downloader: {
        alive: heartbeatAlive(beat),
        lastHeartbeat: beat.iso || null,
        state: beat.state || null,
        cycle: beat.cycle ?? null,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
