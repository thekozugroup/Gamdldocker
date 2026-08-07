# Gamdl

Keep your Apple Music playlists mirrored to a local library, automatically.

Point it at a playlist, and it downloads the tracks, tags them, writes a `.m3u8`
that your music server can read, and re-checks on a schedule so the playlist on
disk keeps matching the playlist in Apple Music. Built on
[gamdl](https://github.com/glomatico/gamdl).

- **Two containers.** A downloader daemon and a web UI, sharing one config folder.
- **Playlists stay current.** Files are regenerated each cycle, so a track removed
  upstream disappears locally instead of lingering forever.
- **Names survive.** Emoji, CJK, accents, `+`, `/`, `:` — the filename looks like
  the playlist, on every filesystem.
- **Stays working.** gamdl and N_m3u8DL-RE update themselves inside the container,
  and a bad upgrade rolls back on its own.

---

## Quick start

```bash
git clone https://github.com/thekozugroup/Gamdldocker.git
cd Gamdldocker
cp .env.example .env          # set MUSIC_HOST_PATH to your library
docker compose up -d --build
```

Open <http://localhost:3000>, then:

1. **Account** → upload a `cookies.txt` export from a browser signed in to Apple Music.
2. **Library** → paste a playlist link and press Add.

That is the whole setup. The first sync starts immediately; after that it runs
every hour by default.

> **Before you expose this.** The UI binds to every interface and has no login
> unless you give it one. On anything reachable from outside your network, set
> `WEBUI_AUTH_TOKEN` in `.env`, or put it behind a reverse proxy, or bind it to
> Tailscale or loopback with `BIND_HOST`.

---

## How it works

```
                    ┌─────────────────────────────┐
                    │  ./config  (shared volume)  │
                    │                             │
  ┌──────────┐      │  settings.json              │      ┌────────────────┐
  │  Web UI  │◀────▶│  playlists.txt              │◀────▶│   Downloader   │
  │  :3000   │      │  playlist-status.json       │      │     daemon     │
  └──────────┘      │  control/    ← "sync now"   │      └───────┬────────┘
                    │  logs/       → live output  │              │
                    └─────────────────────────────┘              ▼
                                                          ┌─────────────┐
                                                          │ gamdl +     │
                                                          │ N_m3u8DL-RE │
                                                          └──────┬──────┘
                                                                 ▼
                                                        ./downloads (library)
```

The two containers never talk to each other directly. Everything goes through
files in `./config`: the UI writes a request, the daemon picks it up within a
second. That is why the web container does not need the Docker socket — and why
it cannot be used to take over the host.

---

## Configuration

Most things are in the web UI under **Settings** and are written to
`config/settings.json`. `.env` covers what has to be set before the containers
start.

### `.env`

| Variable | Default | What it does |
| --- | --- | --- |
| `MUSIC_HOST_PATH` | `./downloads` | Host folder for the music library. |
| `BIND_HOST` | `0.0.0.0` | Interface the UI listens on. Use `127.0.0.1` or a Tailscale IP to restrict it. |
| `WEBUI_PORT` | `3000` | Host port for the UI. |
| `WEBUI_AUTH_TOKEN` | *(empty)* | Bearer token required on every request. Empty means no auth. |
| `WEBUI_USERNAME` / `WEBUI_PASSWORD` | *(empty)* | HTTP basic auth, as an alternative or addition to the token. |
| `FREQUENCY` | `3600` | Seconds between sync cycles. Minimum 60. |
| `DOWNLOAD_MODE` | `nm3u8dlre` | `nm3u8dlre` or `ytdlp`. |
| `SAFE_FILENAMES` | `false` | Strip non-ASCII from filenames, for legacy SMB/exFAT. |
| `AUTO_UPDATE` | `true` | Check for new gamdl / N_m3u8DL-RE releases. |
| `AUTO_UPDATE_GAMDL` | `true` | Include gamdl in those updates. Rolls back on failure. |
| `AUTO_UPDATE_INTERVAL` | `86400` | Seconds between update checks. Minimum 300. |
| `PUID` / `PGID` | *(empty)* | Run as this user so files are not owned by root. Empty keeps the old root behaviour. |
| `TZ` | `America/New_York` | Timezone for log timestamps. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`. |
| `GAMDL_VERSION` | *(empty)* | Build-time pin. Empty means current at build. |
| `NM3U8DLRE_VERSION` | `pinned` | Build-time: `pinned`, `latest`, or a version number. |

### `config/settings.json`

Written by the UI; the daemon re-reads it every cycle, so changes apply without
a restart.

| Key | Default | What it does |
| --- | --- | --- |
| `frequency` | `3600` | Seconds between cycles. |
| `outputLocation` | `/data/music` | Library root inside the container. |
| `playlistM3uDir` | `/data/music/playlists` | Where `.m3u8` files are written. |
| `songCodec` | `aac-legacy` | `aac-legacy`, `aac`, `aac-he`, `alac`, `atmos`. |
| `downloadMode` | `nm3u8dlre` | Download engine. |
| `downloadLyrics` | `true` | Save synced lyrics beside each track. |
| `lyricsFormat` | `lrc` | `lrc`, `srt` or `ttml`. |
| `saveCover` | `false` | Also write cover art as a separate file. |
| `overwrite` | `false` | Re-download tracks that already exist. |
| `albumFolderTemplate` | `{album_artist}/{album}` | Folder layout. |
| `singleDiscFileTemplate` | `{track:02d} {title}` | File naming. |
| `multiDiscFileTemplate` | `{disc}-{track:02d} {title}` | File naming for multi-disc albums. |
| `prunePlaylistEntries` | `true` | Leave undownloadable tracks out of the `.m3u8`. |
| `safeFilenames` | `false` | ASCII-only filenames. |
| `concurrency` | `1` | Playlists synced in parallel. |
| `autoUpdate` / `autoUpdateGamdl` / `autoUpdateInterval` | `true` / `true` / `86400` | Self-update behaviour. |

`alac` and `atmos` need a Widevine device file at `/config/device.wvd`. Without
one, tracks fall back to AAC rather than failing.

---

## Playlist files

Each playlist becomes one UTF-8 `.m3u8` in `playlistM3uDir`, regenerated every
cycle:

```
#EXTM3U
#PLAYLIST:🪨+roll
#EXTINF:214,Some Artist - Some Track
../Some Artist/Some Album/01 Some Track.m4a
```

**Naming.** The filename comes from Apple's own playlist title. Characters no
filesystem can store (`\ / : * ? " < > | ;`) become fullwidth lookalikes
(`＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜ ；`) so the name still reads correctly. Emoji, accents
and non-Latin scripts are kept as-is. If two playlists differ only by case —
which macOS and Windows treat as the same file — the second gets a short
`(abc123)` suffix.

**Staying current.** The file is rebuilt from scratch each cycle rather than
patched, so a track removed from the playlist upstream is removed locally too.
Tracks that could not be downloaded are left out (see `prunePlaylistEntries`) and
counted in the UI, so players never show dead entries. A playlist file no longer
claimed by any configured URL is moved to a `.trash` folder rather than deleted.

**Overriding a name.** When Apple's stored title is wrong, or two playlists
collide, copy `config/playlist-overrides.json.example` to
`config/playlist-overrides.json`:

```json
{
  "https://music.apple.com/us/playlist/jams/pl.u-EXAMPLE111111": "Bops"
}
```

Overrides win over Apple's title. Sanitizing and collision suffixes still apply.

---

## Troubleshooting

Start here — it checks everything that commonly breaks and names the fix:

```bash
docker compose exec gamdl-downloader gamdl-sync doctor
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing downloads, UI shows "Not signed in" | No cookie file | Upload `cookies.txt` under **Account** |
| Downloads stopped after working for weeks | Cookies expired | Re-export and upload. The UI warns a week ahead |
| "Apple refused the request (403)" | Wrong storefront, or no active subscription | Check the account has Apple Music, and that the playlist is visible to it |
| Files owned by `root` on the host | Container runs as root by default | Set `PUID`/`PGID` in `.env` and recreate |
| Playlist file has fewer tracks than Apple shows | Some tracks are unavailable in your storefront | Expected. The count is shown as "missing" in the UI |
| Downloader keeps restarting | Look at the actual error | **Activity** tab, or `docker compose logs gamdl-downloader` |
| UI loads but shows "downloader not responding" | Downloader container is down | `docker compose ps`, then check its logs |
| Build fails fetching N_m3u8DL-RE | Network blocks GitHub | Keep `NM3U8DLRE_VERSION=pinned` (the default) |

Logs are at `config/logs/downloader.log` on the host, and in the **Activity**
tab, which streams them live. Credentials are redacted before anything is
written.

---

## Upgrading from v1

```bash
git pull && docker compose up -d --build
```

Nothing else. On first start the daemon migrates `settings.json` to the current
schema, moves any playlist files left in the old `Playlists/` folder, upgrades
the name cache format, and tightens permissions on the cookie files. Your
library, playlists and settings carry over.

Two things change on disk: playlist files are now `.m3u8` with an `#EXTM3U`
header (previously bare-path `.m3u`), and `config/webui.env` is removed because
nothing read it. See [docs/MIGRATION.md](docs/MIGRATION.md) for the details.

---

## Development

```bash
# Downloader
cd downloader
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest              # unit tests
.venv/bin/ruff check .        # lint

# Web UI
cd webui
npm ci
npm run typecheck
npm test
npm run dev                   # http://localhost:3000
```

The downloader's tests do not need gamdl installed, and none of them touch the
network.

Further reading: [architecture](docs/ARCHITECTURE.md) ·
[migration](docs/MIGRATION.md) · [troubleshooting](docs/TROUBLESHOOTING.md)

---

## Credits

Downloading is done by [gamdl](https://github.com/glomatico/gamdl) and
[N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE). This project schedules
them, keeps the playlist files honest, and puts a UI on top.

Use it with an Apple Music subscription, for content you are entitled to.

MIT licensed.
