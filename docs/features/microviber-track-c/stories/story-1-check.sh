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
#
# What it DOES expose, while Part 2 runs: a Vite dev server bound to ONE
# interface (tailnet address if Tailscale is up, else this machine's wifi
# address, else loopback). Vite serves the workspace source under /@fs/, so
# anyone who can reach that address can read this repo until you Ctrl+C. It
# never binds 0.0.0.0.

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

# Resolve the ONE interface to bind before printing any URL, so the address
# shown is the address actually served. Bare `--host` (every interface) is the
# posture §5 forbids for the daemon and T1/T2 exclude; Vite serves the
# workspace source under /@fs/, so a wide bind exposes the repo to the whole
# wifi for as long as this runs (security + code review, story-1).
TS_ADDR="$(tailscale ip -4 2>/dev/null | head -1)"
BIND="${TS_ADDR:-${IP:-127.0.0.1}}"

printf '%s\n' "${bold}Now the visual check.${off}"
printf '%s\n\n' "A preview page is about to start. It contains every case on the checklist."
if [ "$BIND" = "127.0.0.1" ]; then
  printf '%s\n' "  ${ylw}No tailnet or wifi address found — serving this laptop only.${off}"
  printf '%s\n\n' "  Open: ${grn}${bold}http://127.0.0.1:$PORT/preview.html${off}"
  printf '%s\n\n' "  ${dim}For phone access, start Tailscale and re-run.${off}"
else
  printf '%s\n' "  ${bold}Open this on your phone:${off}"
  printf '%s\n\n' "      ${grn}${bold}http://$BIND:$PORT/preview.html${off}"
  if [ -n "$TS_ADDR" ]; then
    printf '%s\n\n' "  ${dim}(tailnet address — works anywhere Tailscale is up, not just this wifi)${off}"
  else
    printf '%s\n\n' "  ${dim}(wifi address — phone must be on the same network)${off}"
  fi
fi

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

printf '%s\n\n' "${dim}starting the preview server on $BIND…${off}"
exec npm --prefix "$ROOT/pwa" run dev -- --host "$BIND"
