#!/bin/bash
# story-1-phone-test.sh — push-notification-dispatch-1
#
# Runs THIS BRANCH's daemon on the normal port so the phone can exercise the
# push path, then restores whatever was running before.
#
# Why this exists: the daemon that normally serves the phone is built from
# whatever branch the shared checkout happens to be on. Until this story is
# merged, that build contains no push code at all — no sender, no
# /api/push/subscribe route, and a PWA bundle with no "Enable" banner — so the
# phone cannot register a subscription and no push can ever arrive.
#
# What it does NOT do: it never reads, prints, or edits .env or the bearer
# token, and it never generates or looks at your VAPID keys. It only checks
# that the two key lines are present and non-empty.
set -uo pipefail

BRANCH_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
LIVE_REPO="/Users/yariv_s/Harness-2/microviber"   # the checkout that owns .env
ENV_FILE="$LIVE_REPO/daemon/.env"
AGENT="com.microviber.daemon"
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
booted_out=0

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

restore() {
  if [ "$booted_out" = "1" ] && [ -f "$PLIST" ]; then
    say "Restoring the normal daemon (launchd agent)…"
    launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null
    sleep 1
    if curl -sf -m 2 http://127.0.0.1:8730/api/health >/dev/null 2>&1; then
      echo "✅ the normal daemon is back on 8730"
    else
      echo "⚠️  it did not come back — start it with:"
      echo "    launchctl bootstrap gui/\$UID $PLIST"
    fi
  fi
}
trap restore EXIT INT TERM

say "1. Preconditions"
[ -f "$ENV_FILE" ] || { echo "❌ no $ENV_FILE — follow INSTALL.md Stage 3 first."; exit 1; }
echo "✅ .env present (not read beyond checking these two key names exist)"

missing=0
for k in MV_VAPID_PUBLIC_KEY MV_VAPID_PRIVATE_KEY; do
  # -q and a value test only: the value is never printed or captured.
  if grep -Eq "^${k}=.+" "$ENV_FILE"; then echo "✅ $k is set"; else echo "❌ $k is missing or empty"; missing=1; fi
done
if [ "$missing" = "1" ]; then
  cat <<MSG

Push is opt-in and the daemon needs a VAPID key pair. Generate one and paste it
into $ENV_FILE yourself (INSTALL.md Step 3.2 — I deliberately do not touch your .env):

    cd "$LIVE_REPO/daemon" && npx web-push generate-vapid-keys

Add the two lines, then re-run this script:

    MV_VAPID_PUBLIC_KEY=<the Public Key>
    MV_VAPID_PRIVATE_KEY=<the Private Key>
MSG
  exit 1
fi

say "2. Building this branch"
( cd "$BRANCH_REPO" && npm run build ) >/dev/null 2>&1 \
  && echo "✅ built $(cd "$BRANCH_REPO" && git rev-parse --short HEAD) ($(cd "$BRANCH_REPO" && git branch --show-current))" \
  || { echo "❌ build failed — run 'npm run build' in $BRANCH_REPO to see why"; exit 1; }

say "3. Stopping the normal daemon so this build can take port 8730"
if launchctl print "gui/$UID/$AGENT" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$AGENT" 2>/dev/null
  booted_out=1
  sleep 1
  echo "✅ launchd agent stopped (it will be restored when you stop this script)"
else
  echo "ℹ️  no launchd agent loaded; if a daemon is running some other way, stop it now"
fi
if lsof -nP -iTCP:8730 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ something still holds port 8730. Stop it and re-run."; exit 1
fi

say "4. Starting this branch's daemon (Ctrl-C when you are done testing)"
cat <<MSG
On the phone, in order:

  1. Fully close the MicroViber PWA and reopen it, so it picks up this build's
     service worker and app bundle. (A push notification can only be shown by
     the new sw.js, and the "Enable" banner only exists in this build.)
  2. Tap "Enable" on the one-line banner under the title bar, and allow
     notifications. The banner disappears once it succeeds.
  3. Background the app.
  4. On the laptop, let a Claude Code session go idle (~20s of no output) or
     leave one waiting on an AskUserQuestion.
  5. You should get a notification titled with the SESSION's title, body
     "Waiting for you · <folder> — <last prompt>" (or "Needs your answer · …"),
     under MicroViber's own icon. Tapping it should open that session.

About the notification in your screenshot: "Tap to copy the URL for this app"
with Share / "Open in browser" is Chrome's OWN notification for a site running
in standalone mode without a proper install — not this feature's push, and not
something this app's code can suppress or restyle. If it bothers you, install
the PWA through Chrome's menu -> "Install app" (which creates a real WebAPK)
rather than an "Add to Home screen" shortcut.

Daemon output follows. Push activity is logged here.
MSG
echo
cd "$BRANCH_REPO/daemon"
exec node --env-file="$ENV_FILE" "$BRANCH_REPO/daemon/dist/index.js"
