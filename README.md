# Gamdl Docker + WebUI

Polished Apple Music playlist downloader stack with:

- `gamdl-downloader` (scheduled sync loop)
- `gamdl-webui` (playlist + settings + cookie upload UI)
- default downloader mode set to **N_m3u8DL-RE**
- automatic in-container tool updates (gamdl + N_m3u8DL-RE)

## Highlights

- **N_m3u8DL-RE default mode**
  - `DOWNLOAD_MODE=nm3u8dlre` is the default in settings and runtime env.
  - Entry point passes `--download-mode nm3u8dlre` when supported by installed `gamdl`.

- **Automatic updates**
  - Downloader container auto-updates tools on interval:
    - `AUTO_UPDATE=true`
    - `AUTO_UPDATE_INTERVAL=86400` (24h)
  - Optional Watchtower service is included behind profile `updates`.

- **Persistent cookie upload**
  - WebUI accepts Netscape cookie uploads.
  - Uploaded cookie file is persisted to both:
    - `config/music.apple.com_cookies.txt`
    - `config/cookies.txt`
  - Downloader reads `config/cookies.txt`, with automatic mirror fallback from `music.apple.com_cookies.txt`.

- **Playlist m3u export location**
  - Playlist files are moved into `/playlists` under the music output folder.
  - Default path: `PLAYLIST_M3U_DIR=/data/music/playlists`.

- **Theme mode toggle**
  - Web UI includes **Light**, **Dark**, and **System** appearance modes.

## Quick Start (Local Laptop)

From this folder (`Github/`):

```bash
cp .env.example .env
docker compose up -d --build
```

Open:

- Web UI: `http://localhost:3000`

Stop:

```bash
docker compose down
```

## Optional: Enable Watchtower Auto-Image Updates

```bash
docker compose --profile updates up -d
```

This only updates pullable tagged images (`gamdl-downloader:latest`, `gamdl-webui:latest`) when they are available.

## Cookie Setup

### Preferred (Web UI)

1. Open **Settings** tab.
2. Upload your Netscape `cookies.txt` export.
3. Verify status badge shows cookie file loaded.

### Manual (filesystem)

Place your cookie file at either path:

- `config/music.apple.com_cookies.txt` (preferred)
- `config/cookies.txt`

## Playlist Setup

Add playlist URLs from the UI, or edit:

- `config/playlists.txt`

One URL per line. `#` comments are allowed.

If no playlists are configured, downloader stays alive and retries every 60s.

## Playlist naming

Playlist `.m3u8` files are written to `PLAYLIST_M3U_DIR` (default `/data/music/playlists`). Naming rules:

1. **Source of truth.** The downloader uses Apple Music's stored playlist title, cached in `config/playlist-name-cache.json`. The web UI keeps this cache in sync as it resolves URLs against the Apple API.
2. **Sanitization.** `\ / : * ? " < > |` and ASCII control characters are stripped from the title. Trailing dots/spaces are trimmed (Windows refuses them). Emoji and Unicode letters are preserved by default — `🪨 roll.m3u8`, `💍.m3u8`, and `¯\_(ツ)_/¯.m3u8` round-trip cleanly on ext4 / APFS / NTFS / Tailscale-served Syncthing peers.
3. **Case-insensitive collision suffix.** If two playlists in the same cycle resolve to names that differ only in case (e.g. `Jams` and `jams`), the second one gets a `(<short-id>)` suffix (last 6 chars of the `pl.u-...` ID). This keeps both files visible on macOS HFS+/APFS, Windows NTFS, and exFAT.
4. **Manual overrides.** When Apple's stored title is wrong (or you want a different display name), copy `config/playlist-overrides.json.example` to `config/playlist-overrides.json` and add entries:

   ```json
   {
     "https://music.apple.com/us/playlist/jams/pl.u-EXAMPLE111111": "Bops"
   }
   ```

   Overrides take precedence over the cached API name. Sanitization and collision suffixing still apply. The override file is gitignored; the example is tracked.
5. **Cross-platform sync mode.** Set `SAFE_FILENAMES=true` in `.env` to additionally strip non-ASCII characters. Use this only when targeting legacy SMB or exFAT shares that mishandle UTF-8.

Run the naming-helper tests locally:

```bash
bats tests/test_sanitize.bats
```

## Key Environment Variables

- `BIND_HOST=0.0.0.0` (host interface for WebUI; set to a Tailscale IP / `127.0.0.1` to restrict)
- `WEBUI_PORT=3000` (host port mapped to container's 3000)
- `FREQUENCY=3600`
- `OUTPUT_LOCATION=/data/music`
- `PLAYLIST_M3U_DIR=/data/music/playlists`
- `DOWNLOAD_MODE=nm3u8dlre`
- `AUTO_UPDATE=true`
- `AUTO_UPDATE_INTERVAL=86400`
- `PLAYLIST_OVERRIDES_FILE=/config/playlist-overrides.json` (optional; absent = no overrides)
- `SAFE_FILENAMES=false` (set `true` to strip non-ASCII for legacy SMB / exFAT)
- `TZ=America/New_York`

## Restricting WebUI to a private interface

By default the UI binds to `0.0.0.0:3000` (every interface). To restrict it to a private interface (e.g. Tailscale, loopback), set `BIND_HOST` in `.env`:

```bash
# Tailscale-only access
BIND_HOST=100.x.y.z

# Loopback only
BIND_HOST=127.0.0.1
```

## API Endpoints (WebUI)

- `GET/POST /api/settings`
- `GET/POST/DELETE /api/playlists`
- `POST /api/download` (restarts downloader container to trigger immediate cycle)
- `GET/POST /api/cookies`

## Deploy to Server Later

This same folder is server-ready. After syncing to server:

```bash
docker compose up -d --build
```

For remote host permission issues, run docker commands with `sudo`.
