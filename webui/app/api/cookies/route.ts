import { NextResponse } from 'next/server'
import fsp from 'fs/promises'
import { atomicWriteText } from '@/lib/fsx'
import { APPLE_COOKIES_FILE, COOKIES_FILE } from '@/lib/paths'
import { readCookieStatus } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_COOKIE_BYTES = 1024 * 1024

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateNetscape(content: string): string | null {
  if (!content.trim()) return 'The uploaded file is empty.'
  // A Netscape jar is 7 tab-separated fields per cookie line.
  const cookieLines = content
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .filter((l) => l.split('\t').length >= 7)
  if (!cookieLines.length) {
    return 'Not a Netscape cookies.txt export (no tab-separated cookie lines found). Use a "cookies.txt" browser extension while logged in to music.apple.com.'
  }
  if (!content.includes('apple.com')) {
    return 'No apple.com cookies in this file — it looks like an export for a different site.'
  }
  return null
}

export async function GET() {
  try {
    return NextResponse.json(await readCookieStatus())
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read cookie status', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  let content: string
  try {
    const type = request.headers.get('content-type') || ''
    if (type.includes('multipart/form-data')) {
      const file = (await request.formData()).get('file')
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'Cookie file is required', detail: 'Send the export as a form field named "file".' },
          { status: 400 }
        )
      }
      if (file.size > MAX_COOKIE_BYTES) {
        return NextResponse.json(
          { error: 'Cookie file too large', detail: `${file.size} bytes exceeds the ${MAX_COOKIE_BYTES} byte limit.` },
          { status: 413 }
        )
      }
      content = await file.text()
    } else {
      content = await request.text()
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Could not read upload', detail: errorDetail(error) },
      { status: 400 }
    )
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_COOKIE_BYTES) {
    return NextResponse.json(
      { error: 'Cookie file too large', detail: `Exceeds the ${MAX_COOKIE_BYTES} byte limit.` },
      { status: 413 }
    )
  }
  const invalid = validateNetscape(content)
  if (invalid) {
    return NextResponse.json({ error: 'Invalid cookie file', detail: invalid }, { status: 400 })
  }

  try {
    // Both filenames, because gamdl accepts either depending on configuration.
    // 0600 because cookies are session credentials.
    await atomicWriteText(COOKIES_FILE, content, 0o600)
    await atomicWriteText(APPLE_COOKIES_FILE, content, 0o600)
    return NextResponse.json({
      files: ['cookies.txt', 'music.apple.com_cookies.txt'],
      status: await readCookieStatus(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to save cookies', detail: errorDetail(error) },
      { status: 500 }
    )
  }
}

export async function DELETE() {
  const removed: string[] = []
  try {
    for (const [file, label] of [
      [COOKIES_FILE, 'cookies.txt'],
      [APPLE_COOKIES_FILE, 'music.apple.com_cookies.txt'],
    ] as const) {
      const gone = await fsp
        .unlink(file)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        })
      if (gone) removed.push(label)
    }
    return NextResponse.json({ removed })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete cookies', detail: errorDetail(error), removed },
      { status: 500 }
    )
  }
}
