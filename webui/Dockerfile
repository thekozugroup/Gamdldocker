# syntax=docker/dockerfile:1
#
# Web UI image.
#
# Notably absent compared to v1: docker-cli. The UI used to shell out to
# `docker restart` and `docker logs`, which required mounting the host's docker
# socket — an enormous amount of privilege for two features that are now a file
# write and a file read.

FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:25-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:25-alpine AS runner

LABEL org.opencontainers.image.title="gamdl-webui" \
      org.opencontainers.image.description="Web interface for the gamdl playlist downloader" \
      org.opencontainers.image.source="https://github.com/thekozugroup/Gamdldocker" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CONFIG_DIR=/config

# wget is used by the healthcheck only; tini forwards signals so the container
# stops promptly instead of waiting out the kill timeout.
RUN apk add --no-cache tini wget su-exec

# Next's standalone output already contains its own minimal node_modules.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Deliberately root by default. Both containers read and write the same files in
# /config, so they must agree on a user, and root is what v1 used — changing it
# unilaterally would break every existing install's file ownership. Set PUID and
# PGID on BOTH services to run unprivileged; the entrypoint drops to them.
# Without the docker socket this container no longer has a path to the host.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
CMD ["node", "server.js"]
