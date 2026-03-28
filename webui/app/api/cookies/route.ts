import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR || '/config'
const DEFAULT_COOKIE_FILE = path.join(CONFIG_DIR, 'cookies.txt')
const APPLE_COOKIE_FILE = path.join(CONFIG_DIR, 'music.apple.com_cookies.txt')

function looksLikeNetscapeCookie(content: string): boolean {
  const trimmed = content.trim()
  return (
    trimmed.startsWith('# Netscape HTTP Cookie File') ||
    trimmed.includes('\tmusic.apple.com\t') ||
    trimmed.includes('\t.apple.com\t')
  )
}

export async function GET() {
  try {
    const stats = await fs.stat(APPLE_COOKIE_FILE).catch(() => null)
    const fallbackStats = await fs.stat(DEFAULT_COOKIE_FILE).catch(() => null)

    return NextResponse.json({
      exists: Boolean(stats || fallbackStats),
      preferredFile: 'music.apple.com_cookies.txt',
      activeFile: stats ? 'music.apple.com_cookies.txt' : fallbackStats ? 'cookies.txt' : null,
      updatedAt: (stats || fallbackStats)?.mtime?.toISOString?.() || null,
    })
  } catch {
    return NextResponse.json({ exists: false, preferredFile: 'music.apple.com_cookies.txt' })
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'Cookie file is required' }, { status: 400 })
    }

    const content = await file.text()
    if (!looksLikeNetscapeCookie(content)) {
      return NextResponse.json(
        { error: 'Invalid cookie file format. Please upload Netscape cookies.txt export.' },
        { status: 400 }
      )
    }

    await fs.mkdir(CONFIG_DIR, { recursive: true })
    await fs.writeFile(APPLE_COOKIE_FILE, content, 'utf-8')
    await fs.writeFile(DEFAULT_COOKIE_FILE, content, 'utf-8')

    return NextResponse.json({
      success: true,
      message: 'Cookies uploaded and persisted',
      files: ['music.apple.com_cookies.txt', 'cookies.txt'],
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to save cookies',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
