// Port of the settings handling in downloader/gamdl_sync/config.py.
// The daemon overlays defaults < environment < JSON, and compose hands this
// container the same `env_file: .env`, so all three layers are reproduced here
// — including the v1 migration (fileFormat/quality/savePlaylist/outputStructure).
// Skipping the environment layer would make the UI report a configuration the
// daemon is not running, and then persist it into settings.json, which the
// daemon treats as the authoritative layer.
// Relative .ts imports (not '@/lib/...') so these modules also load under
// node --test's type stripping, which does not resolve tsconfig path aliases.
import { SETTINGS_FILE } from './paths.ts'
import { atomicWriteJson, readJson, withFileLock } from './fsx.ts'

export const SCHEMA_VERSION = 2

export const MIN_FREQUENCY = 60
export const MIN_UPDATE_INTERVAL = 300

export const LYRICS_FORMATS = ['lrc', 'srt', 'ttml'] as const
export const DOWNLOAD_MODES = ['nm3u8dlre', 'ytdlp'] as const
export const COVER_FORMATS = ['jpg', 'png', 'raw'] as const
export const SONG_CODECS = ['aac-legacy', 'aac', 'aac-he', 'alac', 'atmos'] as const

const LEGACY_QUALITY_TO_CODEC: Record<string, string> = {
  high: 'aac-legacy',
  standard: 'aac-legacy',
  low: 'aac-he',
  lossless: 'alac',
  'hi-res': 'alac',
  'hi-res-lossless': 'alac',
  atmos: 'atmos',
}
const LEGACY_FORMAT_TO_CODEC: Record<string, string> = { flac: 'alac', alac: 'alac' }

export const DEPRECATED_KEYS = ['fileFormat', 'quality', 'savePlaylist', 'outputStructure'] as const

export interface SettingsV2 {
  schemaVersion: number
  frequency: number
  outputLocation: string
  playlistM3uDir: string
  albumFolderTemplate: string
  compilationFolderTemplate: string
  noAlbumFolderTemplate: string
  singleDiscFileTemplate: string
  multiDiscFileTemplate: string
  noAlbumFileTemplate: string
  songCodec: string
  downloadMode: string
  language: string
  truncate: number | null
  overwrite: boolean
  downloadLyrics: boolean
  lyricsFormat: string
  saveCover: boolean
  coverFormat: string
  coverSize: number
  safeFilenames: boolean
  prunePlaylistEntries: boolean
  concurrency: number
  autoUpdate: boolean
  autoUpdateInterval: number
  autoUpdateGamdl: boolean
}

export function defaultSettings(): SettingsV2 {
  return {
    schemaVersion: SCHEMA_VERSION,
    frequency: 3600,
    outputLocation: '/data/music',
    playlistM3uDir: '/data/music/playlists',
    albumFolderTemplate: '{album_artist}/{album}',
    compilationFolderTemplate: 'Compilations/{album}',
    noAlbumFolderTemplate: '{artist}/Unknown Album',
    singleDiscFileTemplate: '{track:02d} {title}',
    multiDiscFileTemplate: '{disc}-{track:02d} {title}',
    noAlbumFileTemplate: '{title}',
    songCodec: 'aac-legacy',
    downloadMode: 'nm3u8dlre',
    language: 'en-US',
    truncate: null,
    overwrite: false,
    downloadLyrics: true,
    lyricsFormat: 'lrc',
    saveCover: false,
    coverFormat: 'jpg',
    coverSize: 1200,
    safeFilenames: false,
    prunePlaylistEntries: true,
    concurrency: 1,
    autoUpdate: true,
    autoUpdateInterval: 86400,
    autoUpdateGamdl: true,
  }
}

// --------------------------------------------------------------------------
// Coercion helpers, mirroring config.py so both sides read a file identically
// --------------------------------------------------------------------------

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true
    if (['false', '0', 'no', 'off'].includes(lowered)) return false
    return fallback
  }
  if (typeof value === 'number') return Boolean(value)
  return fallback
}

function asInt(value: unknown, fallback: number, minimum?: number, maximum?: number): number {
  const text = String(value ?? '').trim()
  // parseInt would accept "3600 seconds"; Python's int() does not.
  if (!/^[+-]?\d+$/.test(text)) return fallback
  let parsed = parseInt(text, 10)
  if (minimum !== undefined && parsed < minimum) parsed = minimum
  if (maximum !== undefined && parsed > maximum) parsed = maximum
  return parsed
}

function asChoice(value: unknown, choices: readonly string[], fallback: string): string {
  const text = value === null || value === undefined ? '' : String(value).trim().toLowerCase()
  return choices.includes(text) ? text : fallback
}

function asPath(value: unknown, fallback: string): string {
  const text = value === null || value === undefined ? '' : String(value).trim()
  return text.replace(/\/+$/, '') || fallback
}

function normalizeLyricsFormat(value: unknown, fallback: string): string {
  // The legacy 'txt' value has no gamdl equivalent; translate rather than fail.
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'txt') return 'lrc'
  return asChoice(text, LYRICS_FORMATS, fallback)
}

function templatesFromOutputStructure(structure: string): Partial<SettingsV2> {
  // The v1 outputStructure looked like "{artist}/{album}/{title}": folders
  // before the last separator, the file template after it.
  const parts = structure
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p.trim())
  if (parts.length < 2) return {}
  const folder = parts.slice(0, -1).join('/').replace(/\{artist\}/g, '{album_artist}')
  const filePart = parts[parts.length - 1]
  const single = filePart.includes('{track') ? filePart : '{track:02d} ' + filePart
  const multi = single.includes('{disc}') ? single : '{disc}-' + single.replace(/^\s+/, '')
  return {
    albumFolderTemplate: folder,
    singleDiscFileTemplate: single,
    multiDiscFileTemplate: multi,
    noAlbumFileTemplate: filePart,
  }
}

// --------------------------------------------------------------------------
// Environment layer, mirroring config.py `_from_env`
// --------------------------------------------------------------------------

/** Defaults with the environment overlaid — the base every layer above builds on.
 *
 * config.py reads TEMP_PATH, COOKIES_PATH, NM3U8DLRE_PATH and FFMPEG_PATH too,
 * but its `to_json()` has no key for any of them: they are daemon-only paths
 * that never appear in settings.json. Carrying them here would invent keys the
 * daemon neither writes nor reads back.
 */
export function envSettings(env: NodeJS.ProcessEnv = process.env): SettingsV2 {
  const out = defaultSettings()

  // A variable that is unset *or empty* is not a value — config.py's `get()`
  // skips both, so an empty compose default never clobbers a real default.
  const get = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name]
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }

  const frequency = get('FREQUENCY')
  if (frequency !== undefined) out.frequency = asInt(frequency, out.frequency, MIN_FREQUENCY)

  const outputLocation = get('OUTPUT_DIR', 'OUTPUT_LOCATION')
  if (outputLocation !== undefined) out.outputLocation = asPath(outputLocation, out.outputLocation)

  const playlistM3uDir = get('PLAYLIST_M3U_DIR')
  if (playlistM3uDir !== undefined) out.playlistM3uDir = asPath(playlistM3uDir, out.playlistM3uDir)

  const language = get('LANGUAGE')
  if (language !== undefined) out.language = language.trim()

  const downloadMode = get('DOWNLOAD_MODE')
  if (downloadMode !== undefined) out.downloadMode = asChoice(downloadMode, DOWNLOAD_MODES, out.downloadMode)

  const songCodec = get('SONG_CODEC')
  if (songCodec !== undefined) out.songCodec = asChoice(songCodec, SONG_CODECS, out.songCodec)

  const lyricsFormat = get('LYRICS_FORMAT')
  if (lyricsFormat !== undefined) out.lyricsFormat = normalizeLyricsFormat(lyricsFormat, out.lyricsFormat)

  const concurrency = get('CONCURRENCY')
  if (concurrency !== undefined) out.concurrency = asInt(concurrency, out.concurrency, 1, 8)

  const autoUpdateInterval = get('AUTO_UPDATE_INTERVAL')
  if (autoUpdateInterval !== undefined) {
    out.autoUpdateInterval = asInt(autoUpdateInterval, out.autoUpdateInterval, MIN_UPDATE_INTERVAL)
  }

  const boolVars: Array<[string, keyof SettingsV2]> = [
    ['SAFE_FILENAMES', 'safeFilenames'],
    ['PRUNE_PLAYLIST_ENTRIES', 'prunePlaylistEntries'],
    ['AUTO_UPDATE', 'autoUpdate'],
    ['AUTO_UPDATE_GAMDL', 'autoUpdateGamdl'],
    ['DOWNLOAD_LYRICS', 'downloadLyrics'],
    ['OVERWRITE', 'overwrite'],
  ]
  for (const [name, key] of boolVars) {
    const raw = get(name)
    if (raw !== undefined) (out[key] as boolean) = asBool(raw, out[key] as boolean)
  }

  const outputStructure = get('OUTPUT_STRUCTURE')
  if (outputStructure !== undefined) Object.assign(out, templatesFromOutputStructure(outputStructure))

  return out
}

// --------------------------------------------------------------------------
// Normalisation (tolerant — used when reading whatever is on disk)
// --------------------------------------------------------------------------

export function normalizeSettings(input: unknown): SettingsV2 {
  const out = envSettings()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  const data = input as Record<string, unknown>

  const has = (key: string) => key in data && data[key] !== null && data[key] !== ''

  if (has('frequency')) out.frequency = asInt(data.frequency, out.frequency, MIN_FREQUENCY)
  if (has('outputLocation')) out.outputLocation = asPath(data.outputLocation, out.outputLocation)

  if (has('playlistM3uDir')) {
    out.playlistM3uDir = asPath(data.playlistM3uDir, `${out.outputLocation}/playlists`)
  } else if (has('outputLocation')) {
    // The playlist folder tracks the library root unless it was set apart.
    out.playlistM3uDir = `${out.outputLocation}/playlists`
  }

  const stringKeys: Array<keyof SettingsV2> = [
    'albumFolderTemplate',
    'compilationFolderTemplate',
    'noAlbumFolderTemplate',
    'singleDiscFileTemplate',
    'multiDiscFileTemplate',
    'noAlbumFileTemplate',
    'language',
  ]
  for (const key of stringKeys) {
    if (has(key)) (out[key] as string) = String(data[key]).trim()
  }

  if (has('downloadMode')) out.downloadMode = asChoice(data.downloadMode, DOWNLOAD_MODES, out.downloadMode)
  if (has('coverFormat')) out.coverFormat = asChoice(data.coverFormat, COVER_FORMATS, out.coverFormat)
  if (has('lyricsFormat')) out.lyricsFormat = normalizeLyricsFormat(data.lyricsFormat, out.lyricsFormat)
  if (has('coverSize')) out.coverSize = asInt(data.coverSize, out.coverSize, 64, 10000)
  if (has('truncate')) out.truncate = asInt(data.truncate, out.truncate ?? 0, 20, 255)
  if (has('concurrency')) out.concurrency = asInt(data.concurrency, out.concurrency, 1, 8)
  if (has('autoUpdateInterval')) {
    out.autoUpdateInterval = asInt(data.autoUpdateInterval, out.autoUpdateInterval, MIN_UPDATE_INTERVAL)
  }

  const boolKeys: Array<keyof SettingsV2> = [
    'downloadLyrics',
    'saveCover',
    'overwrite',
    'safeFilenames',
    'prunePlaylistEntries',
    'autoUpdate',
    'autoUpdateGamdl',
  ]
  for (const key of boolKeys) {
    if (key in data) (out[key] as boolean) = asBool(data[key], out[key] as boolean)
  }

  // Song codec: the modern key wins, then the two legacy spellings. 'mp3' has
  // no mapping because gamdl cannot produce it; it falls through to the default.
  let codec: string | undefined
  if (has('songCodec')) {
    codec = asChoice(data.songCodec, SONG_CODECS, out.songCodec)
  } else if (has('quality')) {
    codec = LEGACY_QUALITY_TO_CODEC[String(data.quality).trim().toLowerCase()]
  }
  if (codec === undefined && has('fileFormat')) {
    codec = LEGACY_FORMAT_TO_CODEC[String(data.fileFormat).trim().toLowerCase()]
  }
  if (codec) out.songCodec = codec

  if (has('outputStructure') && !('albumFolderTemplate' in data) && !('singleDiscFileTemplate' in data)) {
    Object.assign(out, templatesFromOutputStructure(String(data.outputStructure)))
  }

  return out
}

// --------------------------------------------------------------------------
// Validation (strict — used on POST so the UI cannot save impossible choices)
// --------------------------------------------------------------------------

export function validateSettingsInput(input: unknown): string[] {
  const errors: string[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return ['settings payload must be a JSON object']
  }
  const data = input as Record<string, unknown>

  if ('lyricsFormat' in data && String(data.lyricsFormat).trim().toLowerCase() === 'txt') {
    errors.push("lyricsFormat 'txt' is not supported by gamdl — use lrc, srt or ttml")
  }
  const fileFormat = 'fileFormat' in data ? String(data.fileFormat).trim().toLowerCase() : ''
  if (fileFormat === 'mp3' || fileFormat === 'flac') {
    errors.push(`fileFormat '${fileFormat}' cannot be produced from Apple Music — gamdl outputs m4a (choose a songCodec instead)`)
  }
  if ('songCodec' in data && data.songCodec !== '' && data.songCodec !== null) {
    const codec = String(data.songCodec).trim().toLowerCase()
    if (!(SONG_CODECS as readonly string[]).includes(codec)) {
      errors.push(`songCodec '${codec}' is not one of ${SONG_CODECS.join(', ')}`)
    }
  }
  return errors
}

// --------------------------------------------------------------------------
// Read / write
// --------------------------------------------------------------------------

export async function readSettings(): Promise<SettingsV2> {
  const data = await readJson<unknown>(SETTINGS_FILE, {})
  return normalizeSettings(data)
}

export async function writeSettings(input: unknown): Promise<SettingsV2> {
  const patch =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  return withFileLock(SETTINGS_FILE, async () => {
    const existing = await readJson<Record<string, unknown>>(SETTINGS_FILE, {})
    // The client posts a partial (lib/api.ts types it Partial<Settings>), so a
    // key the caller omitted has to fall back to what is already configured.
    // Normalising the bare payload instead would rewrite all 26 keys, turning
    // POST {"frequency": 7200} into a reset of everything else.
    //
    // The base is the *resolved* defaults < env < file, not the raw file spread
    // over the env: a file that sets only outputLocation implies a playlist
    // folder inside it, and a legacy `quality` still implies a codec. Merging
    // the raw keys would drop both, and write the difference to disk as fact.
    const normalized = normalizeSettings({ ...normalizeSettings(existing), ...patch })
    const merged: Record<string, unknown> = { ...normalized }
    // Keep unrecognised keys a future version may understand, exactly like
    // migrate_settings_file does — but never resurrect the deprecated v1 keys.
    for (const source of [existing, patch]) {
      if (typeof source !== 'object' || source === null) continue
      for (const [key, value] of Object.entries(source)) {
        if (!(key in merged) && !(DEPRECATED_KEYS as readonly string[]).includes(key)) {
          merged[key] = value
        }
      }
    }
    await atomicWriteJson(SETTINGS_FILE, merged)
    return normalized
  })
}
