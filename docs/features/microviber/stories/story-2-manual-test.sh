#!/usr/bin/env bash
#
# story-2-manual-test.sh — manual verification for microviber story-2
# (daemon takeover/handback/prompt-403 routes).
#
# Not run automatically by any task — the orchestrator runs this by hand
# against a disposable session, at the manual-test step.
#
# Usage:
#   story-2-manual-test.sh SESSION_ID [NEVER_OWNED_ID]
#
# Env (all optional):
#   BASE_URL  default: http://127.0.0.1:${MV_PORT:-8730}
#   TOKEN     default: contents of ~/.microviber/token
#
# Exit code = number of failed checks (0 == all green).

set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:${MV_PORT:-8730}}"
SESSION_ID="${1:?usage: story-2-manual-test.sh SESSION_ID [NEVER_OWNED_ID]}"
NEVER_OWNED_ID="${2:-}"

if [ -z "${TOKEN:-}" ]; then
  TOKEN_FILE="${HOME}/.microviber/token"
  if [ -f "$TOKEN_FILE" ]; then
    TOKEN="$(cat "$TOKEN_FILE")"
  else
    echo "❌ no TOKEN set and no token file at $TOKEN_FILE" >&2
    exit 1
  fi
fi

FAILURES=0

pass() {
  echo "✅ $1"
}

fail() {
  echo "❌ $1"
  FAILURES=$((FAILURES + 1))
}

# Runs a curl request, capturing body + HTTP status.
# Sets globals: RESP_BODY, RESP_STATUS
# Args: method path [extra curl args...]
do_request() {
  local method="$1"
  local path="$2"
  shift 2
  local tmp
  tmp="$(mktemp)"
  local status
  status="$(curl -s -o "$tmp" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${TOKEN}" \
    "$@" \
    "${BASE_URL}${path}")"
  RESP_STATUS="$status"
  RESP_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "❌ jq is required but not installed" >&2
    exit 1
  fi
}

require_jq

# --- 1. GET /api/health -> 200 -------------------------------------------
do_request GET "/api/health"
if [ "$RESP_STATUS" = "200" ]; then
  pass "GET /api/health -> 200"
else
  fail "GET /api/health -> expected 200, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 2. GET /api/sessions -> 200; show SESSION_ID's id/mode/takenOver ----
do_request GET "/api/sessions"
if [ "$RESP_STATUS" = "200" ]; then
  pass "GET /api/sessions -> 200"
  SESSION_JSON="$(echo "$RESP_BODY" | jq -c --arg id "$SESSION_ID" '.data[] | select(.id == $id)')"
  if [ -n "$SESSION_JSON" ]; then
    echo "   session ${SESSION_ID}: $(echo "$SESSION_JSON" | jq -c '{id, mode, takenOver}')"
  else
    echo "   (session ${SESSION_ID} not present in list yet)"
  fi
else
  fail "GET /api/sessions -> expected 200, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 3. POST /api/sessions/$SESSION_ID/takeover -> 200, mode=="owned" ---
do_request POST "/api/sessions/${SESSION_ID}/takeover"
if [ "$RESP_STATUS" = "200" ] && [ "$(echo "$RESP_BODY" | jq -r '.data.mode')" = "owned" ]; then
  pass "POST /api/sessions/${SESSION_ID}/takeover -> 200, mode=owned"
else
  fail "POST .../takeover -> expected 200/mode=owned, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 4. POST /api/sessions/$SESSION_ID/prompt -> 200, .data.state present -
IDEMPOTENCY_KEY_1="$(uuidgen)"
do_request POST "/api/sessions/${SESSION_ID}/prompt" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY_1}" \
  -H "Content-Type: application/json" \
  -d '{"text":"MicroViber verification ping — reply with exactly: MV-VERIFY-OK"}'
if [ "$RESP_STATUS" = "200" ] && [ "$(echo "$RESP_BODY" | jq -r '.data.state')" != "null" ]; then
  pass "POST .../prompt -> 200, .data.state present"
else
  fail "POST .../prompt -> expected 200/.data.state, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 5. Poll transcript up to 60s until the prompt text appears ---------
PROMPT_TEXT="MicroViber verification ping"
TRANSCRIPT_FOUND=0
for _ in $(seq 1 30); do
  do_request GET "/api/sessions/${SESSION_ID}/transcript"
  if [ "$RESP_STATUS" = "200" ] && echo "$RESP_BODY" | jq -e --arg t "$PROMPT_TEXT" \
      '.data.events[] | tostring | test($t)' >/dev/null 2>&1; then
    TRANSCRIPT_FOUND=1
    break
  fi
  sleep 2
done
if [ "$TRANSCRIPT_FOUND" = "1" ]; then
  pass "transcript contains prompt text (found within 60s)"
else
  fail "transcript never showed prompt text within 60s (last status ${RESP_STATUS})"
fi

# --- 6. POST takeover again -> 200, same id (idempotent) ----------------
do_request POST "/api/sessions/${SESSION_ID}/takeover"
if [ "$RESP_STATUS" = "200" ] && [ "$(echo "$RESP_BODY" | jq -r '.data.id')" = "$SESSION_ID" ]; then
  pass "repeat takeover -> 200, same id (idempotent)"
else
  fail "repeat takeover -> expected 200/id=${SESSION_ID}, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 7. (optional) prompt on a never-taken-over session -> 403 FORBIDDEN
if [ -n "$NEVER_OWNED_ID" ]; then
  IDEMPOTENCY_KEY_2="$(uuidgen)"
  do_request POST "/api/sessions/${NEVER_OWNED_ID}/prompt" \
    -H "Idempotency-Key: ${IDEMPOTENCY_KEY_2}" \
    -H "Content-Type: application/json" \
    -d '{"text":"should be rejected"}'
  if [ "$RESP_STATUS" = "403" ] && [ "$(echo "$RESP_BODY" | jq -r '.error.code')" = "FORBIDDEN" ]; then
    pass "POST prompt on never-owned session -> 403 FORBIDDEN"
  else
    fail "POST prompt on never-owned session -> expected 403/FORBIDDEN, got ${RESP_STATUS} (body: ${RESP_BODY})"
  fi
else
  echo "⏭  skipping never-owned-session check (no NEVER_OWNED_ID given)"
fi

# --- 8. POST handback -> 200, mode=="readonly" ---------------------------
do_request POST "/api/sessions/${SESSION_ID}/handback"
if [ "$RESP_STATUS" = "200" ] && [ "$(echo "$RESP_BODY" | jq -r '.data.mode')" = "readonly" ]; then
  pass "POST .../handback -> 200, mode=readonly"
else
  fail "POST .../handback -> expected 200/mode=readonly, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

# --- 9. GET /api/sessions -> SESSION_ID takenOver==false ------------------
do_request GET "/api/sessions"
if [ "$RESP_STATUS" = "200" ] && \
   [ "$(echo "$RESP_BODY" | jq -r --arg id "$SESSION_ID" '.data[] | select(.id == $id) | .takenOver')" = "false" ]; then
  pass "GET /api/sessions -> ${SESSION_ID} takenOver=false"
else
  fail "GET /api/sessions -> ${SESSION_ID} takenOver not false, got ${RESP_STATUS} (body: ${RESP_BODY})"
fi

echo ""
echo "----------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ all checks passed"
else
  echo "❌ ${FAILURES} check(s) failed"
fi

exit "$FAILURES"
