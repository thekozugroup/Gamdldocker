# Upgrading from v1

```bash
git pull && docker compose up -d --build
```

That is the whole procedure. Everything below is what happens automatically, and
what to expect afterwards — read it if something looks different, not before you
upgrade.

## What carries over untouched

Your music library, your playlist list, your settings, your cookies, and the
container and volume names. `config/` keeps the same filenames it always had.

## What the first start does for you

Four migrations run once, each recorded in `config/.migrations.json` so they
never run twice:

| Migration | What it does |
| --- | --- |
| `legacy-playlists-folder` | Moves any `.m3u`/`.m3u8` left in `<library>/Playlists/` into your configured playlist folder. gamdl is now pointed straight at the right folder, so nothing new lands there. |
| `name-cache-dict-shape` | Rewrites `{"<url>": "Name"}` entries as `{"<url>": {"name": "Name"}}`. Both shapes are still read. |
| `remove-webui-env` | Deletes `config/webui.env`. The settings page wrote it on every save and nothing ever read it. |
| `secure-config-permissions` | Sets `cookies.txt`, `music.apple.com_cookies.txt` and the name cache to owner-only. |

`config/settings.json` is separately migrated to schema v2 on first start. The
old keys are translated, not discarded:

| v1 key | Becomes | Why |
| --- | --- | --- |
| `quality: "high"` | `songCodec: "aac-legacy"` | The value was never passed to gamdl. It is now. |
| `quality: "lossless"` | `songCodec: "alac"` | |
| `fileFormat: "flac"` | `songCodec: "alac"` | Apple Music never returns FLAC; ALAC is the lossless intent. |
| `fileFormat: "mp3"` / `"m4a"` | *(dropped)* | Apple Music only ever yields m4a, so the option was decorative. |
| `outputStructure` | `albumFolderTemplate` + `singleDiscFileTemplate` + `multiDiscFileTemplate` | gamdl takes separate folder and file templates. |
| `savePlaylist` | *(dropped)* | Always on — it is the point of the project. |
| `lyricsFormat: "txt"` | `lyricsFormat: "lrc"` | gamdl has no plain-text synced-lyrics format. |

Unrecognised keys are preserved.

## What changes on disk

**Playlist files are now `.m3u8` with a header.** v1 wrote `.m3u` files
containing bare relative paths. v2 writes UTF-8 `.m3u8` with `#EXTM3U`,
`#PLAYLIST:<title>` and per-track `#EXTINF` lines, which is what music servers
expect. The old `.m3u` for a playlist is removed once its `.m3u8` exists.

If your music server indexed the old paths, rescan it once after upgrading.

**Playlist files are rebuilt each cycle instead of patched.** v1 asked gamdl to
update the file in place, and gamdl only ever overwrites the lines it touches —
so a playlist that shrank upstream kept its removed tracks forever. The file is
now regenerated from scratch every cycle. If a playlist looks shorter after
upgrading, that is the stale entries going away.

**Unclaimed playlist files are quarantined.** A `.m3u8` in the playlist folder
that no configured URL claims is moved to a `.trash` subfolder, not deleted.
Check there if a file you expected disappears.

**Temp files moved off the container filesystem** into a named `gamdl-temp`
volume. Nothing to do; downloads just stop competing with the container's own
storage.

## Behaviour changes worth knowing

- **`;` in a playlist name** now becomes `；` (fullwidth) instead of `_`. gamdl
  replaces `;` with an underscore, so the character is mapped before gamdl sees
  it. A playlist whose name contains a semicolon will be renamed once.
- **`SAFE_FILENAMES=true` folds accents instead of deleting them.** `café` now
  becomes `cafe`, where v1 produced `caf`. Affected files are renamed once.
- **Settings the UI showed but never applied now actually apply.** Quality,
  lyrics format, cover art, overwrite and the folder templates were all
  cosmetic in v1. If you changed one of them expecting an effect, you will get
  that effect on the next sync — check the Settings page before the first run
  if that matters to you.
- **`AUTO_UPDATE_GAMDL` now defaults to `true`.** Apple changes its web player
  often enough that a pinned gamdl stops working within weeks. A failed upgrade
  verifies itself and rolls back automatically. Set it to `false` in `.env` to
  keep v1's behaviour.
- **The web container no longer mounts the Docker socket.** "Sync now" writes a
  file the downloader watches, and the log view reads
  `config/logs/downloader.log`. If you had a firewall rule or an audit policy
  around that mount, it is no longer needed.
- **`docker stop` is now fast and clean.** The daemon handles SIGTERM, finishes
  its current step, writes its state and exits. v1 ignored the signal and was
  killed after the 10-second timeout.

## Rolling back

v2 only adds keys to `settings.json` and only adds files to `config/`, so
checking out a v1 tag and rebuilding works. The one thing v1 will not
understand is the `.m3u8` playlist files; it will write fresh `.m3u` files
alongside them on its next cycle. Delete the `.m3u8` files if you go back.
