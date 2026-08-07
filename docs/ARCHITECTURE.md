# Architecture

Two containers, one shared folder, no direct communication between them.

```
                    ┌─────────────────────────────┐
                    │  ./config  (shared volume)  │
  ┌──────────┐      │                             │      ┌────────────────┐
  │  Web UI  │◀────▶│  settings.json              │◀────▶│   Downloader   │
  │ (Next.js)│      │  playlists.txt              │      │    (Python)    │
  │  :3000   │      │  playlist-status.json       │      │                │
  └──────────┘      │  playlist-name-cache.json   │      └───────┬────────┘
                    │  control/    ← commands     │              │
                    │  logs/       → output       │              ▼
                    │  .downloader-heartbeat      │      ┌──────────────┐
                    └─────────────────────────────┘      │ gamdl +      │
                                                         │ N_m3u8DL-RE  │
                                                         └──────┬───────┘
                                                                ▼
                                                          /data/music
```

## Why files instead of a socket or an API

v1 gave the web container the host's Docker socket so it could run
`docker restart` for "sync now" and `docker logs` for the log view. That mount is
equivalent to root on the host — an enormous amount of privilege for two
features. It also meant "sync now" aborted whatever download was in flight.

Both containers already share `./config`. So:

- **Sync now** writes `config/control/sync-now`. The daemon polls that directory
  every second and deletes the file as it acts on it.
- **Logs** are read from `config/logs/downloader.log`, which the daemon writes
  through a rotating handler.
- **Liveness** is `config/.downloader-heartbeat`, refreshed as the daemon works.
  That proves progress, where checking for a running process only proves a
  process exists.

The web container now needs no privileges at all, and nothing in the stack
requires the Docker socket.

## Shared-file discipline

Two processes write these files. Every write is a temp file in the same
directory, `fsync`, then `os.replace` — atomic on POSIX, so a reader sees either
the old file or the new one and never a half-written one. Read-modify-write
sequences additionally hold an advisory `flock` on a `<file>.lock` sidecar, and
both sides use the same convention.

Reads are deliberately forgiving: a corrupt JSON file yields the default plus a
warning. A daemon that refuses to start because one status file got truncated is
an outage; a daemon that logs it and carries on is not.

Files are written 0644 so both containers can read them, except the cookie jar
and the name cache, which are 0600. Both containers run as the same user — root
by default, or `PUID`/`PGID` if set — because they both need write access.

## Downloader (`downloader/gamdl_sync/`)

| Module | Responsibility |
| --- | --- |
| `daemon.py` | The sync loop. Signals, scheduling, per-playlist orchestration. |
| `config.py` | `Settings`: defaults < environment < `settings.json`, re-read every cycle. |
| `naming.py` | Pure functions turning an Apple title into a filename. No I/O. |
| `m3u.py` | Parsing and regenerating playlist files. |
| `gamdl_runner.py` | Building gamdl's argv, running it, parsing its output. |
| `state.py` | Atomic JSON I/O, locking, the status store and name cache. |
| `control.py` | The control-file protocol. |
| `playlists.py` | `playlists.txt`, URL canonicalization. |
| `updater.py` | Self-update for gamdl and N_m3u8DL-RE, with rollback. |
| `compat.py` | Narrow, exact-match guards against known upstream crashes. |
| `migrations.py` | One-time on-disk upgrades. |
| `doctor.py` | `gamdl-sync doctor` — diagnoses why downloads are not working. |

It was 731 lines of bash. The bash spawned a fresh Python interpreter for every
helper call — sanitizing a name, reading the cache, writing status — which came
to dozens of interpreter starts per playlist per cycle. It also had no signal
handling, no atomic writes, and could not be unit-tested without `bats`.

### One cycle

1. Re-read `settings.json` (so a UI change applies without a restart).
2. Run the self-updater if it is due.
3. Read `playlists.txt`.
4. Resolve each playlist's name: overrides → name cache → URL slug, then
   sanitize, then disambiguate against names already on disk.
5. For each playlist: delete its old file, run gamdl pointed at the exact target
   path, repair what gamdl produced, publish status.
6. Quarantine playlist files no configured URL claims.
7. Sleep in one-second slices, watching for control commands and signals.

### How a playlist file is produced

gamdl's `--save-playlist` writes bare relative paths indexed by track position.
It reads the existing file and overwrites only the lines it touches, and never
truncates — so a playlist that shrank upstream keeps its removed tracks forever.
A track that fails leaves a blank line. There is no `#EXTM3U` header.

So the daemon:

1. **Deletes** the target before running gamdl, forcing a clean regeneration.
2. **Predicts** where gamdl will write, by reproducing gamdl's own sanitizer
   (`[\\/:*?"<>|;]` → `_`) and passing `--playlist-folder-template` and
   `--playlist-file-template`. v1 instead searched the library for recently
   modified `.m3u` files, which picks the wrong file whenever two playlists sync
   close together.
3. **Repairs** the result: drops blanks, drops entries whose media is missing,
   de-duplicates, recomputes relative paths at the correct depth, and adds
   `#EXTM3U`, `#PLAYLIST:<title>` and `#EXTINF` lines read from the audio tags.
4. **Refuses to regress**: if gamdl failed and produced fewer tracks than the
   file already on disk, the existing file is kept and the playlist is marked
   partial.

### Naming

Characters no filesystem accepts are mapped to fullwidth lookalikes rather than
deleted, so the filename still reads like the title:

```
\ / : * ? " < > | ;   →   ＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜ ；
```

`;` is in that set because gamdl replaces it with `_`; mapping it first means
gamdl has nothing to eat. The same trick is what makes the lookalikes work at
all — they are outside gamdl's illegal set, so they pass through untouched.

Also handled: NFC normalization, stripping bidi controls (a filename-spoofing
vector), truncation on UTF-8 byte boundaries without splitting a grapheme
cluster, case-insensitive collisions, and brace-escaping for gamdl's
`string.Formatter` — an unescaped `{` in a playlist title raises inside gamdl and
aborts the download.

### Talking to gamdl

gamdl moves and renames options between releases, and the container updates
itself, so the daemon probes `gamdl --help` once at startup and drops any flag
that build does not advertise. A stack that dies with `no such option` after an
auto-update is not one you can leave running.

`--database-path` is deliberately never passed: its filter skips media before
gamdl's `_initial_processing`, and that is the function which writes m3u lines,
so already-downloaded tracks would silently vanish from the playlist file.

## Web UI (`webui/`)

Next.js 14 App Router. Four routes — Library, Settings, Account, Activity —
reached from a sidebar that collapses to a labelled icon rail.

`GET /api/status` is the single snapshot the dashboard polls: playlists, summary,
downloader liveness, cookie state. It is ETag'd, reads only the filesystem, and
caches its m3u directory scan on mtime. It never makes an outbound request —
v1's playlist endpoint scraped `music.apple.com` on a path polled every eight
seconds, so a slow Apple response made the whole UI feel broken.

Polling adapts: 3s while something is syncing, 15s idle, 60s on a hidden tab.
The log view uses Server-Sent Events, with polling as a fallback.

Authentication is off by default and enabled by setting `WEBUI_AUTH_TOKEN` or
`WEBUI_USERNAME`/`WEBUI_PASSWORD`; middleware then guards every route.

## Testing

| Suite | Command | Scope |
| --- | --- | --- |
| Downloader | `pytest` in `downloader/` | naming, m3u, config, state, control, playlists, argv building |
| Web UI | `npm test` in `webui/` | URL canonicalization, settings migration, atomic I/O, cookie expiry |
| Types | `npm run typecheck` | app and tests, strict mode |
| Shell | `shellcheck scripts/*.sh` | the entrypoints |

Neither suite touches the network, and the downloader tests do not need gamdl
installed.
