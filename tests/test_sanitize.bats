#!/usr/bin/env bats
#
# Tests for the playlist-name handling helpers in scripts/entrypoint.sh:
#   - sanitize_filename
#   - resolve_playlist_name (overrides -> name cache -> URL slug)
#   - uniquify_playlist_name (case-insensitive collision suffix)
#   - SAFE_FILENAMES=true (ASCII-only mode)
#
# The entrypoint is sourced with ENTRYPOINT_SOURCE_ONLY=1 so only the
# helper functions are loaded — the main download loop never runs.

setup() {
  export TEST_TMP="$(mktemp -d)"
  export NAME_CACHE_FILE="$TEST_TMP/playlist-name-cache.json"
  export PLAYLIST_OVERRIDES_FILE="$TEST_TMP/playlist-overrides.json"
  export SAFE_FILENAMES=false
  export ENTRYPOINT_SOURCE_ONLY=1
  # Ubuntu only ships python3; the in-container image has /usr/bin/python.
  export PYBIN="$(command -v python || command -v python3)"

  # Source the entrypoint to import helper definitions only.
  # shellcheck disable=SC1091
  source "${BATS_TEST_DIRNAME}/../scripts/entrypoint.sh"
  declare -gA SEEN_LC=()
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "sanitize_filename maps unsafe chars to Unicode lookalikes" {
  result="$(sanitize_filename 'a\b/c:d*e?f"g<h>i|j' 'fallback')"
  [ "$result" = "a＼b／c：d＊e？f＂g＜h＞i｜j" ]
}

@test "sanitize_filename strips ASCII control chars" {
  result="$(sanitize_filename "$(printf 'hello\x01\x07world')" 'fallback')"
  [ "$result" = "helloworld" ]
}

@test "sanitize_filename trims trailing dots and spaces" {
  result="$(sanitize_filename 'My Playlist...   ' 'fallback')"
  [ "$result" = "My Playlist" ]
}

@test "sanitize_filename collapses internal whitespace" {
  result="$(sanitize_filename '  too    many   spaces  ' 'fallback')"
  [ "$result" = "too many spaces" ]
}

@test "sanitize_filename empty input returns fallback" {
  result="$(sanitize_filename '' 'abc123')"
  [ "$result" = "abc123" ]
}

@test "sanitize_filename input that becomes empty after stripping returns fallback" {
  # Slashes now map to fullwidth lookalikes, so the bare-control-chars input
  # is the one that collapses to empty.
  result="$(sanitize_filename "$(printf '\x01\x02\x03')" 'fb6chr')"
  [ "$result" = "fb6chr" ]
}

@test "sanitize_filename preserves emoji" {
  result="$(sanitize_filename '🪨 roll' 'fb')"
  [ "$result" = "🪨 roll" ]
}

@test "sanitize_filename preserves non-ASCII letters and symbols" {
  result="$(sanitize_filename '¯\_(ツ)_/¯' 'fb')"
  # backslash -> ＼ (U+FF3C), slash -> ／ (U+FF0F); ツ, ¯ and underscores survive.
  [ "$result" = "¯＼_(ツ)_／¯" ]
}

@test "sanitize_filename preserves '+' (not in unsafe set)" {
  # gamdl mangles '+' into space internally; our sanitizer must leave it alone.
  result="$(sanitize_filename '🪨+roll' 'fb')"
  [ "$result" = "🪨+roll" ]
}

@test "SAFE_FILENAMES=true preserves '+' but strips emoji" {
  SAFE_FILENAMES=true result="$(sanitize_filename '🪨+roll' 'fb')"
  [ "$result" = "+roll" ]
}

@test "SAFE_FILENAMES=true with shrug falls back to short-id (cosmetic stub rejected)" {
  # The ASCII filter would leave only '_()_' (zero alphanumerics). The
  # short-glyph fallback (<3 [A-Za-z0-9] chars) kicks in and the supplied
  # fallback wins instead.
  SAFE_FILENAMES=true result="$(sanitize_filename '¯\_(ツ)_/¯' 'short')"
  [ "$result" = "short" ]
}

@test "resolve_playlist_name precedence: cache beats URL slug when no override" {
  # Real-world scenario: cache has the correct API title with a '+' in it,
  # the URL slug would mangle it to spaces. resolve_playlist_name must
  # return the cache title verbatim, not a sanitized URL slug.
  cat >"$NAME_CACHE_FILE" <<'EOF'
{ "https://music.apple.com/us/playlist/rocknroll/pl.u-PLUSAAA111111": { "name": "🪨+roll" } }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/rocknroll/pl.u-PLUSAAA111111')"
  [ "$result" = "🪨+roll" ]
}

@test "post-download flow: cache title beats gamdl mangled source basename" {
  # Simulate the real bug: gamdl writes '🪨 roll.m3u' (its own sanitizer
  # mangled '+' to space), but the cache holds '🪨+roll' from the API.
  # The resolved target_name MUST come from the cache, not the source.
  export PLAYLIST_M3U_DIR="$TEST_TMP/playlists"
  mkdir -p "$PLAYLIST_M3U_DIR"
  url='https://music.apple.com/us/playlist/rocknroll/pl.u-PLUSAAA111111'
  cat >"$NAME_CACHE_FILE" <<EOF
{ "$url": { "name": "🪨+roll" } }
EOF
  # Fake gamdl output (mangled name).
  src="$TEST_TMP/🪨 roll.m3u"
  printf '#EXTM3U\n' >"$src"

  resolved_name="$(resolve_playlist_name "$url")"
  # Mirror the post-download branch's selection logic:
  url_slug_fallback="$(sanitize_filename "$(playlist_filename_from_url "$url")" "$(playlist_short_id "$url")")"
  if [ "$resolved_name" = "$url_slug_fallback" ]; then
    target_name="$(sanitize_filename "$(basename "${src%.*}")" "$(playlist_short_id "$url")")"
  else
    target_name="$resolved_name"
  fi
  [ "$target_name" = "🪨+roll" ]
}

@test "SAFE_FILENAMES=true strips non-ASCII and emoji" {
  SAFE_FILENAMES=true result="$(sanitize_filename '🪨 roll café' 'fb')"
  [ "$result" = "roll caf" ]
}

@test "SAFE_FILENAMES=true keeps ASCII-safe text intact" {
  SAFE_FILENAMES=true result="$(sanitize_filename 'Plain Mix' 'fb')"
  [ "$result" = "Plain Mix" ]
}

@test "uniquify_playlist_name no collision returns input unchanged" {
  declare -gA SEEN_LC=()
  result="$(uniquify_playlist_name 'Jams' 'https://music.apple.com/us/playlist/jams/pl.u-AAAAAA111111')"
  [ "$result" = "Jams" ]
}

@test "uniquify_playlist_name appends short-id suffix on case-insensitive collision" {
  declare -gA SEEN_LC=([jams]=1)
  result="$(uniquify_playlist_name 'jams' 'https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr')"
  [ "$result" = "jams (ALAyAr)" ]
}

@test "uniquify_playlist_name treats Jams and jams as colliding" {
  declare -gA SEEN_LC=([jams]=1)
  result="$(uniquify_playlist_name 'Jams' 'https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr')"
  [ "$result" = "Jams (ALAyAr)" ]
}

@test "playlist-overrides.json.example parses as valid JSON" {
  # First-time UX guard: the example must always round-trip through the
  # stdlib JSON parser so a copy-paste setup doesn't silently break.
  run "$PYBIN" -c "import json; json.load(open('${BATS_TEST_DIRNAME}/../config/playlist-overrides.json.example'))"
  [ "$status" -eq 0 ]
}

@test "SAFE_FILENAMES=true short-glyph fallback keeps real short names" {
  # 'Mix' has 3 alphanumerics — at the threshold, must NOT trigger the fallback.
  SAFE_FILENAMES=true result="$(sanitize_filename 'Mix' 'short')"
  [ "$result" = "Mix" ]
}

@test "resolve_playlist_name uses override when override file present" {
  cat >"$PLAYLIST_OVERRIDES_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "Bops" }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  [ "$result" = "Bops" ]
}

@test "resolve_playlist_name override takes precedence over name cache" {
  cat >"$PLAYLIST_OVERRIDES_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "Override Wins" }
EOF
  cat >"$NAME_CACHE_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": { "name": "Cache Loses" } }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  [ "$result" = "Override Wins" ]
}

@test "resolve_playlist_name falls through to name cache when no override" {
  cat >"$NAME_CACHE_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": { "name": "From Cache" } }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  [ "$result" = "From Cache" ]
}

@test "resolve_playlist_name falls back to URL slug when no overrides and no cache" {
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/my-summer-mix/pl.u-AAAAAA111111')"
  [ "$result" = "my summer mix" ]
}

@test "resolve_playlist_name absent overrides file behaves as before" {
  rm -f "$PLAYLIST_OVERRIDES_FILE"
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/my-mix/pl.u-AAAAAA111111')"
  [ "$result" = "my mix" ]
}

@test "resolve_playlist_name sanitizes the override result" {
  cat >"$PLAYLIST_OVERRIDES_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "Bad/Name:Here..." }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  # Slash -> ／ (U+FF0F), colon -> ： (U+FF1A), trailing dots stripped.
  [ "$result" = "Bad／Name：Here" ]
}

@test "resolve_playlist_name preserves emoji in override" {
  cat >"$PLAYLIST_OVERRIDES_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "💍" }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  [ "$result" = "💍" ]
}

@test "playlist_short_id extracts last 6 chars of pl.u-... id" {
  result="$(playlist_short_id 'https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr')"
  [ "$result" = "ALAyAr" ]
}

@test "resolve_playlist_name falls through when overrides JSON is malformed" {
  # Intentionally invalid JSON (missing closing brace). The Python
  # override loader's try/except must swallow the error and let the
  # name-cache entry win instead of aborting or returning empty.
  printf '%s' '{"https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": "Bops"' \
    >"$PLAYLIST_OVERRIDES_FILE"
  cat >"$NAME_CACHE_FILE" <<EOF
{ "https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111": { "name": "From Cache" } }
EOF
  result="$(resolve_playlist_name 'https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111')"
  [ "$result" = "From Cache" ]
}

@test "update_name_cache_entry upgrades legacy string entry to dict shape" {
  url='https://music.apple.com/us/playlist/foo/pl.u-AAAAAA111111'
  # Legacy shape: bare string value rather than a dict.
  cat >"$NAME_CACHE_FILE" <<EOF
{ "$url": "Old Name" }
EOF
  update_name_cache_entry "$url" "New Name"
  # After the call the entry must be a dict carrying the new name.
  result="$("$PYBIN" - "$NAME_CACHE_FILE" "$url" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
entry = data.get(sys.argv[2])
assert isinstance(entry, dict), f"entry is not a dict: {type(entry).__name__}"
print(entry.get('name', ''))
PY
)"
  [ "$result" = "New Name" ]
}

@test "collision flow: two playlists with case-only difference get suffix" {
  declare -gA SEEN_LC=()
  cat >"$NAME_CACHE_FILE" <<EOF
{
  "https://music.apple.com/us/playlist/jams/pl.u-AAAAAAAAAAAA": { "name": "Jams" },
  "https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr": { "name": "jams" }
}
EOF
  # uniquify_playlist_name must be called directly (not via $(...)) so the
  # SEEN_LC tracker persists into the next iteration.
  first="$(resolve_playlist_name 'https://music.apple.com/us/playlist/jams/pl.u-AAAAAAAAAAAA')"
  uniquify_playlist_name "$first" 'https://music.apple.com/us/playlist/jams/pl.u-AAAAAAAAAAAA' >/dev/null
  first_uniq="$UNIQUE_NAME"

  second="$(resolve_playlist_name 'https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr')"
  uniquify_playlist_name "$second" 'https://music.apple.com/us/playlist/jams/pl.u-qxyl1KBu2ALAyAr' >/dev/null
  second_uniq="$UNIQUE_NAME"

  [ "$first_uniq" = "Jams" ]
  # second resolves to "jams" but collides with "jams" (lowercased "Jams"),
  # so it gets the short-id suffix (last 6 chars of the pl.u-... id).
  [ "$second_uniq" = "jams (ALAyAr)" ]
}
