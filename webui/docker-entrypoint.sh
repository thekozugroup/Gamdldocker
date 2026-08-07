#!/bin/sh
# Web UI entrypoint.
#
# Both containers read and write the same files in /config, so they have to run
# as the same user. PUID/PGID is honoured here exactly as it is in the
# downloader; leaving them unset keeps the previous behaviour of running as root,
# so existing installs are unaffected by an upgrade.
set -eu

CONFIG_DIR="${CONFIG_DIR:-/config}"

mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/control" "$CONFIG_DIR/logs" 2>/dev/null || true

if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        TARGET_UID="${PUID:-1000}"
        TARGET_GID="${PGID:-1000}"

        if ! getent group "$TARGET_GID" >/dev/null 2>&1; then
            addgroup -g "$TARGET_GID" gamdl 2>/dev/null || true
        fi
        if ! getent passwd "$TARGET_UID" >/dev/null 2>&1; then
            adduser -u "$TARGET_UID" -G "$(getent group "$TARGET_GID" | cut -d: -f1)" \
                -H -D -s /sbin/nologin gamdl 2>/dev/null || true
        fi

        # The config directory is small; the music library is not, and the web UI
        # only ever reads it, so it is left alone.
        chown -R "$TARGET_UID:$TARGET_GID" "$CONFIG_DIR" 2>/dev/null || true

        echo "Running as UID ${TARGET_UID}, GID ${TARGET_GID}"
        exec su-exec "$TARGET_UID:$TARGET_GID" "$@"
    else
        echo "PUID/PGID set but the container is not running as root — ignoring." >&2
    fi
fi

exec "$@"
