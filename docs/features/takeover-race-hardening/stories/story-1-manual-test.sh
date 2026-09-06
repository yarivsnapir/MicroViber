#!/usr/bin/env bash
# takeover-race-hardening-1 — live manual test (story checklist items 2 and 3).
#
# What it does, end to end, against YOUR daemon and one of YOUR idle Claude Code sessions:
#   1. loads the daemon env (.env, else daemon/.env) and your bearer token — the token is
#      never printed or logged;
#   2. starts the daemon if it is not already answering (and stops it again at the end,
#      only if this script started it);
#   3. picks an idle, writable, not-taken-over session (override: MV_TEST_SESSION_ID=<id>);
#   4. fires TWO takeover requests at the same instant  -> expects exactly ONE `claude --resume` child;
#   5. handback, then IMMEDIATELY takeover again          -> expects the session to stay taken over and
#      exactly one child to survive (acceptance criterion 7);
#   6. final handback                                     -> expects zero children left.
# Nothing is ever typed into the session; the spawned child only idles and is then killed.
#
# Run from the microviber repo root:
#   bash docs/features/takeover-race-hardening/stories/story-1-manual-test.sh
# A redacted copy of everything printed is written to $LOG (inside the repo, git-ignored).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT" || exit 1
LOG="${MV_TEST_LOG:-$ROOT/.superpowers/sdd/story-1-plan/manual-test.log}"
mkdir -p "$(dirname "$LOG")"; : > "$LOG"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILS=0; STARTED=0

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
pass() { say "  ✅ $*"; }
fail() { say "  ❌ $*"; FAILS=$((FAILS + 1)); }
hr()   { say ""; say "── $* ──"; }

say "takeover-race-hardening-1 live test — $(date '+%Y-%m-%d %H:%M:%S') — branch $(git branch --show-current) @ $(git rev-parse --short HEAD)"

# ── 1. env + token ─────────────────────────────────────────────────────────────
hr "1. environment"
set -a
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
[ -z "${MV_BIND_ADDRESS:-}" ] && [ -f "$ROOT/daemon/.env" ] && . "$ROOT/daemon/.env"
set +a
if [ -z "${MV_BIND_ADDRESS:-}" ]; then fail "MV_BIND_ADDRESS not set in .env or daemon/.env — cannot reach the daemon"; exit 1; fi
MV_PORT="${MV_PORT:-8730}"
HOSTHDR="${MV_ALLOWED_HOSTS%%,*}"; HOSTHDR="${HOSTHDR:-$MV_BIND_ADDRESS}"
BASE="http://${MV_BIND_ADDRESS}:${MV_PORT}"
TOKEN_FILE="${MV_TOKEN_FILE:-$HOME/.microviber/token}"
# Same precedence as the daemon (daemon/src/index.ts): MV_BEARER_TOKEN from the env file wins, else ~/.microviber/token.
TOKEN="${MV_BEARER_TOKEN:-$(tr -d '[:space:]' < "$TOKEN_FILE" 2>/dev/null || true)}"
if [ -z "$TOKEN" ]; then fail "no bearer token: MV_BEARER_TOKEN unset and nothing at $TOKEN_FILE"; exit 1; fi
say "  daemon base: $BASE   (Host header: $HOSTHDR)"
pass "token loaded from $([ -n "${MV_BEARER_TOKEN:-}" ] && echo "MV_BEARER_TOKEN (env file)" || echo "$TOKEN_FILE") (${#TOKEN} chars, never shown)"

api() { curl -sS -m 15 -H "Authorization: Bearer $TOKEN" -H "Host: $HOSTHDR" "$@"; }
# api_status <out-file> <curl args…>  -> prints HTTP status, body saved to out-file
api_status() { local out="$1"; shift; api -o "$out" -w '%{http_code}' "$@" 2>>"$LOG" || echo "000"; }

# ── 2. daemon ──────────────────────────────────────────────────────────────────
hr "2. daemon"
if [ "$(api_status "$TMP/h" "$BASE/api/health")" = "200" ]; then
  say "  daemon already running — NOTE: it must have been started AFTER the last 'npm run build' or it runs old code."
  say "  If unsure: bin/microviberd stop  (or kill your manually started daemon), then rerun this script."
else
  if [ ! -f daemon/dist/index.js ]; then fail "daemon/dist/index.js missing — run: npm run build --workspace @microviber/daemon"; exit 1; fi
  if [ daemon/src/domain/ownership.ts -nt daemon/dist/domain/ownership.js ]; then fail "daemon/dist is OLDER than the source — run: npm run build --workspace @microviber/daemon"; exit 1; fi
  bin/microviberd start >/dev/null 2>&1   # its own output can include the pairing URL, so it is not echoed
  STARTED=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(api_status "$TMP/h" "$BASE/api/health")" = "200" ] && break
    sleep 1
  done
fi
HS="$(api_status "$TMP/h" "$BASE/api/health")"
if [ "$HS" = "200" ]; then
  pass "GET /api/health → 200 (started by this script: $STARTED)"
else
  fail "GET /api/health → HTTP $HS. Body: $(head -c 300 "$TMP/h" 2>/dev/null)"
  [ "$HS" = "421" ] && say "  421 = Host header not in MV_ALLOWED_HOSTS. Set MV_ALLOWED_HOSTS in .env to include '$HOSTHDR' or the daemon's hostname."
  [ "$HS" = "401" ] && say "  401 = token rejected. Is $TOKEN_FILE the token this daemon was started with?"
  [ "$STARTED" = 1 ] && bin/microviberd stop >/dev/null 2>&1
  exit 1
fi
cleanup_daemon() { if [ "$STARTED" = 1 ]; then bin/microviberd stop >/dev/null 2>&1 && say "  (daemon stopped again — it was started by this script)"; fi; }

# ── 3. pick a session ──────────────────────────────────────────────────────────
hr "3. sessions"
if [ "$(api_status "$TMP/s" "$BASE/api/sessions")" != "200" ]; then fail "GET /api/sessions failed: $(head -c 300 "$TMP/s")"; cleanup_daemon; exit 1; fi
jq -r '.data[] | "  \(.id[0:8])…  state=\(.state)  writable=\(.writable)  takenOver=\(.takenOver)  cwd=\(.cwd)  title=\(.title[0:40])"' "$TMP/s" | tee -a "$LOG"
if [ -n "${MV_TEST_SESSION_ID:-}" ]; then ID="$MV_TEST_SESSION_ID"; else
  ID="$(jq -r '[.data[] | select((.state=="idle" or .state=="awaiting-input") and .writable==true and .takenOver==false)][0].id // empty' "$TMP/s")"
fi
if [ -z "$ID" ]; then
  fail "no idle, writable, not-taken-over session found. Open a Claude Code session in a terminal, leave it idle for ~30s, rerun."
  cleanup_daemon; exit 1
fi
pass "using session ${ID:0:8}…  (override with MV_TEST_SESSION_ID=<full id>)"

children() { pgrep -f "resume ${ID}" 2>/dev/null | sort; }
BASELINE="$(children | wc -l | tr -d ' ')"
say "  claude --resume children for this session before the test: $BASELINE"
[ "$BASELINE" != "0" ] && say "  (a stale child already exists — the counts below are relative to it)"
taken_over() { api "$BASE/api/sessions" 2>>"$LOG" | jq -r --arg id "$ID" '.data[] | select(.id==$id) | .takenOver'; }

# ── 4. race: two takeovers at once ─────────────────────────────────────────────
hr "4. two concurrent takeover requests"
api_status "$TMP/t1" -X POST "$BASE/api/sessions/$ID/takeover" > "$TMP/c1" &
api_status "$TMP/t2" -X POST "$BASE/api/sessions/$ID/takeover" > "$TMP/c2" &
wait
C1="$(cat "$TMP/c1")"; C2="$(cat "$TMP/c2")"
say "  responses: HTTP $C1 $(head -c 120 "$TMP/t1") | HTTP $C2 $(head -c 120 "$TMP/t2")"
if [ "$C1" = "200" ] && [ "$C2" = "200" ]; then pass "both takeover requests returned 200"; else fail "expected 200/200, got $C1/$C2"; fi
sleep 2
AFTER_RACE="$(children)"; N1="$(printf '%s' "$AFTER_RACE" | grep -c . || true)"
say "  children now: $N1 (pids: $(printf '%s' "$AFTER_RACE" | tr '\n' ' '))"
if [ "$((N1 - BASELINE))" = "1" ]; then pass "exactly ONE new 'claude --resume' child was spawned"; else fail "expected exactly 1 new child, found $((N1 - BASELINE))"; fi
TO1="$(taken_over)"; [ "$TO1" = "true" ] && pass "session reports takenOver=true" || fail "session reports takenOver=$TO1 (expected true)"

# ── 5. AC7: handback, then immediately take over again ────────────────────────
hr "5. handback → immediate re-takeover (AC7)"
H1="$(api_status "$TMP/hb1" -X POST "$BASE/api/sessions/$ID/handback")"
T3="$(api_status "$TMP/t3" -X POST "$BASE/api/sessions/$ID/takeover")"
say "  handback HTTP $H1 → takeover HTTP $T3 $(head -c 120 "$TMP/t3")"
[ "$H1" = "200" ] && [ "$T3" = "200" ] && pass "handback and re-takeover both returned 200" || fail "expected 200/200, got $H1/$T3"
sleep 4   # give the handed-back child time to actually exit
AFTER_RE="$(children)"; N2="$(printf '%s' "$AFTER_RE" | grep -c . || true)"
say "  children now: $N2 (pids: $(printf '%s' "$AFTER_RE" | tr '\n' ' '))"
if [ "$((N2 - BASELINE))" = "1" ]; then pass "exactly one child survives (old one exited, new one alive)"; else fail "expected exactly 1 surviving child, found $((N2 - BASELINE))"; fi
if [ -n "$AFTER_RE" ] && [ "$AFTER_RE" != "$AFTER_RACE" ]; then pass "the surviving child is the NEW one (different pid)"; else fail "surviving pid set unchanged — the old child may still be alive or the new one died"; fi
TO2="$(taken_over)"
if [ "$TO2" = "true" ]; then pass "session STILL reports takenOver=true after the old child exited (AC7: the survivor was not reaped)"; else fail "session reports takenOver=$TO2 — the late exit reaped the survivor (AC7 broken)"; fi

# ── 6. final handback ──────────────────────────────────────────────────────────
hr "6. final handback"
H2="$(api_status "$TMP/hb2" -X POST "$BASE/api/sessions/$ID/handback")"
[ "$H2" = "200" ] && pass "handback → 200" || fail "handback → HTTP $H2"
sleep 4
N3="$(children | wc -l | tr -d ' ')"
[ "$N3" = "$BASELINE" ] && pass "no 'claude --resume' child left for this session (back to $BASELINE)" || fail "$((N3 - BASELINE)) child(ren) still alive after handback — orphan!"
TO3="$(taken_over)"; [ "$TO3" = "false" ] && pass "session reports takenOver=false" || fail "session reports takenOver=$TO3 (expected false)"

# ── summary ────────────────────────────────────────────────────────────────────
hr "summary"
cleanup_daemon
if [ "$FAILS" = "0" ]; then say "ALL CHECKS PASSED ✅  — reply 'done' to Claude. Log: $LOG"; else say "$FAILS CHECK(S) FAILED ❌ — reply 'done' to Claude; it reads the log: $LOG"; fi
exit "$FAILS"
