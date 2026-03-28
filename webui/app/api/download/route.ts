import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const DOWNLOAD_CONTAINER = process.env.DOWNLOAD_CONTAINER || 'gamdl-downloader'

export async function POST() {
  try {
    const command = `docker restart ${DOWNLOAD_CONTAINER}`
    const { stdout, stderr } = await execAsync(command)

    return NextResponse.json({ 
      success: true, 
      message: 'Downloader restarted. New sync cycle started.',
      output: [stdout, stderr].filter(Boolean).join('\n') || 'Container restarted',
    })
  } catch (error) {
    return NextResponse.json(
      { 
        error: 'Failed to trigger download',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
