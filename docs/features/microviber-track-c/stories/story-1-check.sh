#!/usr/bin/env bash
#
# story-1 (microviber-track-c-1) — one command to check everything.
#
#   ./docs/features/microviber-track-c/stories/story-1-check.sh
#
# Part 1 runs every check that does not need a human: typecheck, lint, the
# whole test suite, the production build, and the normalizer diagnostic.
# Part 2 then serves a preview page holding every case on the manual
# checklist — including a failed command and a 40 000-character output, so
# nothing has to be triggered by hand — and prints the URL to open on a phone.
#
# No daemon, no pairing, no live Claude Code session. Reads nothing from
# ~/.claude. Writes nothing outside the repo's own build output.

set -uo pipefail

cd "$(dirname "$0")/../../../.." || exit 1
ROOT="$PWD"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; ylw=$'\033[33m'; off=$'\033[0m'

FAILED=0
LOG="$(mktemp -t story1check)"
trap 'rm -f "$LOG"' EXIT

step() { printf '%s\n' "${dim}   … $1${off}"; }
ok()   { printf '%s\n' "   ${grn}PASS${off}  $1"; }
bad()  { printf '%s\n' "   ${red}FAIL${off}  $1"; FAILED=$((FAILED + 1)); }

run() { # run <label> <cmd...>
  local label="$1"; shift
  step "$label"
  if "$@" >"$LOG" 2>&1; then
    ok "$label"
  else
    bad "$label"
    printf '%s\n' "${dim}$(tail -25 "$LOG" | sed 's/^/         /')${off}"
  fi
}

printf '\n%s\n' "${bold}story-1 — automated checks${off}"
printf '%s\n\n' "${dim}nothing here needs you; results below${off}"

run "types compile (typecheck)"        npm run typecheck
run "code style (lint)"                npm run lint
run "test suite (daemon + phone app)"  npm test
run "production build"                 npm run build
run "normalizer over a fake session"   npx tsx docs/features/microviber-track-c/stories/story-1-manual-test.ts

# Test counts, pulled out of a re-run so the numbers are visible rather than implied.
step "collecting test counts"
COUNTS="$(npm test 2>&1 | grep -E '^ +Tests +[0-9]+' | tr -s ' ' | sed 's/^ //')"
if [ -n "$COUNTS" ]; then
  printf '%s\n' "${dim}         $(echo "$COUNTS" | paste -sd' | ' -)${off}"
fi

printf '\n'
if [ "$FAILED" -gt 0 ]; then
  printf '%s\n\n' "${red}${bold}$FAILED automated check(s) failed — stop here and tell Claude.${off}"
  exit 1
fi
printf '%s\n\n' "${grn}${bold}All automated checks passed.${off}"

# ─── Part 2: the part that needs your eyes ──────────────────────────────────

# LAN address, so the URL works from a phone on the same wifi.
lan_ip() {
  local ip=''
  if command -v ipconfig >/dev/null 2>&1; then
    for i in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$i" 2>/dev/null)" && [ -n "$ip" ] && { printf '%s' "$ip"; return; }
    done
  fi
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')" && [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  fi
  printf '%s' ''
}

IP="$(lan_ip)"
PORT=5173

printf '%s\n' "${bold}Now the visual check.${off}"
printf '%s\n\n' "A preview page is about to start. It contains every case on the checklist."
printf '%s\n' "  ${bold}Open this on your phone${off} (same wifi as this laptop):"
if [ -n "$IP" ]; then
  printf '%s\n\n' "      ${grn}${bold}http://$IP:$PORT/preview.html${off}"
else
  printf '%s\n' "      ${ylw}Could not detect this machine's wifi address.${off}"
  printf '%s\n\n' "      Look for the ${bold}Network:${off} line the dev server prints below."
fi
printf '%s\n\n' "  ${dim}Or just on this laptop: http://localhost:$PORT/preview.html${off}"

cat <<'INSTRUCTIONS'
  The page has 7 numbered sections. Each one tells you what to look at.
  Tap the tool lines and results — they expand and collapse.

    1. Prose, several tool calls, thinking
    2. Tool results, including a failure   (already failing for you — nothing to trigger)
    3. Diffs                               (red minus / green plus / muted context)
    4. One-line edit in a 200-line file    (should be a SMALL hunk)
    5. MultiEdit, TodoWrite, no input
    6. AskUserQuestion                     (must look exactly as it did before)
    7. A long transcript                   (scroll it)

  If everything looks right:   tell Claude "manual tests passed"
  If something looks wrong:    tell Claude the section number and what you saw

  Press Ctrl+C when you are done to stop the server.

INSTRUCTIONS

printf '%s\n\n' "${dim}starting the preview server…${off}"
exec npm --prefix "$ROOT/pwa" run dev -- --host
