# Changelog

## 2.0.0

A rewrite of the downloader and the web UI. Existing installs upgrade with
`git pull && docker compose up -d --build` — see [docs/MIGRATION.md](docs/MIGRATION.md).

### Fixed

- **Settings the UI showed had no effect.** Quality, lyrics format, cover art,
  overwrite and the folder templates were displayed, saved, and never passed to
  gamdl. All of them now reach the command line, and there is a test per setting
  asserting it.
- **Playlist files never shrank.** gamdl updates its `.m3u` in place and never
  truncates, so a track removed upstream stayed in the local playlist forever.
  Files are now regenerated from scratch every cycle.
- **Playlist files could be the wrong file.** The old code found gamdl's output
  by scanning the library for recently-modified `.m3u` files and taking the
  first match — which picks the wrong playlist whenever two sync close together.
  The output path is now computed exactly, by reproducing gamdl's own sanitizer.
- **A settings change needed a container restart.** gamdl's arguments were built
  once at startup, so later edits to the output location or download mode were
  ignored until the container was recreated.
- **`docker stop` always took the full kill timeout.** The entrypoint ran as PID
  1 with no signal handling. SIGTERM is now honoured within about a second.
- **Concurrent writes could corrupt shared state.** The daemon and the web UI
  both read-modify-write the same JSON files with no atomicity or locking. All
  writes are now temp-file + rename under an advisory lock.
- **A playlist with `{` in its name aborted its own download.** gamdl renders
  templates through `string.Formatter`; braces are now escaped.
- **Catalog playlists all got the same collision suffix.** The short-id regex
  backtracked on hyphenless `pl.<id>` forms and captured a single character.
- **`SAFE_FILENAMES=true` deleted accented letters** instead of folding them
  (`café` became `caf`, now `cafe`).
- **A failed sync could replace a complete playlist with a truncated one.** A
  run that produces fewer tracks than the file already on disk is now rejected
  and reported as partial.
- **A corrupt N_m3u8DL-RE download could crash-loop the container**, and a build
  that failed to fetch it shipped anyway because of a `|| true`.

### Security

- **Removed the Docker socket mount from the web container.** It was there so
  the UI could run `docker restart` and `docker logs`; that mount grants root on
  the host. "Sync now" is now a control file the daemon watches, and logs are
  read from a shared file. Nothing in the stack requires the socket.
- Optional authentication via `WEBUI_AUTH_TOKEN` or `WEBUI_USERNAME`/`WEBUI_PASSWORD`.
- Credentials are redacted from log output before it is written.
- Cookie files are written owner-only; existing ones are tightened on upgrade.
- `.env` and `config/` are excluded from the Docker build context.
- Release workflows no longer interpolate third-party strings into shell.

### Added

- `gamdl-sync doctor` — diagnoses cookies, binaries, permissions and playlists,
  and names the fix for each problem.
- Live per-playlist progress, and a status banner that surfaces the one thing
  blocking downloads.
- Cookie expiry detection, with a warning a week ahead.
- `PUID`/`PGID` support on both containers.
- `concurrency` — sync several playlists at once.
- Playlist files are now UTF-8 `.m3u8` with `#EXTM3U`, `#PLAYLIST` and `#EXTINF`
  metadata read from the audio tags.
- Playlist files no configured URL claims are moved to `.trash` rather than left
  to accumulate.
- CI: lint, type-check, unit tests, shellcheck and image builds. Multi-arch
  GHCR releases gated on those checks. A weekly job that watches for new gamdl
  releases.

### Changed

- The downloader is a Python package rather than 731 lines of bash. The bash
  spawned a fresh interpreter for every helper call — dozens per playlist per
  cycle.
- `AUTO_UPDATE_GAMDL` now defaults to `true`. Apple changes its web player often
  enough that a pinned gamdl stops working within weeks; a failed upgrade
  verifies itself and rolls back.
- N_m3u8DL-RE is pinned by default so a build does not depend on the GitHub API
  being reachable. `NM3U8DLRE_VERSION=latest` opts into resolving the newest.
- Temp files moved to a named volume instead of the container's writable layer.
- `;` in a playlist name maps to `；` rather than being replaced with `_`.
- Compose no longer hard-codes values that shadow `.env`. Every documented knob
  works again.
- `config/settings.json` and `config/playlists.txt` are no longer tracked in git;
  `.example` files are shipped instead, so `git pull` cannot fight your config.
- `config/webui.env` is removed. It was written on every save and never read.

### UI

- The sidebar collapses to a labelled icon rail, and remembers its state across
  loads.
- Navigation is no longer duplicated between a sidebar and a tab bar; the four
  destinations are real routes with working back/forward and deep links.
- Apple HIG type ramp and 8pt spacing, on the system font stack — no webfont
  fetch, so builds work offline, and emoji in playlist names render.
- Translucent frost surfaces on the chrome, with an opaque fallback where
  `backdrop-filter` is unsupported.
- No theme flash on load.
- Accessibility: labelled icon controls, visible focus, keyboard-reachable file
  upload, status conveyed by icon and text rather than colour alone, AA contrast
  in both themes, and `prefers-reduced-motion` honoured.
- Deleting a playlist asks first and names it.
- Toasts replace the hand-rolled banner; failures always surface a reason.
- Polling adapts to activity and pauses on a hidden tab; the log view streams.
- Saving after a failed settings load is blocked, so an outage cannot overwrite
  your configuration with defaults.

## 1.0.0

Initial release.
