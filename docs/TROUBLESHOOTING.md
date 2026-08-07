# Troubleshooting

Start here. It checks everything that commonly breaks and names the fix:

```bash
docker compose exec gamdl-downloader gamdl-sync doctor
```

Sample output:

```
 ✓  gamdl             version 3.8.5
 ✓  gamdl options     47 options detected
 ✓  N_m3u8DL-RE       /usr/local/bin/N_m3u8DL-RE
 ✓  ffmpeg            /usr/bin/ffmpeg
 ✗  cookies           no cookie file — upload cookies.txt in the web UI
 !  playlists         none configured — add one in the web UI
 ✓  library           /data/music
 ✓  playlist folder   /data/music/playlists
 ✓  temp folder       /data/temp
 ✓  config            /config
```

`✗` stops downloads. `!` is worth a look but is not fatal.

---

## Nothing downloads

**"No cookie file" / the UI says Not signed in.** Upload a `cookies.txt` export
under **Account**. See the on-page instructions for how to produce one.

**Downloads worked for weeks and then stopped.** Apple Music cookies expire.
The Account page shows the expiry and the UI warns a week ahead. Re-export and
upload.

**"Apple refused the request (403)".** Either the account has no active Apple
Music subscription, or the playlist is not visible to that account's storefront.
Open the playlist URL in a browser signed in to the same account.

**"Apple could not find that playlist".** The playlist was deleted or made
private. Remove it from the Library page.

**Tracks are skipped with a `.wvd` message.** Lossless and Atmos need a Widevine
device file at `/config/device.wvd`. Without one, use the AAC quality setting —
it needs no device file and is what Apple's own web player serves.

---

## The playlist file looks wrong

**Fewer tracks than Apple shows.** Some tracks are not available in your
storefront, or failed to download. The Library page shows the count as
"missing"; the log names each one. Missing tracks are deliberately left out of
the `.m3u8` so players do not show dead entries — turn that off with
`prunePlaylistEntries: false` if you would rather keep them.

**A track I removed upstream is still in the file.** It should not be — the file
is rebuilt each cycle. If it persists, the cycle is failing before it gets that
far; check the Activity log.

**The filename has odd wide characters in it.** That is deliberate. `\ / : * ?
" < > | ;` cannot be stored in a filename on every platform, so they are
replaced with fullwidth lookalikes (`＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜ ；`) that render
almost identically. Without this the characters would simply be deleted.

**Emoji show as boxes in my music server.** The file is UTF-8 and the emoji are
intact — that is a font problem in the player, not a naming problem. Confirm
with `ls` on the host.

**A playlist file vanished.** Files no configured playlist claims are moved to a
`.trash` folder inside the playlist directory, never deleted. Look there.

**Two playlists with the same name.** The second gets a `(abc123)` suffix, because
macOS and Windows treat names differing only by case as the same file. Give one
of them a different name in `config/playlist-overrides.json`.

---

## Permissions

**Downloaded files are owned by `root` on the host.** Set `PUID` and `PGID` in
`.env` to your own IDs (`id -u`, `id -g`) and recreate the containers. Set them
for **both** services — they share `/config` and must agree on a user.

```bash
docker compose down && docker compose up -d
sudo chown -R $(id -u):$(id -g) ./config ./downloads
```

**The UI shows "permission denied" writing settings.** Same cause. The web
container must run as the same user as the downloader.

---

## Containers

**The downloader keeps restarting.** Read the actual error:

```bash
docker compose logs --tail 100 gamdl-downloader
```

**The UI says "downloader not responding".** The daemon publishes a heartbeat
every 15 seconds; the UI reports it stale after two minutes.

```bash
docker compose ps
docker compose logs --tail 50 gamdl-downloader
cat config/.downloader-heartbeat
```

**The web container is unhealthy after I set an auth token.** It should not be —
`/api/health` is deliberately outside the auth check for exactly this reason. If
it happens, confirm you are on a current image (`docker compose build --no-cache webui`).

**`docker compose up` fails fetching N_m3u8DL-RE.** Your network blocks GitHub.
Keep the default `NM3U8DLRE_VERSION=pinned`, which installs a known-good release
by direct download and never touches the GitHub API.

**Builds fail with a TLS or certificate error.** A corporate proxy is
intercepting the build. Configure Docker's build proxy settings rather than
disabling verification.

---

## Updates

**gamdl updated and now nothing works.** It should have rolled itself back — the
updater runs `gamdl --version` and re-probes its options before accepting an
upgrade. Check `config/.update-state.json` for `rolledBack: true` and the log
for the reason. To pin a known-good version:

```bash
# .env
GAMDL_VERSION=3.8.5
AUTO_UPDATE_GAMDL=false
```

then `docker compose up -d --build`.

**I want to update immediately rather than waiting for the interval.**

```bash
docker compose restart gamdl-downloader
```

The check runs at the top of each cycle when it is due.

---

## Getting more detail

```bash
# Verbose logging
echo "LOG_LEVEL=DEBUG" >> .env && docker compose up -d gamdl-downloader

# What the daemon thinks its configuration is
docker compose exec gamdl-downloader gamdl-sync show-config

# Trigger a sync from the command line
docker compose exec gamdl-downloader gamdl-sync sync-now

# Follow the log file the UI reads
tail -f config/logs/downloader.log
```

Credentials are redacted before anything reaches the log, so log excerpts are
safe to share in a bug report. Include the output of `gamdl-sync doctor` and
`gamdl-sync show-config`.
