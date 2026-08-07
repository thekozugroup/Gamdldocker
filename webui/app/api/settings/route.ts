// Settings live in /config/settings.json and nowhere else. The old webui.env
// side-channel is gone: nothing reads it anymore, so writing it would only
// preserve a second source of truth that can drift.
import { NextResponse } from 'next/server'
import { requestReload } from '@/lib/control'
import { readSettings, validateSettingsInput, writeSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function GET() {
  try {
    return NextResponse.json(await readSettings())
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read settings', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch (error) {
    return NextResponse.json(
      { error: 'Request body must be JSON', detail: errorDetail(error) },
      { status: 400 }
    )
  }

  const errors = validateSettingsInput(payload)
  if (errors.length) {
    return NextResponse.json(
      { error: 'Settings rejected', detail: errors.join('; ') },
      { status: 400 }
    )
  }

  try {
    const saved = await writeSettings(payload)
    // Wake the daemon so the new settings apply to the next action, not the
    // one after the current sleep ends.
    let reloadRequested = true
    try {
      await requestReload()
    } catch {
      reloadRequested = false
    }
    return NextResponse.json({ ...saved, reloadRequested })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to save settings', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}
