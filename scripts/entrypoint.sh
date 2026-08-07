#!/bin/sh
# Container entrypoint for the downloader service.
#
# The sync logic lives in the gamdl_sync Python package; this script only does
# the two things that genuinely belong in shell: adjust ownership when the user
# asked for a specific UID/GID, and hand off to the daemon as PID 1's child so
# signals reach it.
#
# It stays at /app/entrypoint.sh because that is the ENTRYPOINT existing installs
# already have baked into their containers.
set -eu

CONFIG_DIR="${CONFIG_DIR:-/config}"
OUTPUT_DIR="${OUTPUT_DIR:-${OUTPUT_LOCATION:-/data/music}}"
TEMP_PATH="${TEMP_PATH:-/data/temp}"

# `docker run --user`, `gamdl-sync doctor`, etc. still work: anything after the
# entrypoint that is not the daemon is executed verbatim.
if [ "$#" -gt 0 ] && [ "$1" != "run" ]; then
    exec "$@"
fi

mkdir -p "$CONFIG_DIR" "$OUTPUT_DIR" "$TEMP_PATH" "$CONFIG_DIR/logs" "$CONFIG_DIR/control" 2>/dev/null || true

# PUID/PGID is the convention every self-hosted media stack uses, and without it
# downloaded files land on the host owned by root. Unset means "stay as we are",
# which is what existing installs already do.
if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        TARGET_UID="${PUID:-1000}"
        TARGET_GID="${PGID:-1000}"

        if ! getent group "$TARGET_GID" >/dev/null 2>&1; then
            groupadd -g "$TARGET_GID" gamdl 2>/dev/null || true
        fi
        if ! getent passwd "$TARGET_UID" >/dev/null 2>&1; then
            useradd -u "$TARGET_UID" -g "$TARGET_GID" -M -s /usr/sbin/nologin gamdl 2>/dev/null || true
        fi

        # Only the config volume is chowned unconditionally: a large music
        # library would take minutes to walk on every start, so it is left alone
        # unless its root is wrong.
        chown -R "$TARGET_UID:$TARGET_GID" "$CONFIG_DIR" 2>/dev/null || true
        chown "$TARGET_UID:$TARGET_GID" "$OUTPUT_DIR" "$TEMP_PATH" 2>/dev/null || true

        # The virtualenv and the N_m3u8DL-RE binary too, or self-update breaks:
        # pip cannot write to a root-owned /opt/venv as an unprivileged user, so
        # the documented fix for root-owned files would silently disable the
        # documented auto-update, and nothing would say why.
        chown -R "$TARGET_UID:$TARGET_GID" "${VIRTUAL_ENV:-/opt/venv}" 2>/dev/null || true
        chown "$TARGET_UID:$TARGET_GID" \
            "${NM3U8DLRE_PATH:-/usr/local/bin/N_m3u8DL-RE}" \
            "$(dirname "${NM3U8DLRE_PATH:-/usr/local/bin/N_m3u8DL-RE}")" 2>/dev/null || true

        echo "Running as UID ${TARGET_UID}, GID ${TARGET_GID}"
        exec gosu "$TARGET_UID:$TARGET_GID" python -m gamdl_sync --config-dir "$CONFIG_DIR" run
    else
        echo "PUID/PGID set but the container is not running as root — ignoring." >&2
    fi
fi

exec python -m gamdl_sync --config-dir "$CONFIG_DIR" run
