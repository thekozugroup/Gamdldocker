import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// CONFIG_DIR must point at a sandbox before lib/paths is (transitively)
// imported, because it resolves its constants at import time.
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamdl-settings-'))
process.env.CONFIG_DIR = tmpRoot

// Every variable the environment layer consults. Cleared before anything else
// runs: LANGUAGE in particular is a standard POSIX variable that a developer
// shell may already export, and it would otherwise decide the assertions below.
const ENV_VARS = [
  'FREQUENCY',
  'OUTPUT_DIR',
  'OUTPUT_LOCATION',
  'PLAYLIST_M3U_DIR',
  'DOWNLOAD_MODE',
  'SONG_CODEC',
  'LANGUAGE',
  'SAFE_FILENAMES',
  'PRUNE_PLAYLIST_ENTRIES',
  'CONCURRENCY',
  'AUTO_UPDATE',
  'AUTO_UPDATE_INTERVAL',
  'AUTO_UPDATE_GAMDL',
  'DOWNLOAD_LYRICS',
  'LYRICS_FORMAT',
  'OVERWRITE',
  'OUTPUT_STRUCTURE',
]
for (const name of ENV_VARS) delete process.env[name]

const {
  defaultSettings,
  envSettings,
  normalizeSettings,
  readSettings,
  validateSettingsInput,
  writeSettings,
  SCHEMA_VERSION,
} = await import('../lib/settings.ts')

/** Run `fn` with `vars` applied, then put the environment back as it was. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.entries(vars).map(([key, value]) => [key, process.env[key], value] as const)
  for (const [key, , value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
}

before(async () => {
  await fsp.mkdir(tmpRoot, { recursive: true })
})

test('empty input yields the documented defaults', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.schemaVersion, SCHEMA_VERSION)
  assert.equal(settings.frequency, 3600)
  assert.equal(settings.songCodec, 'aac-legacy')
  assert.equal(settings.playlistM3uDir, '/data/music/playlists')
  assert.equal(settings.truncate, null)
})

test('v1 file: quality maps to songCodec the way config.py maps it', () => {
  assert.equal(normalizeSettings({ quality: 'lossless' }).songCodec, 'alac')
  assert.equal(normalizeSettings({ quality: 'atmos' }).songCodec, 'atmos')
  assert.equal(normalizeSettings({ quality: 'low' }).songCodec, 'aac-he')
  assert.equal(normalizeSettings({ quality: 'high' }).songCodec, 'aac-legacy')
  // Unknown quality falls through to fileFormat, then to the default.
  assert.equal(normalizeSettings({ quality: 'ultra', fileFormat: 'flac' }).songCodec, 'alac')
  assert.equal(normalizeSettings({ quality: 'ultra' }).songCodec, 'aac-legacy')
})

test('v1 file: fileFormat mp3 has no gamdl equivalent and is dropped', () => {
  assert.equal(normalizeSettings({ fileFormat: 'mp3' }).songCodec, 'aac-legacy')
})

test('v1 file: songCodec beats the legacy keys', () => {
  assert.equal(normalizeSettings({ songCodec: 'atmos', quality: 'high', fileFormat: 'flac' }).songCodec, 'atmos')
})

test('v1 file: outputStructure becomes gamdl templates', () => {
  const settings = normalizeSettings({ outputStructure: '{artist}/{album}/{title}' })
  assert.equal(settings.albumFolderTemplate, '{album_artist}/{album}')
  assert.equal(settings.singleDiscFileTemplate, '{track:02d} {title}')
  assert.equal(settings.multiDiscFileTemplate, '{disc}-{track:02d} {title}')
  assert.equal(settings.noAlbumFileTemplate, '{title}')
})

test('v1 file: outputStructure loses to explicit v2 templates', () => {
  const settings = normalizeSettings({
    outputStructure: '{artist}/{album}/{title}',
    albumFolderTemplate: 'Music/{album}',
  })
  assert.equal(settings.albumFolderTemplate, 'Music/{album}')
  assert.equal(settings.singleDiscFileTemplate, defaultSettings().singleDiscFileTemplate)
})

test('v1 file: lyricsFormat txt is translated to lrc on read', () => {
  assert.equal(normalizeSettings({ lyricsFormat: 'txt' }).lyricsFormat, 'lrc')
})

test('playlistM3uDir follows outputLocation unless set apart', () => {
  assert.equal(normalizeSettings({ outputLocation: '/mnt/library/' }).playlistM3uDir, '/mnt/library/playlists')
  assert.equal(
    normalizeSettings({ outputLocation: '/mnt/library', playlistM3uDir: '/mnt/lists' }).playlistM3uDir,
    '/mnt/lists'
  )
})

test('hostile input: junk types fall back instead of crashing', () => {
  const settings = normalizeSettings({
    frequency: 'soon',
    concurrency: ['not', 'a', 'number'],
    coverSize: { evil: true },
    downloadMode: 'curl | sh',
    lyricsFormat: 42,
    overwrite: 'yes',
    downloadLyrics: 'off',
    truncate: 'NaN',
  })
  assert.equal(settings.frequency, 3600)
  assert.equal(settings.concurrency, 1)
  assert.equal(settings.coverSize, 1200)
  assert.equal(settings.downloadMode, 'nm3u8dlre')
  assert.equal(settings.lyricsFormat, 'lrc')
  assert.equal(settings.overwrite, true)
  assert.equal(settings.downloadLyrics, false)
})

test('hostile input: numbers are clamped like config.py clamps them', () => {
  assert.equal(normalizeSettings({ frequency: 5 }).frequency, 60)
  assert.equal(normalizeSettings({ concurrency: 999 }).concurrency, 8)
  assert.equal(normalizeSettings({ coverSize: 3 }).coverSize, 64)
  assert.equal(normalizeSettings({ truncate: 10000 }).truncate, 255)
  assert.equal(normalizeSettings({ autoUpdateInterval: 1 }).autoUpdateInterval, 300)
})

test('hostile input: non-object payloads leave the base untouched', () => {
  assert.deepEqual(normalizeSettings(null), envSettings())
  assert.deepEqual(normalizeSettings([1, 2, 3]), envSettings())
  assert.deepEqual(normalizeSettings('frequency=1'), envSettings())
})

test('validate rejects what gamdl cannot honor', () => {
  assert.equal(validateSettingsInput({ lyricsFormat: 'txt' }).length, 1)
  assert.equal(validateSettingsInput({ fileFormat: 'mp3' }).length, 1)
  assert.equal(validateSettingsInput({ fileFormat: 'flac' }).length, 1)
  assert.equal(validateSettingsInput({ songCodec: 'wav' }).length, 1)
  assert.equal(validateSettingsInput({ lyricsFormat: 'lrc', songCodec: 'alac' }).length, 0)
  assert.equal(validateSettingsInput('junk').length, 1)
})

// --------------------------------------------------------------------------
// Environment layer — compose gives this container the same .env the daemon
// gets, so config.py's `_from_env` has to be reproduced here or the UI reports
// and saves a configuration the daemon is not running.
// --------------------------------------------------------------------------

test('env layer: a set variable overrides the default', async () => {
  await withEnv(
    {
      FREQUENCY: '7200',
      PLAYLIST_M3U_DIR: '/mnt/lists/',
      SONG_CODEC: 'alac',
      DOWNLOAD_MODE: 'ytdlp',
      LANGUAGE: 'de-DE',
      DOWNLOAD_LYRICS: 'false',
      OVERWRITE: '1',
      AUTO_UPDATE_INTERVAL: '43200',
    },
    () => {
      const settings = envSettings()
      assert.equal(settings.frequency, 7200)
      assert.equal(settings.playlistM3uDir, '/mnt/lists')
      assert.equal(settings.songCodec, 'alac')
      assert.equal(settings.downloadMode, 'ytdlp')
      assert.equal(settings.language, 'de-DE')
      assert.equal(settings.downloadLyrics, false)
      assert.equal(settings.overwrite, true)
      assert.equal(settings.autoUpdateInterval, 43200)
    }
  )
})

test('env layer: an unset or empty variable never clobbers the default', async () => {
  await withEnv({ FREQUENCY: undefined, PLAYLIST_M3U_DIR: '', SONG_CODEC: '', AUTO_UPDATE: '' }, () => {
    const settings = envSettings()
    assert.equal(settings.frequency, 3600)
    assert.equal(settings.playlistM3uDir, '/data/music/playlists')
    assert.equal(settings.songCodec, 'aac-legacy')
    assert.equal(settings.autoUpdate, true)
  })
})

test('env layer: OUTPUT_DIR wins over OUTPUT_LOCATION, and an empty one falls through', async () => {
  await withEnv({ OUTPUT_DIR: '/mnt/a', OUTPUT_LOCATION: '/mnt/b' }, () => {
    assert.equal(envSettings().outputLocation, '/mnt/a')
  })
  await withEnv({ OUTPUT_DIR: '', OUTPUT_LOCATION: '/mnt/b' }, () => {
    assert.equal(envSettings().outputLocation, '/mnt/b')
  })
})

test('env layer: OUTPUT_DIR alone does not move the playlist folder', async () => {
  // config.py only makes the playlist folder follow the library root in its
  // JSON layer, so an env-only library move leaves PLAYLIST_M3U_DIR's default.
  await withEnv({ OUTPUT_DIR: '/mnt/library' }, () => {
    assert.equal(envSettings().playlistM3uDir, '/data/music/playlists')
  })
})

test('env layer: values are coerced and clamped like config.py clamps them', async () => {
  await withEnv(
    {
      FREQUENCY: '5',
      CONCURRENCY: '999',
      AUTO_UPDATE_INTERVAL: '1',
      SONG_CODEC: 'wav',
      DOWNLOAD_MODE: 'curl | sh',
      LYRICS_FORMAT: 'txt',
      SAFE_FILENAMES: 'yes',
      PRUNE_PLAYLIST_ENTRIES: 'off',
      AUTO_UPDATE_GAMDL: 'nonsense',
    },
    () => {
      const settings = envSettings()
      assert.equal(settings.frequency, 60)
      assert.equal(settings.concurrency, 8)
      assert.equal(settings.autoUpdateInterval, 300)
      assert.equal(settings.songCodec, 'aac-legacy')
      assert.equal(settings.downloadMode, 'nm3u8dlre')
      assert.equal(settings.lyricsFormat, 'lrc')
      assert.equal(settings.safeFilenames, true)
      assert.equal(settings.prunePlaylistEntries, false)
      assert.equal(settings.autoUpdateGamdl, true)
    }
  )
})

test('env layer: a non-numeric FREQUENCY falls back instead of throwing', async () => {
  await withEnv({ FREQUENCY: 'soon' }, () => {
    assert.equal(envSettings().frequency, 3600)
  })
})

test('env layer: OUTPUT_STRUCTURE becomes gamdl templates', async () => {
  await withEnv({ OUTPUT_STRUCTURE: '{artist}/{album}/{title}' }, () => {
    const settings = envSettings()
    assert.equal(settings.albumFolderTemplate, '{album_artist}/{album}')
    assert.equal(settings.singleDiscFileTemplate, '{track:02d} {title}')
    assert.equal(settings.multiDiscFileTemplate, '{disc}-{track:02d} {title}')
  })
})

test('precedence: defaults < environment < settings.json', async () => {
  await withEnv({ FREQUENCY: '7200', SONG_CODEC: 'alac', LANGUAGE: 'de-DE' }, () => {
    const settings = normalizeSettings({ frequency: 1800 })
    assert.equal(settings.frequency, 1800, 'json beats env')
    assert.equal(settings.songCodec, 'alac', 'env beats the default')
    assert.equal(settings.language, 'de-DE', 'env beats the default')
    assert.equal(settings.coverSize, 1200, 'the default stands where neither layer speaks')
  })
})

test('write/read round-trip migrates a v1 file and keeps unknown keys', async () => {
  const settingsFile = path.join(tmpRoot, 'settings.json')
  await fsp.writeFile(
    settingsFile,
    JSON.stringify({
      frequency: 1800,
      quality: 'lossless',
      fileFormat: 'flac',
      savePlaylist: true,
      outputStructure: '{artist}/{album}/{title}',
      futureKey: 'keep me',
    }),
    'utf-8'
  )

  const loaded = await readSettings()
  assert.equal(loaded.frequency, 1800)
  assert.equal(loaded.songCodec, 'alac')

  await writeSettings(loaded)
  const onDisk = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'))
  assert.equal(onDisk.schemaVersion, SCHEMA_VERSION)
  assert.equal(onDisk.songCodec, 'alac')
  assert.equal(onDisk.futureKey, 'keep me')
  // The deprecated v1 keys must not survive the rewrite.
  for (const key of ['quality', 'fileFormat', 'savePlaylist', 'outputStructure']) {
    assert.equal(key in onDisk, false, key)
  }
})

test('a partial save keeps every key it did not mention', async () => {
  const settingsFile = path.join(tmpRoot, 'settings.json')
  await fsp.writeFile(
    settingsFile,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      frequency: 1800,
      songCodec: 'alac',
      concurrency: 4,
      outputLocation: '/mnt/library',
      playlistM3uDir: '/mnt/lists',
      downloadLyrics: false,
      futureKey: 'keep me',
    }),
    'utf-8'
  )

  const saved = await writeSettings({ frequency: 7200 })
  assert.equal(saved.frequency, 7200)
  assert.equal(saved.songCodec, 'alac')
  assert.equal(saved.concurrency, 4)
  assert.equal(saved.outputLocation, '/mnt/library')
  assert.equal(saved.playlistM3uDir, '/mnt/lists')
  assert.equal(saved.downloadLyrics, false)

  const onDisk = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'))
  assert.equal(onDisk.frequency, 7200)
  assert.equal(onDisk.songCodec, 'alac')
  assert.equal(onDisk.playlistM3uDir, '/mnt/lists')
  assert.equal(onDisk.futureKey, 'keep me')
})

test('a first save persists the environment, not the bare defaults', async () => {
  // The failure this guards: with no settings.json yet, saving one field used
  // to write the hard-coded defaults for all the others — silently relocating a
  // library that only ever existed as an environment variable.
  const settingsFile = path.join(tmpRoot, 'settings.json')
  await fsp.rm(settingsFile, { force: true })

  const saved = await withEnv(
    { OUTPUT_DIR: '/mnt/library', PLAYLIST_M3U_DIR: '/mnt/lists', SONG_CODEC: 'alac' },
    () => writeSettings({ frequency: 7200 })
  )
  assert.equal(saved.frequency, 7200)
  assert.equal(saved.outputLocation, '/mnt/library')
  assert.equal(saved.playlistM3uDir, '/mnt/lists')
  assert.equal(saved.songCodec, 'alac')

  const onDisk = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'))
  assert.equal(onDisk.outputLocation, '/mnt/library')
  assert.equal(onDisk.playlistM3uDir, '/mnt/lists')
})

test('a partial save keeps what the file only implied', async () => {
  // Both of these are values the daemon computes from the file rather than
  // reading verbatim, so a save that lost them would move the user's output.
  const settingsFile = path.join(tmpRoot, 'settings.json')
  await fsp.writeFile(
    settingsFile,
    JSON.stringify({ outputLocation: '/mnt/library', quality: 'lossless' }),
    'utf-8'
  )

  const saved = await writeSettings({ frequency: 7200 })
  assert.equal(saved.playlistM3uDir, '/mnt/library/playlists')
  assert.equal(saved.songCodec, 'alac')

  const onDisk = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'))
  assert.equal(onDisk.playlistM3uDir, '/mnt/library/playlists')
  assert.equal(onDisk.songCodec, 'alac')
  assert.equal('quality' in onDisk, false)
})

test('settings.json still beats the environment on a save', async () => {
  const settingsFile = path.join(tmpRoot, 'settings.json')
  await fsp.writeFile(
    settingsFile,
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, playlistM3uDir: '/mnt/chosen-in-the-ui' }),
    'utf-8'
  )

  const saved = await withEnv({ PLAYLIST_M3U_DIR: '/mnt/from-compose' }, () =>
    writeSettings({ frequency: 7200 })
  )
  assert.equal(saved.playlistM3uDir, '/mnt/chosen-in-the-ui')
})
