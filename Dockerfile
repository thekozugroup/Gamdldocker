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

# Patch gamdl regex for newer Apple Music index bundle names
RUN python - <<'PY'
from pathlib import Path
import gamdl.apple_music_api as module

file_path = Path(module.__file__)
content = file_path.read_text(encoding='utf-8')
old = r'r"/(assets/index-legacy-[^/]+\.js)",'
new = r'r"/(assets/index(?:-legacy)?-[^/]+\.js)",'
if old in content and new not in content:
    file_path.write_text(content.replace(old, new), encoding='utf-8')
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
