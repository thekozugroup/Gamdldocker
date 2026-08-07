'use client'

import * as React from 'react'
import { Check, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  NumberField,
  SegmentedControl,
  SettingGroup,
  SettingRow,
  SettingSwitch,
} from '@/components/setting-row'
import { api, ApiError, type Settings } from '@/lib/api'
import { formatInterval } from '@/lib/format'

const CODECS = [
  { value: 'aac-legacy', label: 'AAC', hint: 'Default. 256 kbps, works without a device file.' },
  { value: 'aac-he', label: 'AAC-HE', hint: 'Smaller files, lower quality.' },
  { value: 'alac', label: 'Lossless', hint: 'ALAC. Requires a Widevine .wvd device file.' },
  { value: 'atmos', label: 'Atmos', hint: 'Spatial audio. Requires a .wvd device file.' },
] as const

const INTERVALS = [1800, 3600, 7200, 21600, 86400]

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setSettings(await api.settings())
      setLoadFailed(false)
      setDirty(false)
    } catch (err) {
      // Critically, `settings` stays null. v1 fell back to hard-coded defaults
      // here, so pressing Save after a failed load overwrote the user's real
      // configuration with values they had never chosen.
      setLoadFailed(true)
      toast.error('Could not load settings', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // Warn before losing edits to a browser navigation.
  React.useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((previous) => (previous ? { ...previous, [key]: value } : previous))
    setDirty(true)
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    try {
      // The route answers with the stored settings flat, not wrapped. Show them:
      // it clamps and normalises, and a silent difference between the form and
      // reality is how people end up debugging the wrong thing.
      const { reloadRequested, ...saved } = await api.saveSettings(settings)
      setSettings(saved)
      setDirty(false)
      toast.success('Settings saved', {
        description: reloadRequested
          ? 'The downloader picked them up.'
          : 'The downloader will pick them up on its next cycle.',
      })
    } catch (err) {
      toast.error('Could not save settings', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  if (loadFailed) {
    return (
      <div className="frost frost-elevated flex flex-col items-center gap-3 rounded-lg border p-10 text-center">
        <p className="text-callout">Settings could not be loaded.</p>
        <p className="max-w-md text-footnote text-muted-foreground">
          Nothing has been changed. Saving is disabled until the current configuration can be read,
          so an outage cannot overwrite your setup.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-8 pb-24">
      <SettingGroup
        title="Schedule"
        description="How often the downloader checks your playlists for changes."
      >
        <SettingRow
          label="Sync interval"
          description={`Currently every ${formatInterval(settings.frequency)}. Shorter intervals do not download more; they just notice changes sooner.`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Sync interval preset"
              value={
                (INTERVALS.includes(settings.frequency)
                  ? String(settings.frequency)
                  : 'custom') as string
              }
              options={[
                ...INTERVALS.map((seconds) => ({
                  value: String(seconds),
                  label: formatInterval(seconds),
                })),
                ...(INTERVALS.includes(settings.frequency)
                  ? []
                  : [{ value: 'custom', label: 'Custom' }]),
              ]}
              onChange={(value) => {
                if (value !== 'custom') update('frequency', Number(value))
              }}
            />
            <NumberField
              value={settings.frequency}
              min={60}
              onCommit={(value) => update('frequency', value)}
              suffix="sec"
            />
          </div>
        </SettingRow>

        <SettingRow
          label="Playlists at a time"
          description="Raising this syncs faster but makes more parallel requests to Apple. Leave at 1 unless you have many playlists."
        >
          <NumberField
            value={settings.concurrency}
            min={1}
            max={8}
            onCommit={(value) => update('concurrency', value)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Audio" description="What gets downloaded, and in what quality.">
        <SettingRow
          label="Quality"
          description="Lossless and Atmos need a Widevine device file at /config/device.wvd. Without one, tracks fall back to AAC automatically."
        >
          <SegmentedControl
            label="Audio quality"
            value={settings.songCodec}
            options={CODECS.map((c) => ({ value: c.value, label: c.label, hint: c.hint }))}
            onChange={(value) => update('songCodec', value)}
          />
        </SettingRow>

        <SettingRow
          label="Download engine"
          description="N_m3u8DL-RE is faster and more reliable. Switch to yt-dlp only if it is failing."
        >
          <SegmentedControl
            label="Download engine"
            value={settings.downloadMode}
            options={[
              { value: 'nm3u8dlre', label: 'N_m3u8DL-RE' },
              { value: 'ytdlp', label: 'yt-dlp' },
            ]}
            onChange={(value) => update('downloadMode', value)}
          />
        </SettingRow>

        <SettingSwitch
          label="Download synced lyrics"
          description="Saves a .lrc file alongside each track."
          checked={settings.downloadLyrics}
          onChange={(value) => update('downloadLyrics', value)}
        />

        {settings.downloadLyrics ? (
          <SettingRow label="Lyrics format" description="LRC works in most players.">
            <SegmentedControl
              label="Lyrics format"
              value={settings.lyricsFormat}
              options={[
                { value: 'lrc', label: 'LRC' },
                { value: 'srt', label: 'SRT' },
                { value: 'ttml', label: 'TTML' },
              ]}
              onChange={(value) => update('lyricsFormat', value)}
            />
          </SettingRow>
        ) : null}

        <SettingSwitch
          label="Save cover art as a separate file"
          description="Artwork is embedded in the audio file either way. This adds a standalone image next to it."
          checked={settings.saveCover}
          onChange={(value) => update('saveCover', value)}
        />

        <SettingSwitch
          label="Re-download existing files"
          description="Off means already-downloaded tracks are skipped, which is what you want for a scheduled sync."
          checked={settings.overwrite}
          onChange={(value) => update('overwrite', value)}
        />
      </SettingGroup>

      <SettingGroup
        title="Files and folders"
        description="Paths are inside the container. They map to the host through the volumes in compose.yaml."
      >
        <SettingRow label="Music library" htmlFor="output-location" stacked>
          <Input
            id="output-location"
            value={settings.outputLocation}
            onChange={(event) => {
              const next = event.target.value
              // The playlist folder normally lives inside the library. Keep it
              // following along unless it has been pointed somewhere else.
              const wasDefault =
                settings.playlistM3uDir === `${settings.outputLocation.replace(/\/$/, '')}/playlists`
              setSettings({
                ...settings,
                outputLocation: next,
                playlistM3uDir: wasDefault
                  ? `${next.replace(/\/$/, '')}/playlists`
                  : settings.playlistM3uDir,
              })
              setDirty(true)
            }}
            className="font-mono text-footnote"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label="Playlist folder"
          description="Where the .m3u8 files are written."
          htmlFor="playlist-dir"
          stacked
        >
          <Input
            id="playlist-dir"
            value={settings.playlistM3uDir}
            onChange={(event) => update('playlistM3uDir', event.target.value)}
            className="font-mono text-footnote"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label="Album folder pattern"
          description="Available fields: {album_artist}, {album}, {artist}, {date}."
          htmlFor="album-folder"
          stacked
        >
          <Input
            id="album-folder"
            value={settings.albumFolderTemplate}
            onChange={(event) => update('albumFolderTemplate', event.target.value)}
            className="font-mono text-footnote"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label="Track file pattern"
          description="Available fields: {track}, {title}, {artist}, {disc}."
          htmlFor="track-file"
          stacked
        >
          <Input
            id="track-file"
            value={settings.singleDiscFileTemplate}
            onChange={(event) => update('singleDiscFileTemplate', event.target.value)}
            className="font-mono text-footnote"
            spellCheck={false}
          />
        </SettingRow>

        <SettingSwitch
          label="Remove missing tracks from playlist files"
          description="Tracks that could not be downloaded are left out of the .m3u8, so players never show dead entries."
          checked={settings.prunePlaylistEntries}
          onChange={(value) => update('prunePlaylistEntries', value)}
        />

        <SettingSwitch
          label="ASCII-only filenames"
          description="Strips emoji and accents from filenames. Only needed for legacy SMB or exFAT shares that mishandle UTF-8."
          checked={settings.safeFilenames}
          onChange={(value) => update('safeFilenames', value)}
        />
      </SettingGroup>

      <SettingGroup
        title="Updates"
        description="Apple changes its web player often, so keeping the tools current is what keeps downloads working."
      >
        <SettingSwitch
          label="Keep tools updated"
          description="Checks for new gamdl and N_m3u8DL-RE releases on a schedule."
          checked={settings.autoUpdate}
          onChange={(value) => update('autoUpdate', value)}
        />

        {settings.autoUpdate ? (
          <>
            <SettingSwitch
              label="Update gamdl automatically"
              description="A failed upgrade rolls back to the previous version automatically."
              checked={settings.autoUpdateGamdl}
              onChange={(value) => update('autoUpdateGamdl', value)}
            />
            <SettingRow
              label="Check for updates every"
              description={formatInterval(settings.autoUpdateInterval)}
            >
              <NumberField
                value={settings.autoUpdateInterval}
                min={300}
                onCommit={(value) => update('autoUpdateInterval', value)}
                suffix="sec"
              />
            </SettingRow>
          </>
        ) : null}
      </SettingGroup>

      {/*
        A save bar that follows you down the page. On a form this long, a button
        that only exists at the bottom means scrolling to find out whether your
        change took.
      */}
      <div
        className="frost frost-elevated frost-edge fixed inset-x-0 bottom-0 z-20 border-t"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between gap-3 px-4 py-3 lg:px-8">
          <p aria-live="polite" className="text-footnote text-muted-foreground">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={!dirty || saving}
              className="gap-1.5"
            >
              <RotateCcw className="size-3.5" />
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving} className="gap-1.5">
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
