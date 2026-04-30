FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    tar \
    xz-utils \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install gamdl
RUN pip install --no-cache-dir gamdl

# Patch gamdl regex for newer Apple Music index bundle names.
# Tolerant: gamdl 2.x exposes the regex in gamdl.apple_music_api, gamdl 3.x
# moved it to gamdl.api. No-op if neither module exists or the legacy
# pattern is already gone — keeps the build green across upstream churn.
RUN python - <<'PY'
from pathlib import Path
import importlib

OLD = r'r"/(assets/index-legacy-[^/]+\.js)",'
NEW = r'r"/(assets/index(?:-legacy)?-[^/]+\.js)",'

for mod_name in ("gamdl.api", "gamdl.apple_music_api"):
    try:
        module = importlib.import_module(mod_name)
    except Exception:
        continue
    file_path = Path(module.__file__)
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception:
        continue
    if OLD in content and NEW not in content:
        file_path.write_text(content.replace(OLD, NEW), encoding="utf-8")
        print(f"patched {mod_name}")
        break
else:
    print("no patch needed (regex already current or module renamed again)")
PY

# Patch gamdl 3.x _update_playlist_file: when Apple metadata reports
# playlist_track == 0 (rare, but happens for some single-track media),
# the upstream code falls through to `playlist_file_lines[-1]` on an
# empty list and raises IndexError, aborting the track. Guard with an
# early return so the rest of the cycle continues.
RUN python - <<'PY'
from pathlib import Path
import importlib

try:
    module = importlib.import_module("gamdl.downloader.downloader")
except Exception:
    print("gamdl.downloader.downloader not found — skipping playlist-track guard")
else:
    file_path = Path(module.__file__)
    content = file_path.read_text(encoding="utf-8")
    old = (
        '        if len(playlist_file_lines) < playlist_track:\n'
        '            playlist_file_lines.extend('
    )
    new = (
        '        if playlist_track is None or playlist_track < 1:\n'
        '            log.debug("skipping m3u write: playlist_track is None or < 1")\n'
        '            return\n'
        '        if len(playlist_file_lines) < playlist_track:\n'
        '            playlist_file_lines.extend('
    )
    if old in content and "skipping m3u write: playlist_track" not in content:
        file_path.write_text(content.replace(old, new), encoding="utf-8")
        print("patched gamdl.downloader.downloader._update_playlist_file")
    else:
        print("playlist-track guard not needed")
PY

# Install N_m3u8DL-RE
# We verify architecture to download the correct binary
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        RE_URL="https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.2.1/N_m3u8DL-RE_v0.2.1_linux-x64_20240828.tar.gz"; \
        curl -fL -o /tmp/N_m3u8DL-RE.tar.gz "$RE_URL" || true; \
    elif [ "$ARCH" = "aarch64" ]; then \
        RE_URL="https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.2.2/N_m3u8DL-RE_v0.2.2_linux-arm64.tar.gz"; \
        curl -fL -o /tmp/N_m3u8DL-RE.tar.gz "$RE_URL" || true; \
    fi && \
    if [ -f /tmp/N_m3u8DL-RE.tar.gz ]; then \
        tar -xzf /tmp/N_m3u8DL-RE.tar.gz -C /tmp && \
        find /tmp -name "N_m3u8DL-RE" -type f -exec mv {} /usr/local/bin/N_m3u8DL-RE \; && \
        chmod +x /usr/local/bin/N_m3u8DL-RE; \
    fi && \
    rm -rf /tmp/N_m3u8DL-RE.tar.gz /tmp/N_m3u8DL-RE*

# Setup directories
WORKDIR /app
RUN mkdir -p /config /data/music /data/temp

# Copy scripts
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environment variables defaults
ENV FREQUENCY="3600"
ENV COOKIES_PATH="/config/cookies.txt"
ENV OUTPUT_DIR="/data/music"
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT="1"

ENTRYPOINT ["/app/entrypoint.sh"]
