# Workflows

**`ci.yml`** — runs on every push and pull request. Four independent jobs:
`python` lints (`ruff check`/`ruff format --check`) and tests
(`pytest downloader/tests`, with coverage) the downloader *without* gamdl
installed, to prove it's only ever shelled out to, never imported; `webui`
type-checks, lints, and builds the Next.js app; `shellcheck` checks
`scripts/*.sh` as POSIX sh; `docker` build-only smoke-tests both images for
`linux/amd64`. Superseded runs on the same ref are cancelled automatically.

**`release.yml`** — runs on a `v*` tag push or manual dispatch. Builds and
publishes both images for `linux/amd64,linux/arm64` to
`ghcr.io/<owner>/gamdl-downloader` and `ghcr.io/<owner>/gamdl-webui`, tagged
with the version, its `major.minor`, and `latest`, with build provenance and
an SBOM attached to each image.

**`gamdl-watch.yml`** — runs weekly (Monday 06:00 UTC) or on demand. Checks
PyPI for the newest `gamdl` release against the version last recorded in
`.github/gamdl-version.txt`; if it's newer, rebuilds the downloader image with
that version as a smoke test and opens (or comments on) a single reused
tracking issue titled "gamdl update watch" — it never edits the Dockerfile's
pinned version itself, that's a deliberate human step.
