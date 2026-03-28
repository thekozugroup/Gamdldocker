import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR || '/config'
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')

const defaultSettings = {
  frequency: 3600,
  outputLocation: '/data/music',
  playlistM3uDir: '/data/music/playlists',
  outputStructure: '{artist}/{album}/{title}',
  fileFormat: 'm4a',
  downloadLyrics: true,
  lyricsFormat: 'lrc',
  quality: 'high',
  savePlaylist: true,
  overwrite: false,
  downloadMode: 'nm3u8dlre',
  autoUpdate: true,
  autoUpdateInterval: 86400
}

type Settings = typeof defaultSettings

function normalizeSettings(input: Partial<Settings>): Settings {
  const frequency = Number(input.frequency)
  const autoUpdateInterval = Number(input.autoUpdateInterval)

  const rawOutputLocation = String(input.outputLocation || defaultSettings.outputLocation).trim() || defaultSettings.outputLocation
  const outputLocation = rawOutputLocation === '/data/Music' ? '/data/music' : rawOutputLocation
  const rawPlaylistM3uDir = String(input.playlistM3uDir || `${outputLocation}/playlists`).trim()
  const playlistM3uDir = rawPlaylistM3uDir === '/data/Music/playlists' ? '/data/music/playlists' : rawPlaylistM3uDir

  return {
    ...defaultSettings,
    ...input,
    frequency: Number.isFinite(frequency) ? Math.max(10, frequency) : defaultSettings.frequency,
    outputLocation,
    playlistM3uDir,
    fileFormat: ['m4a', 'mp3', 'flac'].includes(String(input.fileFormat))
      ? String(input.fileFormat)
      : defaultSettings.fileFormat,
    lyricsFormat: ['lrc', 'txt'].includes(String(input.lyricsFormat))
      ? String(input.lyricsFormat)
      : defaultSettings.lyricsFormat,
    downloadMode: ['nm3u8dlre', 'ffmpeg'].includes(String(input.downloadMode))
      ? String(input.downloadMode)
      : defaultSettings.downloadMode,
    autoUpdate: typeof input.autoUpdate === 'boolean' ? input.autoUpdate : defaultSettings.autoUpdate,
    autoUpdateInterval: Number.isFinite(autoUpdateInterval)
      ? Math.max(60, autoUpdateInterval)
      : defaultSettings.autoUpdateInterval,
  }
}

export async function GET() {
  try {
    const content = await fs.readFile(SETTINGS_FILE, 'utf-8').catch(() => null)
    const settings = content ? normalizeSettings(JSON.parse(content)) : defaultSettings
    return NextResponse.json(settings)
  } catch (error) {
    return NextResponse.json(defaultSettings)
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json()
    const settings = normalizeSettings(payload)
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8')
    
    // Update environment file
    const envContent = `
FREQUENCY=${settings.frequency}
OUTPUT_LOCATION=${settings.outputLocation}
OUTPUT_DIR=${settings.outputLocation}
PLAYLIST_M3U_DIR=${settings.playlistM3uDir}
OUTPUT_STRUCTURE=${settings.outputStructure}
FILE_FORMAT=${settings.fileFormat}
DOWNLOAD_LYRICS=${settings.downloadLyrics}
LYRICS_FORMAT=${settings.lyricsFormat}
QUALITY=${settings.quality}
SAVE_PLAYLIST=${settings.savePlaylist}
OVERWRITE=${settings.overwrite}
DOWNLOAD_MODE=${settings.downloadMode}
AUTO_UPDATE=${settings.autoUpdate}
AUTO_UPDATE_INTERVAL=${settings.autoUpdateInterval}
    `.trim()
    
    await fs.writeFile(path.join(CONFIG_DIR, 'webui.env'), envContent, 'utf-8')
    
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to save settings' },
      { status: 500 }
    )
  }
}
