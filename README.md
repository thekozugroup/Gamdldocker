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

## Key Environment Variables

- `FREQUENCY=3600`
- `OUTPUT_LOCATION=/data/music`
- `PLAYLIST_M3U_DIR=/data/music/playlists`
- `DOWNLOAD_MODE=nm3u8dlre`
- `AUTO_UPDATE=true`
- `AUTO_UPDATE_INTERVAL=86400`
- `TZ=America/New_York`

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
