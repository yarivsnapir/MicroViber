#!/usr/bin/env bash
# opt-in-autostart — live manual test (autostart on → status → KeepAlive → stop → start → login sim → off → restore).
#
# What it does, end to end:
#   Autostart must NOT run the daemon with different config than the repo-root .env, which `bin/microviberd run`
#   reads by default. This script verifies that the launchd agent installs, runs with the right env, responds to
#   start/stop, respects KeepAlive on crash, and can be toggled off cleanly.
#
# CHECK 1 (PREFLIGHT / REAL GATE):
#   The shipped `bin/microviberd run` sources the repo-root `.env`. The daemon on this machine was started with
#   `daemon/.env` by a hand-made agent. Two hazards would bite if autostart takes over:
#   a) root `.env` sets a non-empty MV_BEARER_TOKEN that DIFFERS from ~/.microviber/token → daemon gets re-paired
#   b) root `.env` has EMPTY MV_VAPID_PUBLIC_KEY/MV_VAPID_PRIVATE_KEY but daemon/.env has real values → push dies
#
#   On this machine, the script is EXPECTED TO STOP AT CHECK 1. The hazard exists, and stopping is correct.
#   Reconcile root .env per INSTALL.md Stage 3: copy the real VAPID keys across, leave MV_BEARER_TOKEN empty
#   to use ~/.microviber/token, then re-run the script.
#
# Run from the microviber repo root:
#   bash docs/features/opt-in-autostart/live-test.sh
# A redacted copy of everything printed is written to $LOG (inside the repo, git-ignored).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT" || exit 1
LOG="${MV_TEST_LOG:-$ROOT/docs/features/opt-in-autostart/live-test.log}"
mkdir -p "$(dirname "$LOG")"; : > "$LOG"
TMP="$(mktemp -d)"
FAILS=0

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
pass() { say "  ✅ $*"; }
fail() { say "  ❌ $*"; FAILS=$((FAILS + 1)); }
hr()   { say ""; say "── $* ──"; }
trap 'rm -rf "$TMP"' EXIT INT TERM

for t in curl stat lsof; do command -v "$t" >/dev/null 2>&1 || { fail "'$t' is required but not installed"; exit 1; }; done

say "opt-in-autostart live test — $(date '+%Y-%m-%d %H:%M:%S') — branch $(git branch --show-current) @ $(git rev-parse --short HEAD)"

# ── CHECK 1: env parity (REAL GATE - aborts before any install) ────────────────
hr "CHECK 1: environment parity (preflight)"
set -a
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
ROOT_BEARER="${MV_BEARER_TOKEN:-}"
unset MV_BEARER_TOKEN MV_VAPID_PUBLIC_KEY MV_VAPID_PRIVATE_KEY

envval() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2-; }

DAEMON_ENV="$ROOT/daemon/.env"
if [ ! -f "$DAEMON_ENV" ]; then
  say "  daemon/.env does not exist — environment parity check passes (no legacy daemon config to reconcile)"
else
  # Check 1a: MV_BEARER_TOKEN reconciliation
  # If root .env has a non-empty token, it must match ~/.microviber/token (else daemon will re-pair when autostart takes over)
  if [ -n "$ROOT_BEARER" ]; then
    TOKEN_FILE="$HOME/.microviber/token"
    PERSISTED_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE" 2>/dev/null || true)"
    if [ "$ROOT_BEARER" != "$PERSISTED_TOKEN" ]; then
      fail "MV_BEARER_TOKEN in root .env is non-empty and DIFFERS from $TOKEN_FILE"
      fail "  This would re-pair the daemon when autostart takes over."
      fail "ACTION: Reconcile root .env per INSTALL.md Stage 3 — copy real VAPID keys, clear MV_BEARER_TOKEN"
      exit 1
    fi
  fi

  # Check 1b: generic regression check over all MV_* keys (except MV_BEARER_TOKEN)
  # Any non-empty key in daemon/.env that is empty or absent in root .env is a regression.
  # MV_BEARER_TOKEN is excluded: empty in root .env is the correct desired state (daemon uses ~/.microviber/token),
  # and check 1a already covers the token reconciliation.
  REGRESS_KEYS=""
  DAEMON_MV_KEYS="$(grep -oE '^MV_[A-Z_]+' "$DAEMON_ENV" 2>/dev/null | sort -u | grep -v '^MV_BEARER_TOKEN$' || true)"
  for key in $DAEMON_MV_KEYS; do
    DAEMON_VAL="$(envval "$key" "$DAEMON_ENV")"
    ROOT_VAL="$(envval "$key" "$ROOT/.env")"
    if [ -n "$DAEMON_VAL" ] && [ -z "$ROOT_VAL" ]; then
      REGRESS_KEYS="$REGRESS_KEYS $key"
    fi
  done

  if [ -n "$REGRESS_KEYS" ]; then
    fail "These keys are non-empty in daemon/.env but empty/absent in root .env:$REGRESS_KEYS"
    fail "  This would break daemon behavior when autostart takes over."
    fail "ACTION: Reconcile root .env per INSTALL.md Stage 3 — copy the real values from daemon/.env"
    exit 1
  fi

  # Additive differences (informational, do not fail)
  ROOT_MV_KEYS="$(grep -oE '^MV_[A-Z_]+' "$ROOT/.env" 2>/dev/null | sort -u || true)"
  EXTRA_IN_ROOT="$(echo "$ROOT_MV_KEYS" | grep -vFf <(echo "$DAEMON_MV_KEYS") | tr '\n' ',' | sed 's/,$//' || true)"
  if [ -n "$EXTRA_IN_ROOT" ]; then
    say "  ℹ root .env has extra keys not in daemon/.env: $EXTRA_IN_ROOT (these are additive — OK)"
  fi
fi
pass "environment parity check passed"

# ── CHECK 2: login shell ───────────────────────────────────────────────────────
hr "CHECK 2: login shell"
"${SHELL:-/bin/bash}" -il -c 'echo MV_SHELL_OK' </dev/null > "$TMP/shellprobe" 2>&1 &
SHELL_PID=$!
SHELL_OK=0
for i in {0..200}; do
  if ! kill -0 $SHELL_PID 2>/dev/null; then
    break
  fi
  sleep 0.1
done
kill $SHELL_PID 2>/dev/null || true
if grep -q 'MV_SHELL_OK' "$TMP/shellprobe" 2>/dev/null; then
  SHELL_OK=1
fi
if [ "$SHELL_OK" = "1" ]; then
  pass "login shell responds within 20s"
else
  fail "login shell did not respond or timed out"
fi

# ── load daemon config for later checks ────────────────────────────────────────
set -a
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
[ -z "${MV_BIND_ADDRESS:-}" ] && [ -f "$ROOT/daemon/.env" ] && . "$ROOT/daemon/.env"
set +a
if [ -z "${MV_BIND_ADDRESS:-}" ]; then fail "MV_BIND_ADDRESS not set in .env or daemon/.env — cannot reach the daemon"; exit 1; fi
MV_PORT="${MV_PORT:-8730}"
HOSTHDR="${MV_ALLOWED_HOSTS%%,*}"; HOSTHDR="${HOSTHDR:-$MV_BIND_ADDRESS}"
BASE="http://${MV_BIND_ADDRESS}:${MV_PORT}"
TOKEN_FILE="${MV_TOKEN_FILE:-$HOME/.microviber/token}"
TOKEN="${MV_BEARER_TOKEN:-$(tr -d '[:space:]' < "$TOKEN_FILE" 2>/dev/null || true)}"
if [ -z "$TOKEN" ]; then fail "no bearer token: MV_BEARER_TOKEN unset and nothing at $TOKEN_FILE"; exit 1; fi
say "  daemon: $BASE  (Host: $HOSTHDR)"
TOKSRC="$([ -n "${MV_BEARER_TOKEN:-}" ] && echo "env" || echo "$TOKEN_FILE")"
say "  token: from $TOKSRC (never shown)"
HDR="$TMP/hdr"; umask 077; printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"; umask 022
unset TOKEN MV_BEARER_TOKEN

api() { curl -sS -m 15 -H @"$HDR" -H "Host: $HOSTHDR" "$@"; }
api_status() { local out="$1"; shift; api -o "$out" -w '%{http_code}' "$@" 2>>"$LOG" || echo "000"; }

# ── CHECK 3: baseline ──────────────────────────────────────────────────────────
hr "CHECK 3: baseline state"
PLIST_PATH="$HOME/Library/LaunchAgents/com.microviber.daemon.plist"
PLIST_EXISTS=0
if [ -f "$PLIST_PATH" ]; then
  PLIST_EXISTS=1
  say "  ⚠ $PLIST_PATH already exists (from a previous hand-made agent)"
  say "  ⚠ autostart on will REPLACE it with the one from ./bin/microviberd"
fi
pass "baseline: plist exists=$PLIST_EXISTS"

DAEMON_RUNNING=0
PORT_LISTENS=0
if [ "$(api_status "$TMP/h" "$BASE/api/health")" = "200" ]; then
  DAEMON_RUNNING=1
  PORT_LISTENS=1
fi
say "  baseline: daemon running=$DAEMON_RUNNING, port listens=$PORT_LISTENS"

# ── CHECK 4: autostart on ──────────────────────────────────────────────────────
hr "CHECK 4: autostart on"
ON_OUT="$(bin/microviberd autostart on 2>&1)"
ON_STATUS=$?
echo "$ON_OUT" | tee -a "$LOG"
if [ $ON_STATUS -ne 0 ]; then fail "autostart on exited with code $ON_STATUS"; exit 1; fi
if ! echo "$ON_OUT" | grep -q 'MicroViber auto-start: ON'; then fail "'MicroViber auto-start: ON' not in output"; exit 1; fi
if ! echo "$ON_OUT" | grep -q '⚠ The daemon now runs whenever you are logged in'; then fail "'⚠ The daemon now...' not in output"; exit 1; fi
if ! echo "$ON_OUT" | grep -q '● MicroViber LISTENING (pid'; then fail "'● MicroViber LISTENING' not in output"; exit 1; fi
pass "autostart on: all required strings present"

# ── CHECK 5: health after autostart on ─────────────────────────────────────────
hr "CHECK 5: health after autostart on"
HEALTH="$(api_status "$TMP/h5" "$BASE/api/health")"
if [ "$HEALTH" = "200" ]; then
  pass "GET /api/health → 200"
else
  fail "GET /api/health → HTTP $HEALTH"
  fail "  body: $(head -c 300 "$TMP/h5" 2>/dev/null)"
fi

# ── CHECK 6: autostart status ──────────────────────────────────────────────────
hr "CHECK 6: autostart status"
STATUS_OUT="$(bin/microviberd autostart status 2>&1)"
echo "$STATUS_OUT" | tee -a "$LOG"
if echo "$STATUS_OUT" | grep -q '● auto-start ON (' && ! echo "$STATUS_OUT" | grep -q 'not running'; then
  pass "autostart status shows '● auto-start ON (' with daemon running"
else
  fail "expected '● auto-start ON (' with running daemon in status output"
fi

# ── CHECK 7: log permissions and content ──────────────────────────────────────
hr "CHECK 7: log modes and pairing URL"
LOG_DIR="$HOME/.microviber/logs"
LOG_FILE="$LOG_DIR/daemon.log"
if [ ! -d "$LOG_DIR" ]; then fail "log directory $LOG_DIR does not exist"; exit 1; fi
LOG_DIR_PERM="$(stat -f '%Lp' "$LOG_DIR" 2>/dev/null || echo '???')"
LOG_FILE_PERM="$(stat -f '%Lp' "$LOG_FILE" 2>/dev/null || echo '???')"
if [ "$LOG_DIR_PERM" = "700" ]; then
  pass "log directory mode is 700"
else
  fail "log directory mode is $LOG_DIR_PERM (expected 700)"
fi
if [ "$LOG_FILE_PERM" = "600" ]; then
  pass "log file mode is 600"
else
  fail "log file mode is $LOG_FILE_PERM (expected 600)"
fi
if grep -q 'Pair (open on your phone):' "$LOG_FILE" 2>/dev/null; then
  pass "log contains pairing URL line (boolean only, contents redacted)"
else
  fail "log file does not contain 'Pair (open on your phone):' — daemon startup may have failed"
fi
if grep -q 'MicroViber daemon listening on' "$LOG_FILE" 2>/dev/null; then
  pass "log contains daemon listening startup line (boolean only, details redacted)"
else
  fail "log file does not contain 'MicroViber daemon listening on' — daemon may not have started"
fi

# ── CHECK 8: KeepAlive (daemon respawns on crash) ───────────────────────────────
hr "CHECK 8: KeepAlive"
BEFORE_PID="$(lsof -ti:$MV_PORT 2>/dev/null | head -1 || echo '')"
if [ -z "$BEFORE_PID" ]; then fail "nothing listening on port $MV_PORT"; exit 1; fi
say "  daemon pid before kill: $BEFORE_PID"
kill $BEFORE_PID 2>/dev/null || true
sleep 1
say "  waiting for KeepAlive to respawn..."
AFTER_PID=""
for i in {0..150}; do
  AFTER_PID="$(lsof -ti:$MV_PORT 2>/dev/null | head -1 || echo '')"
  if [ -n "$AFTER_PID" ] && [ "$AFTER_PID" != "$BEFORE_PID" ]; then
    break
  fi
  sleep 0.1
done
if [ -z "$AFTER_PID" ]; then
  fail "KeepAlive did not respawn daemon within 15s"
  say "  attempting recovery: autostart on..."
  bin/microviberd autostart on >/dev/null 2>&1 || true
  sleep 2
  RECOVERY_HEALTH="$(api_status "$TMP/h_recover8" "$BASE/api/health" 2>&1 || true)"
  if [ "$RECOVERY_HEALTH" = "200" ]; then
    say "  recovery succeeded (health 200); CHECK 8 failed but daemon is restored"
  else
    say "  recovery failed (health $RECOVERY_HEALTH); daemon may be down"
  fi
  exit 1
fi
if [ "$AFTER_PID" = "$BEFORE_PID" ]; then
  fail "daemon respawned with the SAME pid (expected different)"
  say "  attempting recovery: autostart on..."
  bin/microviberd autostart on >/dev/null 2>&1 || true
  sleep 2
  RECOVERY_HEALTH="$(api_status "$TMP/h_recover8b" "$BASE/api/health" 2>&1 || true)"
  if [ "$RECOVERY_HEALTH" = "200" ]; then
    say "  recovery succeeded (health 200); CHECK 8 failed but daemon is restored"
  else
    say "  recovery failed (health $RECOVERY_HEALTH); daemon may be down"
  fi
  exit 1
fi
pass "KeepAlive respawned daemon with pid $AFTER_PID (was $BEFORE_PID)"

# ── CHECK 9: stop / start cycle ────────────────────────────────────────────────
hr "CHECK 9: stop / start cycle"
STOP_OUT="$(bin/microviberd stop 2>&1)"
echo "$STOP_OUT" | tee -a "$LOG"
if echo "$STOP_OUT" | grep -q 'Auto-start is still on — it starts again at your next login'; then
  pass "stop: contains 'Auto-start is still on...'"
else
  fail "stop: expected 'Auto-start is still on...' in output"
fi
sleep 2
AFTER_STOP="$(api_status "$TMP/h_stop" "$BASE/api/health" 2>&1 || true)"
if [ "$AFTER_STOP" != "200" ]; then
  pass "port goes quiet after stop (health: HTTP $AFTER_STOP)"
else
  fail "port still answers 200 after stop"
fi

STATUS_AFTER_STOP="$(bin/microviberd autostart status 2>&1)"
if echo "$STATUS_AFTER_STOP" | grep -q '● auto-start ON ('; then
  pass "status still shows '● auto-start ON (' after stop"
else
  fail "status should show '● auto-start ON (' after stop (auto-start not disabled)"
fi

say "  restarting daemon manually..."
bin/microviberd start >/dev/null 2>&1 || true
for i in {0..100}; do
  if [ "$(api_status "$TMP/h_start" "$BASE/api/health")" = "200" ]; then
    break
  fi
  sleep 0.1
done
AFTER_START="$(api_status "$TMP/h_start2" "$BASE/api/health")"
if [ "$AFTER_START" = "200" ]; then
  pass "start: health returns 200 again"
else
  fail "start: health still returns HTTP $AFTER_START"
fi

# ── CHECK 10: login simulation (launchctl cycle) ────────────────────────────────
hr "CHECK 10: login simulation (launchctl bootout / bootstrap)"
MY_UID="$(id -u)"
say "  simulating logout: launchctl bootout gui/$MY_UID/com.microviber.daemon"
launchctl bootout gui/$MY_UID/com.microviber.daemon 2>&1 | tee -a "$LOG" || true
sleep 2
AFTER_BOOTOUT="$(api_status "$TMP/h_bootout" "$BASE/api/health" 2>&1 || true)"
if [ "$AFTER_BOOTOUT" != "200" ]; then
  pass "after bootout: daemon is down (health: HTTP $AFTER_BOOTOUT)"
else
  fail "after bootout: daemon still answers 200"
fi

say "  simulating login: launchctl bootstrap gui/$MY_UID ~/Library/LaunchAgents/com.microviber.daemon.plist"
launchctl bootstrap gui/$MY_UID "$PLIST_PATH" 2>&1 | tee -a "$LOG" || true
sleep 2
say "  polling for daemon..."
AFTER_BOOTSTRAP_PID=""
for i in {0..100}; do
  AFTER_BOOTSTRAP_PID="$(lsof -ti:$MV_PORT 2>/dev/null | head -1 || echo '')"
  if [ -n "$AFTER_BOOTSTRAP_PID" ]; then
    break
  fi
  sleep 0.1
done
if [ -z "$AFTER_BOOTSTRAP_PID" ]; then
  fail "daemon did not start after bootstrap within 10s"
  say "  attempting recovery: autostart on..."
  bin/microviberd autostart on >/dev/null 2>&1 || true
  sleep 2
  RECOVERY_HEALTH="$(api_status "$TMP/h_recover10" "$BASE/api/health" 2>&1 || true)"
  if [ "$RECOVERY_HEALTH" = "200" ]; then
    say "  recovery succeeded (health 200); CHECK 10 failed but daemon is restored"
  else
    say "  recovery failed (health $RECOVERY_HEALTH); daemon may be down"
  fi
  exit 1
fi
HEALTH_AFTER_BOOTSTRAP="$(api_status "$TMP/h_bootstrap" "$BASE/api/health")"
if [ "$HEALTH_AFTER_BOOTSTRAP" = "200" ]; then
  pass "after bootstrap: daemon running (pid $AFTER_BOOTSTRAP_PID), health 200"
else
  fail "after bootstrap: health HTTP $HEALTH_AFTER_BOOTSTRAP (pid $AFTER_BOOTSTRAP_PID)"
fi

# ── CHECK 11: env inheritance ──────────────────────────────────────────────────
hr "CHECK 11: env inheritance"
# Part (a): plist must contain -il and exec .../bin/microviberd run
if grep -q '<string>-il</string>' "$PLIST_PATH" 2>/dev/null; then
  pass "plist contains -il (login shell flag)"
else
  fail "plist does not contain '<string>-il</string>' — daemon not started via login shell"
fi
if grep -q 'exec.*bin/microviberd run' "$PLIST_PATH" 2>/dev/null; then
  pass "plist contains 'exec .../bin/microviberd run'"
else
  fail "plist does not contain 'exec .../bin/microviberd run' — environment may not be inherited"
fi

# Part (b): verify env vars are actually present in the running login shell
HAS_VERTEX_USE=0
if "${SHELL:-/bin/bash}" -il -c 'printenv CLAUDE_CODE_USE_VERTEX' </dev/null 2>&1 | grep -q .; then
  HAS_VERTEX_USE=1
fi
HAS_VERTEX_PROJECT=0
if "${SHELL:-/bin/bash}" -il -c 'printenv ANTHROPIC_VERTEX_PROJECT_ID' </dev/null 2>&1 | grep -q .; then
  HAS_VERTEX_PROJECT=1
fi
if [ "$HAS_VERTEX_USE" = "1" ]; then
  pass "CLAUDE_CODE_USE_VERTEX is set in login shell"
else
  fail "CLAUDE_CODE_USE_VERTEX is not set in login shell"
fi
if [ "$HAS_VERTEX_PROJECT" = "1" ]; then
  pass "ANTHROPIC_VERTEX_PROJECT_ID is set in login shell"
else
  fail "ANTHROPIC_VERTEX_PROJECT_ID is not set in login shell"
fi

# ── CHECK 12: idempotency ──────────────────────────────────────────────────────
hr "CHECK 12: idempotency"
say "  running 'autostart on' again..."
bin/microviberd autostart on >/dev/null 2>&1 || true
sleep 1
IDEMPOTENT_PIDS="$(lsof -ti:$MV_PORT 2>/dev/null || true)"
IDEMPOTENT_COUNT="$(echo "$IDEMPOTENT_PIDS" | grep -c . || true)"
if [ -z "$IDEMPOTENT_COUNT" ]; then IDEMPOTENT_COUNT=0; fi
if [ "$IDEMPOTENT_COUNT" = "1" ]; then
  pass "still exactly one pid listening on port"
else
  fail "expected 1 pid, found $IDEMPOTENT_COUNT"
fi
IDEMPOTENT_HEALTH="$(api_status "$TMP/h_idem" "$BASE/api/health")"
if [ "$IDEMPOTENT_HEALTH" = "200" ]; then
  pass "health still 200"
else
  fail "health is HTTP $IDEMPOTENT_HEALTH (expected 200)"
fi

# ── CHECK 13: off ─────────────────────────────────────────────────────────────
hr "CHECK 13: autostart off"
OFF_OUT="$(bin/microviberd autostart off 2>&1)"
echo "$OFF_OUT" | tee -a "$LOG"
if [ ! -f "$PLIST_PATH" ]; then
  pass "plist file removed"
else
  fail "plist file still exists after off"
fi
if ! launchctl print "gui/$MY_UID/com.microviber.daemon" >/dev/null 2>&1; then
  pass "launchctl no longer knows the agent"
else
  fail "launchctl still sees the agent"
fi
sleep 1
AFTER_OFF="$(api_status "$TMP/h_off" "$BASE/api/health" 2>&1 || true)"
if [ "$AFTER_OFF" != "200" ]; then
  pass "nothing listens on port"
else
  fail "port still answers 200 after off"
fi
STATUS_AFTER_OFF="$(bin/microviberd autostart status 2>&1)"
if echo "$STATUS_AFTER_OFF" | grep -q '○ auto-start OFF'; then
  pass "status shows '○ auto-start OFF'"
else
  fail "expected '○ auto-start OFF' in status (got: $(echo "$STATUS_AFTER_OFF" | head -1))"
fi

# ── CHECK 14: restore (turn autostart back on) ─────────────────────────────────
hr "CHECK 14: restore (turn autostart back on)"
say "  restoring autostart ON..."
RESTORE_OUT="$(bin/microviberd autostart on 2>&1)"
echo "$RESTORE_OUT" | tee -a "$LOG"
if echo "$RESTORE_OUT" | grep -q 'MicroViber auto-start: ON'; then
  pass "autostart on: ON confirmed"
else
  fail "autostart on: 'ON' string not found"
fi
sleep 2
RESTORE_STATUS="$(bin/microviberd autostart status 2>&1)"
echo "$RESTORE_STATUS" | tee -a "$LOG"
say "  daemon left with autostart ON. Note: if this test aborted early at CHECK 1, nothing was installed/removed."

# ── summary ────────────────────────────────────────────────────────────────────
hr "summary"
if [ "$FAILS" = "0" ]; then
  say "ALL CHECKS PASSED ✅  Log: $LOG"
else
  say "$FAILS CHECK(S) FAILED ❌ Log: $LOG"
  say ""
  say "If a destructive check (KeepAlive, login simulation) failed and the daemon is down:"
  say "  ./bin/microviberd autostart on"
  say "This will re-render, reinstall, and reload the launchd agent to restore the daemon."
fi
say ""
say "Note: if this test aborted early at CHECK 1 (preflight), nothing was installed or removed."
exit "$FAILS"
