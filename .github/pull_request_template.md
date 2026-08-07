## What changed and why

<!-- One or two sentences. Link an issue if there is one. -->

## Checklist

- [ ] No new dependency on `docker`/`/var/run/docker.sock` — the web UI and the
      downloader only ever talk through the `/config` volume (`control.py`).
- [ ] Any new shared-file write uses the atomic-write + `<path>.lock` protocol
      in `state.py` (temp file in the same directory, `fsync`, rename, advisory
      lock) — not an ad hoc `open(..., "w")`.
- [ ] No new npm dependency was added without discussion (`webui/package.json`
      is meant to stay the exact set it already lists).
- [ ] `cd webui && npx tsc --noEmit` passes.
- [ ] `ruff check downloader && ruff format --check downloader` pass.
- [ ] `pytest downloader/tests -q` passes.
- [ ] New/changed `.ts`/`.tsx` matches the existing no-semicolon style.

## How this was tested

<!-- Commands run, or "CI covers this". -->
