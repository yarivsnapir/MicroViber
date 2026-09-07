#!/bin/bash
# story-1-manual-test.sh — push-notification-dispatch-1
#
# Verifies the daemon half of this story end to end against a REAL daemon
# process, a REAL HTTP surface and a REAL store file — the parts of the story's
# manual checklist that do not need a physical phone.
#
# Isolation (this script must never disturb a working install):
#   * HOME is redirected to a temp dir, so the store lands in <tmp>/.microviber/
#     and the real ~/.microviber is untouched (os.homedir() honours $HOME).
#   * Ports 8799/8798, never the daemon's default 8730.
#   * A dummy bearer token is passed in the environment, so the daemon never
#     falls back to reading the real ~/.microviber/token.
#   * Throwaway VAPID keys generated per run. No real key is read.
#   * The only outbound traffic is to 127.0.0.1. Nothing is sent to a push service.
#
# Usage: ./story-1-manual-test.sh    (from anywhere; paths resolve off this file)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PORT=8799; CPORT=8798; BASE="http://127.0.0.1:$PORT"
TOKEN="storytest-bearer-0123456789abcdef0123456789"
TMP="$(mktemp -d)"; LOG="$TMP/daemon.log"
PASS=0; FAIL=0
ok()   { echo "✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "❌ $1"; [ -n "${2:-}" ] && echo "     got: $2"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null
  wait "${PID:-}" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

start_daemon() { # $1 = "enabled" | "disabled"
  mkdir -p "$TMP"; : >>"$LOG"
  # `trap - EXIT` inside the subshell: a backgrounded subshell inherits the EXIT
  # trap, and if it dies it would run cleanup and delete $TMP mid-run. bash 3.2
  # has no BASHPID, so clearing the trap is the portable fix, not a PID check.
  if [ "$1" = "enabled" ]; then
    ( trap - EXIT
      exec env HOME="$TMP" MV_BIND_ADDRESS=127.0.0.1 MV_PORT=$PORT MV_WEBPANE_CONTENT_PORT=$CPORT \
        MV_BEARER_TOKEN="$TOKEN" MV_VAPID_PUBLIC_KEY="$VPUB" MV_VAPID_PRIVATE_KEY="$VPRIV" \
        node "$REPO/daemon/dist/index.js" ) >>"$LOG" 2>&1 &
  else
    # MV_VAPID_* genuinely absent from the environment — the real "no keys" case.
    ( trap - EXIT
      exec env -u MV_VAPID_PUBLIC_KEY -u MV_VAPID_PRIVATE_KEY \
        HOME="$TMP" MV_BIND_ADDRESS=127.0.0.1 MV_PORT=$PORT MV_WEBPANE_CONTENT_PORT=$CPORT \
        MV_BEARER_TOKEN="$TOKEN" \
        node "$REPO/daemon/dist/index.js" ) >>"$LOG" 2>&1 &
  fi
  PID=$!
  for _ in $(seq 1 50); do
    curl -sf -m 1 "$BASE/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
stop_daemon() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""; }
auth=(-H "Authorization: Bearer $TOKEN" -H "content-type: application/json")

echo "=== push-notification-dispatch-1 — daemon-side verification ==="
echo "repo:  $REPO"
echo "HOME:  $TMP  (real ~/.microviber untouched)"
echo

echo "--- build ---"
( cd "$REPO" && npm run build >/dev/null 2>&1 ) && ok "npm run build" || { bad "npm run build"; exit 1; }

VPUB=""; VPRIV=""
eval "$(cd "$REPO/daemon" && node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log('VPUB='+k.publicKey+'\nVPRIV='+k.privateKey)")"
[ -n "$VPUB" ] && ok "generated throwaway VAPID keys" || { bad "VAPID keygen"; exit 1; }
echo

echo "--- A. opt-in gate: NO keys => no push capability, no outbound path (T18 (a)) ---"
if start_daemon disabled; then
  ok "daemon started without MV_VAPID_*"
  grep -q 'Push notifications: disabled' "$LOG" && ok "startup line says push is disabled" || bad "startup line" "$(grep -i 'push notif' "$LOG" | tail -1)"
  cfg=$(curl -s "${auth[@]}" "$BASE/api/push/config")
  check "GET /api/push/config reports disabled + null key" "$cfg" '{"success":true,"data":{"enabled":false,"publicKey":null}}'
  code=$(curl -s -o "$TMP/r1" -w '%{http_code}' "${auth[@]}" -X POST "$BASE/api/push/subscribe" \
      -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/story-test-A","keys":{"p256dh":"BPx","auth":"aX"}}')
  check "POST /api/push/subscribe refuses when unconfigured" "$code" "400"
  grep -q 'not configured' "$TMP/r1" && ok "...with an actionable message" || bad "message" "$(cat "$TMP/r1")"
  [ ! -e "$TMP/.microviber/push-subscriptions.json" ] && ok "no store file written while disabled" || bad "store file created while push disabled"
  stop_daemon
else bad "daemon failed to start (disabled branch)"; fi
echo

echo "--- B. enabled: config, T18 endpoint guard live over HTTP, subscribe persists ---"
: > "$LOG"
if start_daemon enabled; then
  ok "daemon started with MV_VAPID_*"
  grep -q 'Push notifications: enabled' "$LOG" && ok "startup line says push is enabled" || bad "startup line" "$(grep -i 'push notif' "$LOG" | tail -1)"
  cfg=$(curl -s "${auth[@]}" "$BASE/api/push/config")
  check "GET /api/push/config exposes the VAPID public key" "$cfg" "{\"success\":true,\"data\":{\"enabled\":true,\"publicKey\":\"$VPUB\"}}"

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/push/subscribe" -H 'content-type: application/json' \
      -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/x","keys":{"p256dh":"BPx","auth":"aX"}}')
  check "subscribe without a bearer => 401" "$code" "401"

  # T18 (b): the guard must reject an endpoint aimed at the tailnet/loopback/LAN,
  # over the real HTTP surface — not just in the unit tests.
  for bad_ep in "https://127.0.0.1:$PORT/api/sessions" "https://localhost./x" "https://laptop.taila39b16.ts.net/api/sessions" \
                "https://mv.localtest.me:8730/api/sessions" "http://fcm.googleapis.com/fcm/send/x" "https://nas/x"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST "$BASE/api/push/subscribe" \
        -d "{\"endpoint\":\"$bad_ep\",\"keys\":{\"p256dh\":\"BPx\",\"auth\":\"aX\"}}")
    check "T18 guard rejects $bad_ep" "$code" "400"
  done

  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST "$BASE/api/push/subscribe" \
      -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/story-test-B","expirationTime":null,"keys":{"p256dh":"BPxRealLookingKey","auth":"aXsecret"}}')
  check "a real public https endpoint is accepted" "$code" "200"

  STORE="$TMP/.microviber/push-subscriptions.json"
  [ -f "$STORE" ] && ok "store file created at \$HOME/.microviber/push-subscriptions.json" || bad "store file missing"
  perms=$(stat -f '%Lp' "$STORE" 2>/dev/null || stat -c '%a' "$STORE" 2>/dev/null)
  check "store file is 0600 (holds push credentials)" "$perms" "600"
  grep -q 'story-test-B' "$STORE" && ok "the subscription really landed on disk" || bad "endpoint not in store"
  grep -q 'push.subscribe' "$TMP/.microviber/audit.jsonl" 2>/dev/null && ok "registration is audited (host only)" || bad "no audit line"
  grep -q 'fcm.googleapis.com/fcm/send' "$TMP/.microviber/audit.jsonl" 2>/dev/null && bad "audit leaked the endpoint PATH (must be host only)" || ok "audit records host only, never the endpoint path"
  stop_daemon
else bad "daemon failed to start (enabled branch)"; fi
echo

echo "--- C. AC3: the subscription SURVIVES a daemon restart (the checklist's last item) ---"
: > "$LOG"
if start_daemon enabled; then
  line=$(grep 'Push notifications: enabled' "$LOG" | tail -1)
  echo "     startup line: ${line#*] }"
  case "$line" in
    *"1 subscription(s)"*) ok "restarted daemon reloaded the subscription from disk (1 subscription)";;
    *) bad "restarted daemon did not report the persisted subscription" "$line";;
  esac
  cfg=$(curl -s "${auth[@]}" "$BASE/api/push/config")
  check "push still enabled after restart" "$cfg" "{\"success\":true,\"data\":{\"enabled\":true,\"publicKey\":\"$VPUB\"}}"
  stop_daemon
else bad "daemon failed to restart"; fi
echo

echo "--- D. fail-closed on a corrupted store (documented AC3 behaviour) ---"
: > "$LOG"
printf '{ truncated' > "$TMP/.microviber/push-subscriptions.json"
if start_daemon enabled; then
  bad "daemon started despite a corrupt store (expected fail-closed)"; stop_daemon
else
  grep -q 'push-subscriptions.json' "$LOG" && ok "refuses to start on a corrupt store, naming the file" || bad "failed to start but did not name the file" "$(tail -2 "$LOG")"
fi
echo

echo "=== $PASS passed, $FAIL failed ==="
echo "Real daemon on 8730 untouched; nothing sent to any push service."
[ "$FAIL" -eq 0 ] || exit 1
