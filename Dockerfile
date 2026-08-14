# syntax=docker/dockerfile:1
#
# Downloader image: gamdl plus the scheduling daemon that drives it.
#
# Built in two stages so the runtime layer carries no compilers or build caches.
# The N_m3u8DL-RE download is *verified* rather than best-effort — v1 used
# `|| true`, which meant a network hiccup during a build produced an image that
# started fine and then failed every download.

# --------------------------------------------------------------------------- #
# Stage 1 — build the virtualenv
# --------------------------------------------------------------------------- #
FROM python:3.14-slim AS builder

# Empty means "whatever is current at build time". Pin it (e.g. 3.8.5) for a
# reproducible image; the runtime auto-update can still move forward from there.
ARG GAMDL_VERSION=""

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# gamdl first, on its own layer: it is the slowest install and the one most
# likely to change, so keeping it separate keeps rebuilds of our own code fast.
RUN if [ -n "$GAMDL_VERSION" ]; then \
        pip install --no-cache-dir "gamdl==${GAMDL_VERSION}"; \
    else \
        pip install --no-cache-dir gamdl; \
    fi \
    && pip install --no-cache-dir mutagen \
    && gamdl --version

# N_m3u8DL-RE.
#
# Pinned by default so the build is reproducible and does not depend on the
# GitHub API being reachable — a build that dies because api.github.com is
# rate-limited, blocked by a corporate proxy, or simply down is not a build
# anyone can rely on. The runtime updater moves this forward on first run, so the
# pin is a floor rather than a ceiling. Set NM3U8DLRE_VERSION=latest to resolve
# the newest release at build time instead.
#
# Either way the binary is executed before the image is accepted. v1 used
# `|| true` here, which shipped images that started cleanly and then failed every
# single download.
ARG NM3U8DLRE_VERSION=pinned
# For networks where github.com is unreachable entirely: point this at any
# mirror serving the release tarball and the version logic is bypassed.
ARG NM3U8DLRE_URL=""
RUN set -eu; \
    arch="$(uname -m)"; \
    case "$arch" in \
        x86_64|amd64) \
            pattern='linux-x64'; \
            pinned='https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.2.1/N_m3u8DL-RE_v0.2.1_linux-x64_20240828.tar.gz' ;; \
        aarch64|arm64) \
            pattern='linux-arm64'; \
            pinned='https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.2.2/N_m3u8DL-RE_v0.2.2_linux-arm64.tar.gz' ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    if [ -n "$NM3U8DLRE_URL" ]; then \
        url="$NM3U8DLRE_URL"; \
    elif [ "$NM3U8DLRE_VERSION" = "latest" ]; then \
        url="$(curl -fsSL --retry 3 --retry-delay 2 --max-time 60 \
               https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest \
               | grep -Eo 'https://[^"]+\.tar\.gz' | grep -F "$pattern" | head -n1)"; \
        if [ -z "$url" ]; then \
            echo "could not resolve the latest N_m3u8DL-RE for $arch" >&2; exit 1; \
        fi; \
    elif [ "$NM3U8DLRE_VERSION" = "pinned" ]; then \
        url="$pinned"; \
    else \
        url="https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v${NM3U8DLRE_VERSION}/N_m3u8DL-RE_v${NM3U8DLRE_VERSION}_${pattern}.tar.gz"; \
    fi; \
    echo "Fetching $url"; \
    curl -fsSL --retry 3 --retry-delay 2 --max-time 300 "$url" -o /tmp/re.tar.gz; \
    mkdir -p /tmp/re && tar -xzf /tmp/re.tar.gz -C /tmp/re; \
    binary="$(find /tmp/re -type f -name 'N_m3u8DL-RE' | head -n1)"; \
    if [ -z "$binary" ]; then echo "N_m3u8DL-RE missing from the archive" >&2; exit 1; fi; \
    install -m 0755 "$binary" /opt/N_m3u8DL-RE; \
    rm -rf /tmp/re /tmp/re.tar.gz; \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 /opt/N_m3u8DL-RE --version >/dev/null 2>&1 \
      || DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 /opt/N_m3u8DL-RE --help >/dev/null 2>&1 \
      || { echo "the downloaded N_m3u8DL-RE does not run" >&2; exit 1; }

# Our own source goes last: it changes on every commit, and everything above
# it should survive that.
COPY downloader/pyproject.toml /src/downloader/
COPY downloader/gamdl_sync /src/downloader/gamdl_sync
RUN pip install --no-cache-dir --no-deps /src/downloader

# Record what shipped, so the runtime updater knows what to roll back to.
RUN gamdl --version > /opt/gamdl-baseline 2>&1 || echo "unknown" > /opt/gamdl-baseline

# --------------------------------------------------------------------------- #
# Stage 2 — runtime
# --------------------------------------------------------------------------- #
FROM python:3.14-slim

LABEL org.opencontainers.image.title="gamdl-downloader" \
      org.opencontainers.image.description="Scheduled Apple Music playlist sync built on gamdl" \
      org.opencontainers.image.source="https://github.com/thekozugroup/Gamdldocker" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
        gosu \
        procps \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    # Debian's ffmpeg hard-depends on the Mesa stack, which drags in LLVM, a
    # software rasteriser and a theorem prover — 191 MB of GPU machinery in an
    # image that only ever touches audio. `--no-install-recommends` cannot drop
    # them because they are real dependencies, and ffmpeg does not link any of
    # them (verified with ldd). Removing the files was checked against the three
    # operations gamdl actually performs — AAC encode, remux, and stream copy —
    # all of which produce byte-identical output afterwards.
    && rm -f /usr/lib/*/libLLVM*.so* \
             /usr/lib/*/libgallium*.so* \
             /usr/lib/*/libz3.so* \
    && rm -rf /usr/lib/*/dri /usr/lib/*/gallium-pipe \
    # Prove it still works, so a future base-image change cannot ship a broken
    # ffmpeg silently.
    && ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=1" \
              -c:a aac -f mp4 /tmp/ffmpeg-check.m4a -y \
    && ffmpeg -loglevel error -i /tmp/ffmpeg-check.m4a -c copy -f mp4 /tmp/ffmpeg-copy.m4a -y \
    && rm -f /tmp/ffmpeg-check.m4a /tmp/ffmpeg-copy.m4a

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/N_m3u8DL-RE /usr/local/bin/N_m3u8DL-RE
COPY --from=builder /opt/gamdl-baseline /app/.gamdl-baseline

ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CONFIG_DIR=/config \
    OUTPUT_DIR=/data/music \
    TEMP_PATH=/data/temp \
    COOKIES_PATH=/config/cookies.txt \
    NM3U8DLRE_PATH=/usr/local/bin/N_m3u8DL-RE \
    DOWNLOAD_MODE=nm3u8dlre \
    FREQUENCY=3600 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

WORKDIR /app
RUN mkdir -p /config /data/music /data/temp

COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# A file the daemon refreshes as it works, so the check proves progress rather
# than merely proving a process exists.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import json,sys,time; b=json.load(open('/config/.downloader-heartbeat')); sys.exit(0 if time.time()-b['ts'] < 900 and b.get('stalledFor', 0) < 3600 else 1)" || exit 1

# tini reaps the zombies that ffmpeg and N_m3u8DL-RE leave behind and forwards
# signals, so `docker stop` is clean instead of a 10-second timeout and a kill.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["run"]
