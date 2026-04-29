#!/bin/bash
set -e
set -o pipefail

# When the test harness (bats) sources this file we just want the helper
# function definitions, not the banner / main loop. Callers set
# ENTRYPOINT_SOURCE_ONLY=1 before sourcing.
if [ -z "${ENTRYPOINT_SOURCE_ONLY:-}" ]; then
  echo "Starting gamdl downloader service..."
fi

FREQUENCY=${FREQUENCY:-3600}
COOKIES_PATH=${COOKIES_PATH:-/config/cookies.txt}
OUTPUT_DIR=${OUTPUT_DIR:-${OUTPUT_LOCATION:-/data/music}}
PLAYLIST_M3U_DIR=${PLAYLIST_M3U_DIR:-${OUTPUT_DIR%/}/playlists}
TEMP_PATH=${TEMP_PATH:-/data/temp}
NM3U8DLRE_PATH=${NM3U8DLRE_PATH:-/usr/local/bin/N_m3u8DL-RE}
DOWNLOAD_MODE=${DOWNLOAD_MODE:-nm3u8dlre}
AUTO_UPDATE=${AUTO_UPDATE:-true}
AUTO_UPDATE_INTERVAL=${AUTO_UPDATE_INTERVAL:-86400}
AUTO_UPDATE_GAMDL=${AUTO_UPDATE_GAMDL:-false}
STATUS_FILE=/config/playlist-status.json
NAME_CACHE_FILE=${NAME_CACHE_FILE:-/config/playlist-name-cache.json}
PLAYLIST_OVERRIDES_FILE=${PLAYLIST_OVERRIDES_FILE:-/config/playlist-overrides.json}
SAFE_FILENAMES=${SAFE_FILENAMES:-false}
LAST_UPDATE_TS=0
PYBIN=${PYBIN:-$(command -v python || command -v python3)}

if [ -z "${ENTRYPOINT_SOURCE_ONLY:-}" ]; then
  echo "Configuration:"
  echo "  Frequency: ${FREQUENCY} seconds"
  echo "  Cookies path: ${COOKIES_PATH}"
  echo "  Output directory: ${OUTPUT_DIR}"
  echo "  Playlist m3u directory: ${PLAYLIST_M3U_DIR}"
  echo "  Temp path: ${TEMP_PATH}"
  echo "  Download mode: ${DOWNLOAD_MODE}"
  echo "  Auto update: ${AUTO_UPDATE}"
  echo "  Auto update gamdl: ${AUTO_UPDATE_GAMDL}"
fi

if [ -z "${ENTRYPOINT_SOURCE_ONLY:-}" ] && ! command -v gamdl >/dev/null 2>&1; then
  echo "Error: gamdl is not installed"
  exit 1
fi

if [ -z "${ENTRYPOINT_SOURCE_ONLY:-}" ]; then
  if [ ! -f "$COOKIES_PATH" ] && [ -f /config/music.apple.com_cookies.txt ]; then
    cp /config/music.apple.com_cookies.txt "$COOKIES_PATH"
  fi

  if [ ! -f "$COOKIES_PATH" ]; then
    echo "Warning: Cookies file not found at $COOKIES_PATH"
  fi
fi

refresh_runtime_settings() {
  if [ ! -f /config/settings.json ]; then
    return
  fi

  eval "$(python - <<'PY'
import json
import shlex

try:
    with open('/config/settings.json', 'r', encoding='utf-8') as f:
        s = json.load(f)
except Exception:
    s = {}

def emit(name, value):
    print(f"{name}={shlex.quote(str(value))}")

emit('FREQUENCY', int(s.get('frequency', 3600) or 3600))
emit('OUTPUT_DIR', s.get('outputLocation', '/data/music') or '/data/music')
playlist_dir = s.get('playlistM3uDir', '') or ''
if not playlist_dir:
    playlist_dir = f"{s.get('outputLocation', '/data/music').rstrip('/')}/playlists"
emit('PLAYLIST_M3U_DIR', playlist_dir)
emit('DOWNLOAD_MODE', s.get('downloadMode', 'nm3u8dlre') or 'nm3u8dlre')
emit('AUTO_UPDATE', bool(s.get('autoUpdate', True)).__str__().lower())
emit('AUTO_UPDATE_INTERVAL', int(s.get('autoUpdateInterval', 86400) or 86400))
PY
)"

  if ! [[ "$FREQUENCY" =~ ^[0-9]+$ ]]; then
    FREQUENCY=3600
  fi
  if [ "$FREQUENCY" -lt 60 ]; then
    FREQUENCY=60
  fi
}

update_tools() {
  if [ "$AUTO_UPDATE" != "true" ]; then
    return
  fi

  local now
  now=$(date +%s)
  if [ $((now - LAST_UPDATE_TS)) -lt "$AUTO_UPDATE_INTERVAL" ]; then
    return
  fi

  echo "[$(date)] Auto-update check started"

  if [ "$AUTO_UPDATE_GAMDL" = "true" ]; then
    pip install --no-cache-dir --upgrade gamdl >/tmp/gamdl-update.log 2>&1 || echo "[$(date)] gamdl update skipped"
  fi

  local arch
  arch=$(uname -m)
  local asset_pattern
  if [ "$arch" = "x86_64" ]; then
    asset_pattern='linux-x64.*\.tar\.gz'
  elif [ "$arch" = "aarch64" ]; then
    asset_pattern='linux-arm64.*\.tar\.gz'
  else
    asset_pattern='linux.*\.tar\.gz'
  fi

  local latest_url
  latest_url=$(curl -fsSL "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest" | grep -Eo 'https://[^" ]+\.tar\.gz' | grep -E "$asset_pattern" | head -n 1 || true)

  if [ -n "$latest_url" ]; then
    rm -rf /tmp/nm3u8dlre-update && mkdir -p /tmp/nm3u8dlre-update
    if curl -fsSL "$latest_url" -o /tmp/nm3u8dlre-update/N_m3u8DL-RE.tar.gz; then
      tar -xzf /tmp/nm3u8dlre-update/N_m3u8DL-RE.tar.gz -C /tmp/nm3u8dlre-update
      local binary_path
      binary_path=$(find /tmp/nm3u8dlre-update -type f -name "N_m3u8DL-RE" | head -n 1)
      if [ -n "$binary_path" ]; then
        mv "$binary_path" "$NM3U8DLRE_PATH"
        chmod +x "$NM3U8DLRE_PATH"
      fi
    fi
    rm -rf /tmp/nm3u8dlre-update
  fi

  LAST_UPDATE_TS=$now
  echo "[$(date)] Auto-update check completed"
}

load_playlists() {
  PLAYLIST_URLS_ARRAY=()

  if [ -f /config/playlists.txt ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && PLAYLIST_URLS_ARRAY+=("$line")
    done < <(grep -vE '^\s*#|^\s*$' /config/playlists.txt || true)
  fi

  if [ ${#PLAYLIST_URLS_ARRAY[@]} -eq 0 ] && [ -n "$PLAYLIST_URLS" ]; then
    # shellcheck disable=SC2206
    PLAYLIST_URLS_ARRAY=($PLAYLIST_URLS)
  fi
}

# Extract last 6 hex chars from a playlist URL ID like pl.u-XXXXXXXXXXXX.
# Falls back to a hash of the URL if no pl.<...> id is present.
playlist_short_id() {
  "$PYBIN" - "$1" <<'PY'
import hashlib
import re
import sys

url = sys.argv[1]
m = re.search(r'pl\.[A-Za-z0-9]+-?([A-Za-z0-9]+)', url)
if m:
    print(m.group(1)[-6:])
else:
    print(hashlib.sha1(url.encode('utf-8')).hexdigest()[:6])
PY
}

# sanitize_filename: strip cross-platform-unsafe chars, collapse whitespace,
# trim, drop trailing dots. Preserves Unicode (emoji, CJK, etc.) by default.
# When SAFE_FILENAMES=true (env), strip non-ASCII as well.
# Args: $1 = raw name, $2 = fallback (used when sanitized result is empty).
sanitize_filename() {
  SAFE_FILENAMES_ENV="$SAFE_FILENAMES" "$PYBIN" - "$1" "${2:-playlist}" <<'PY'
import os
import re
import sys
import unicodedata

name = sys.argv[1] or ''
fallback = sys.argv[2] or 'playlist'
safe_mode = os.environ.get('SAFE_FILENAMES_ENV', 'false').lower() == 'true'

name = unicodedata.normalize('NFC', name)
# Strip ASCII control chars (\x00-\x1f) and the unsafe set \ / : * ? " < > |
name = re.sub(r'[\x00-\x1f\\/:*?"<>|]', '', name)
# Optional ASCII-only mode for legacy SMB / exFAT
if safe_mode:
    name = name.encode('ascii', 'ignore').decode('ascii')
# Collapse whitespace runs
name = re.sub(r'\s+', ' ', name).strip()
# Trim trailing dots and spaces (Windows refuses them)
name = re.sub(r'[.\s]+$', '', name)

if not name:
    name = fallback

print(name)
PY
}

# resolve_playlist_name: returns the final folder/filename (no extension)
# Order: overrides.json -> name cache -> URL slug fallback. Sanitized.
# Args: $1 = playlist URL.
resolve_playlist_name() {
  local playlist_url="$1"
  local override
  override=$(lookup_override_name "$playlist_url" || true)
  if [ -n "$override" ]; then
    sanitize_filename "$override" "$(playlist_short_id "$playlist_url")"
    return
  fi

  local cached
  cached=$(lookup_name_cache "$playlist_url" || true)
  if [ -n "$cached" ]; then
    sanitize_filename "$cached" "$(playlist_short_id "$playlist_url")"
    return
  fi

  local slug
  slug=$(playlist_filename_from_url "$playlist_url")
  sanitize_filename "$slug" "$(playlist_short_id "$playlist_url")"
}

lookup_override_name() {
  [ -f "$PLAYLIST_OVERRIDES_FILE" ] || { echo ""; return; }
  "$PYBIN" - "$PLAYLIST_OVERRIDES_FILE" "$1" <<'PY'
import json
import sys

path, url = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    print('')
    raise SystemExit
val = data.get(url)
if isinstance(val, str):
    print(val)
else:
    print('')
PY
}

lookup_name_cache() {
  [ -f "$NAME_CACHE_FILE" ] || { echo ""; return; }
  "$PYBIN" - "$NAME_CACHE_FILE" "$1" <<'PY'
import json
import sys

path, url = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    print('')
    raise SystemExit
entry = data.get(url)
if isinstance(entry, str):
    print(entry)
elif isinstance(entry, dict):
    name = entry.get('name')
    print(name if isinstance(name, str) else '')
else:
    print('')
PY
}

# _lower: lowercase a string via tr. Extracted so uniquify_playlist_name has
# one canonical lowercasing call site (was duplicated inline).
_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# uniquify_playlist_name: given a sanitized name and URL, append " (<short-id>)"
# on case-insensitive collision within this run. Uses the global SEEN_LC array.
# Args: $1 = sanitized name, $2 = playlist URL.
# Sets the global UNIQUE_NAME and also prints the deduped name on stdout.
# Note: when called via $(...) the SEEN_LC update happens in a subshell and
# is lost. Callers that need the collision tracker to persist should invoke
# this function directly and read $UNIQUE_NAME instead of using command
# substitution.
uniquify_playlist_name() {
  local name="$1"
  local playlist_url="$2"
  local lc
  lc=$(_lower "$name")
  if [ -n "${SEEN_LC[$lc]:-}" ]; then
    local short
    short=$(playlist_short_id "$playlist_url")
    name="${name} (${short})"
    lc=$(_lower "$name")
  fi
  SEEN_LC[$lc]=1
  UNIQUE_NAME="$name"
  printf '%s' "$name"
}

# Update name cache with the resolved name (so subsequent runs are deterministic)
update_name_cache_entry() {
  local playlist_url="$1"
  local resolved_name="$2"
  "$PYBIN" - "$NAME_CACHE_FILE" "$playlist_url" "$resolved_name" <<'PY'
import json
import os
import sys

path, url, name = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}
entry = data.get(url) or {}
if isinstance(entry, str):
    entry = {'name': entry}
entry['name'] = name
data[url] = entry
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
try:
    os.chmod(path, 0o600)
except OSError:
    pass
PY
}

playlist_filename_from_url() {
  "$PYBIN" - "$1" <<'PY'
from urllib.parse import urlparse, unquote
import re
import sys
import unicodedata

url = sys.argv[1]
name = 'playlist'
try:
    parts = [p for p in urlparse(url).path.split('/') if p]
    if 'playlist' in parts:
        idx = parts.index('playlist')
        if idx + 1 < len(parts):
            raw = unquote(parts[idx + 1])
            # URL slugs use hyphens for spaces; restore them
            # but only if the slug looks like an ASCII URL slug (no emoji/CJK)
            if re.fullmatch(r'[\x00-\x7F]+', raw):
                raw = re.sub(r'^m-', '', raw, flags=re.I)
                raw = raw.replace('-', ' ').replace('+', ' ')
            name = raw
except Exception:
    pass

name = unicodedata.normalize('NFC', name)
# Replace filesystem-unsafe characters
name = re.sub(r'[/<>:"\\|?*]', ' ', name)
name = re.sub(r'\s+', ' ', name).strip()
print(name or 'playlist')
PY
}

canonicalize_playlist_filename() {
  python - "$1" <<'PY'
import re
import sys
import unicodedata

name = sys.argv[1] or 'playlist'
# Strip file extensions
name = re.sub(r'\.(m3u8?|txt)$', '', name, flags=re.I)
# Normalize Unicode (NFC for consistency)
name = unicodedata.normalize('NFC', name)
# Replace filesystem-unsafe characters only (keep everything else including emoji)
name = re.sub(r'[/<>:"\\|?*]', ' ', name)
# Collapse whitespace
name = re.sub(r'\s+', ' ', name).strip()

print(name or 'playlist')
PY
}

get_previous_playlist_file() {
  python - "$STATUS_FILE" "$1" <<'PY'
import json
import os
import sys

status_file, url = sys.argv[1:3]
if not os.path.exists(status_file):
    print('')
    raise SystemExit
try:
    data = json.load(open(status_file, 'r', encoding='utf-8'))
except Exception:
    print('')
    raise SystemExit
print((data.get(url) or {}).get('playlistFile') or '')
PY
}

set_status_single() {
  local playlist_url="$1"
  local new_status="$2"
  local song_count="${3:-}"
  local playlist_file="${4:-}"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  python - "$STATUS_FILE" "$playlist_url" "$new_status" "$timestamp" "$song_count" "$playlist_file" <<'PY'
import json
import os
import sys

status_file, url, status, timestamp, song_count, playlist_file = sys.argv[1:7]

data = {}
if os.path.exists(status_file):
    try:
        with open(status_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}

entry = data.get(url, {})
entry['status'] = status
if status == 'running':
    entry['startedAt'] = timestamp
if status == 'complete':
    entry['lastDownloaded'] = timestamp
if status == 'failed':
    entry['failedAt'] = timestamp
if song_count:
    try:
      entry['songCount'] = int(song_count)
    except Exception:
      pass
if playlist_file:
    entry['playlistFile'] = playlist_file
data[url] = entry

os.makedirs(os.path.dirname(status_file), exist_ok=True)
with open(status_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
PY
}

migrate_existing_playlist_files() {
  if [ ! -d "$OUTPUT_DIR/Playlists" ]; then
    return
  fi

  while IFS= read -r -d '' file; do
    base_name=$(basename "$file")
    mv -f "$file" "$PLAYLIST_M3U_DIR/$base_name"
    normalize_playlist_paths "$PLAYLIST_M3U_DIR/$base_name"
  done < <(find "$OUTPUT_DIR/Playlists" -type f \( -name "*.m3u" -o -name "*.m3u8" \) -print0 2>/dev/null)
}

normalize_playlist_paths() {
  local playlist_file="$1"
  [ -f "$playlist_file" ] || return

  python - "$playlist_file" <<'PY'
import pathlib
import re
import sys

p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8', errors='ignore')
lines = []
for line in text.splitlines():
    stripped = line.strip()
    if stripped and not stripped.startswith('#'):
        line = re.sub(r'^\.\./\.\./', '../', line)
    lines.append(line)
p.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
PY
}

initialize_statuses_idle() {
  python - "$STATUS_FILE" "${PLAYLIST_URLS_ARRAY[@]}" <<'PY'
import json
import os
import sys

status_file = sys.argv[1]
urls = sys.argv[2:]

data = {}
if os.path.exists(status_file):
    try:
        with open(status_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}

for url in urls:
    entry = data.get(url, {})
    entry['status'] = 'idle'
    data[url] = entry

os.makedirs(os.path.dirname(status_file), exist_ok=True)
with open(status_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
PY
}

cleanup_legacy_slug_files() {
  for playlist_url in "${PLAYLIST_URLS_ARRAY[@]}"; do
    legacy_name=$(playlist_filename_from_url "$playlist_url")
    legacy_file="$PLAYLIST_M3U_DIR/${legacy_name}.m3u8"
    if echo "$legacy_name" | grep -Eq '^pl\.u[[:space:]-]'; then
      rm -f "$legacy_file"
    fi
  done
}

GAMDL_ARGS=(
  --cookies-path "$COOKIES_PATH"
  -o "$OUTPUT_DIR"
  --nm3u8dlre-path "$NM3U8DLRE_PATH"
  --save-playlist
  --no-synced-lyrics
  --temp-path "$TEMP_PATH"
)

if [ -z "${ENTRYPOINT_SOURCE_ONLY:-}" ] && gamdl --help 2>/dev/null | grep -q -- '--download-mode'; then
  GAMDL_ARGS+=(--download-mode "$DOWNLOAD_MODE")
fi

if [ -n "${ENTRYPOINT_SOURCE_ONLY:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

while true; do
  refresh_runtime_settings
  echo "[$(date)] Starting playlist download check (frequency=${FREQUENCY}s)..."
  update_tools

  load_playlists
  if [ ${#PLAYLIST_URLS_ARRAY[@]} -eq 0 ]; then
    echo "[$(date)] No playlists configured yet. Waiting 60 seconds before retry."
    sleep 60
    continue
  fi

  mkdir -p "$PLAYLIST_M3U_DIR"
  migrate_existing_playlist_files
  cleanup_legacy_slug_files
  initialize_statuses_idle

  # Reset case-insensitive collision tracker for this cycle.
  declare -A SEEN_LC=()

  for playlist_url in "${PLAYLIST_URLS_ARRAY[@]}"; do
    echo "[$(date)] Processing playlist: $playlist_url"
    set_status_single "$playlist_url" "running"

    marker_file=$(mktemp)
    touch "$marker_file"

    playlist_log=$(mktemp)
    if gamdl "${GAMDL_ARGS[@]}" "$playlist_url" 2>&1 | tee "$playlist_log"; then
      cycle_status="complete"
    else
      echo "[$(date)] Warning: Download failed for playlist: $playlist_url"
      cycle_status="failed"
    fi

    latest_m3u=$(find "$OUTPUT_DIR" -maxdepth 6 -type f \( -name "*.m3u" -o -name "*.m3u8" \) -newer "$marker_file" -print | head -n 1 || true)
    if [ -z "$latest_m3u" ]; then
      latest_m3u=$(find "$PLAYLIST_M3U_DIR" -maxdepth 1 -type f \( -name "*.m3u" -o -name "*.m3u8" \) -newer "$marker_file" -print | head -n 1 || true)
    fi
    rm -f "$marker_file"

    song_count=""
    playlist_file=""
    # Resolve the canonical name: overrides -> name cache -> URL slug.
    # Apply sanitize_filename + per-cycle case-insensitive collision suffix.
    resolved_name=$(resolve_playlist_name "$playlist_url")
    target_name="$resolved_name"
    target_guess_m3u8="$PLAYLIST_M3U_DIR/${target_name}.m3u8"
    target_guess_m3u="$PLAYLIST_M3U_DIR/${target_name}.m3u"
    if [ -n "$latest_m3u" ]; then
      ext="${latest_m3u##*.}"
      source_name=$(basename "$latest_m3u")
      source_name_no_ext="${source_name%.*}"
      # Prefer the freshly-downloaded source name only when no override is in effect.
      override_name=$(lookup_override_name "$playlist_url" || true)
      if [ -z "$override_name" ]; then
        target_name=$(sanitize_filename "$source_name_no_ext" "$(playlist_short_id "$playlist_url")")
      fi
      uniquify_playlist_name "$target_name" "$playlist_url" >/dev/null
      target_name="$UNIQUE_NAME"
      target_path="$PLAYLIST_M3U_DIR/${target_name}.${ext}"
      if [ "$latest_m3u" != "$target_path" ]; then
        mv -f "$latest_m3u" "$target_path"
      fi
      update_name_cache_entry "$playlist_url" "$target_name"

      previous_playlist_file=$(get_previous_playlist_file "$playlist_url")
      if [ -n "$previous_playlist_file" ] && [ "$previous_playlist_file" != "$target_path" ] && [ -f "$previous_playlist_file" ]; then
        rm -f "$previous_playlist_file"
      fi

      normalize_playlist_paths "$target_path"
      playlist_file="$target_path"
      song_count=$(python - "$target_path" <<'PY'
import sys

count = 0
with open(sys.argv[1], 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#'):
            count += 1
print(count)
PY
)
    else
      # No fresh m3u this cycle; reserve the name in the collision tracker
      # so a later playlist with the same lowercased name gets the suffix.
      uniquify_playlist_name "$target_name" "$playlist_url" >/dev/null
      target_name="$UNIQUE_NAME"
      target_guess_m3u8="$PLAYLIST_M3U_DIR/${target_name}.m3u8"
      target_guess_m3u="$PLAYLIST_M3U_DIR/${target_name}.m3u"
      if [ -f "$target_guess_m3u8" ]; then
        playlist_file="$target_guess_m3u8"
      elif [ -f "$target_guess_m3u" ]; then
        playlist_file="$target_guess_m3u"
      fi
      # Keep the name cache in sync even when no fresh m3u landed — the
      # README claims the cache reflects the name actually in use.
      update_name_cache_entry "$playlist_url" "$target_name"
      if [ -n "$playlist_file" ]; then
        song_count=$(python - "$playlist_file" <<'PY'
import sys

count = 0
with open(sys.argv[1], 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#'):
            count += 1
print(count)
PY
)
      fi
    fi

    if [ -z "$song_count" ]; then
      song_count=$(python - "$playlist_log" <<'PY'
import re
import sys

best = 0
with open(sys.argv[1], 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        m = re.search(r'Track\s+\d+/(\d+)', line)
        if m:
            best = max(best, int(m.group(1)))
print(best if best > 0 else '')
PY
)
    fi

    rm -f "$playlist_log"

    # Gamdl may emit playlist files under /data/music/Playlists/* during a run.
    # Move anything that appeared there into the canonical folder immediately.
    migrate_existing_playlist_files

    set_status_single "$playlist_url" "$cycle_status" "$song_count" "$playlist_file"
  done

  echo "[$(date)] Download cycle completed. Sleeping for $FREQUENCY seconds..."
  sleep "$FREQUENCY"
done
