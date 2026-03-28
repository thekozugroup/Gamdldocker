import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)
const DOWNLOAD_CONTAINER = process.env.DOWNLOAD_CONTAINER || 'gamdl-downloader'
const CONFIG_DIR = process.env.CONFIG_DIR || '/config'
const STATUS_FILE = path.join(CONFIG_DIR, 'playlist-status.json')

function clampLines(value: string | null): number {
  const parsed = Number(value || 160)
  if (!Number.isFinite(parsed)) return 160
  return Math.min(500, Math.max(20, Math.floor(parsed)))
}

async function getStatusSummary() {
  const raw = await fs.readFile(STATUS_FILE, 'utf-8').catch(() => '')
  if (!raw) return { idle: 0, running: 0, complete: 0, failed: 0 }

  let statusMap: Record<string, { status?: 'idle' | 'running' | 'complete' | 'failed' }> = {}
  try {
    statusMap = JSON.parse(raw)
  } catch {
    return { idle: 0, running: 0, complete: 0, failed: 0 }
  }

  const summary = { idle: 0, running: 0, complete: 0, failed: 0 }
  for (const entry of Object.values(statusMap)) {
    const status = entry.status || 'idle'
    if (status in summary) {
      summary[status as keyof typeof summary] += 1
    }
  }
  return summary
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const lines = clampLines(searchParams.get('lines'))

  try {
    const [logsResult, summary] = await Promise.all([
      execAsync(`docker logs --tail ${lines} ${DOWNLOAD_CONTAINER} 2>&1`).catch((error) => ({
        stdout: '',
        stderr: error instanceof Error ? error.message : 'Failed to read logs',
      })),
      getStatusSummary(),
    ])

    const logs = [logsResult.stdout, logsResult.stderr].filter(Boolean).join('\n').trim()

    return NextResponse.json({
      logs,
      statusSummary: summary,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        logs: 'Failed to load logs',
        statusSummary: { idle: 0, running: 0, complete: 0, failed: 0 },
        updatedAt: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
