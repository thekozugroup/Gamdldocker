// Mirror of downloader/gamdl_sync/daemon.py `Paths` — both processes must agree
// on where every shared file lives under the /config volume.
import path from 'path'

export const CONFIG_DIR = process.env.CONFIG_DIR || '/config'

export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
export const PLAYLISTS_FILE = path.join(CONFIG_DIR, 'playlists.txt')
export const STATUS_FILE = path.join(CONFIG_DIR, 'playlist-status.json')
export const NAME_CACHE_FILE = path.join(CONFIG_DIR, 'playlist-name-cache.json')
export const OVERRIDES_FILE = path.join(CONFIG_DIR, 'playlist-overrides.json')
export const CONTROL_DIR = path.join(CONFIG_DIR, 'control')
export const HEARTBEAT_FILE = path.join(CONFIG_DIR, '.downloader-heartbeat')
export const LOGS_DIR = path.join(CONFIG_DIR, 'logs')
export const DOWNLOADER_LOG = path.join(LOGS_DIR, 'downloader.log')
export const COOKIES_FILE = path.join(CONFIG_DIR, 'cookies.txt')
export const APPLE_COOKIES_FILE = path.join(CONFIG_DIR, 'music.apple.com_cookies.txt')
