---
id: push-notification-dispatch-1
title: "Daemon + PWA: wire NotifyPolicy into a real Web Push sender"
status: todo
project: microviber
depends_on: []
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/35
---

## User Story
As a developer who has walked away from my laptop while a session is running, I want my phone to receive a push notification the moment a session becomes idle or blocked on `AskUserQuestion`, so that I don't have to keep the PWA open and polling to know when a session needs me.

## Acceptance Criteria

**Prerequisite spike (must run first, gates everything else):**
1. Confirm push delivery actually works end-to-end against a real device over this daemon's existing tailscale/self-signed-HTTPS transport (`web-push`'s VAPID signing + a real browser's push subscription). Browser push relies on the browser vendor's own push service (e.g. FCM for Chrome) — a THIRD-PARTY network dependency this single-user, tailnet-only daemon has never talked to before. Verify it isn't blocked by the same "never talks to the public internet" posture the rest of this daemon holds, and record whatever's found — including if it turns out the daemon needs outbound internet access for this one feature, which may be a genuine design tradeoff to flag rather than implement past. Document the outcome as a new finding row in `docs/architecture-spec.md` §2.

**Sender + subscription (daemon):**
2. `daemon/package.json` gains the `web-push` dependency; a thin `lib/push-sender.ts` (adapter-layer-adjacent, but NOT inside `lib/claude-adapter/` — it has nothing to do with Claude Code internals) wraps VAPID-signed send calls, reading `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` from `config.ts` (already present, unused until now).
3. A new endpoint (e.g. `POST /api/push/subscribe`) accepts a browser `PushSubscription` object (bearer-gated, like every other route) and persists it. In-memory is acceptable for v1 (mirrors `OwnershipRegistry`'s existing "daemon restart reverts to a safe default" pattern), but the story must explicitly decide and document whether that's acceptable long-term (a restart silently un-subscribes the phone) or whether it needs the existing `devports.json`-style on-disk persistence instead.
4. `services.ts`'s session-list refresh loop (or an equivalent poll) feeds each cycle's session list into `NotifyPolicy.reconcile()` and dispatches every returned `NotifyIntent` through the new sender — `'notify'` intents send a real push with the session's title + status line; `'dismiss'` intents are honored however the browser Push/Notifications API models dismissal (a `tag`-keyed replace-not-stack is the existing `NotifyPolicy` design — confirm this maps cleanly to the real API, or document the gap).

**PWA (subscription + display):**
5. `pwa/public/sw.js` (the existing minimal service worker registered by `main.tsx`) gains a `push` event handler that shows a `Notification` using the payload, and a `notificationclick` handler that focuses/opens the PWA to the relevant session.
6. The PWA requests `Notification` permission and calls `pushManager.subscribe()` with the daemon's public VAPID key (fetched from a new small config endpoint, or embedded at build time — implementer's call, document the choice) at an appropriate moment (e.g. after first successful pairing, not on cold load before the user has even authenticated) and POSTs the resulting subscription to `/api/push/subscribe`.

**Tests + docs:**
7. `daemon/test/notify-policy.test.ts` (already covers `NotifyPolicy.reconcile()` in isolation) gains coverage for the new wiring — a test that a `'notify'` intent actually results in a call to the injected sender, and a `'dismiss'` intent does not.
8. `docs/architecture-spec.md` gets a new entry: this is the daemon's first outbound call to a third-party service (the browser vendor's push endpoint) — document what that means for the existing "personal tool, tailnet-only" threat model framing, and add bearer-auth to the new subscribe endpoint under the existing microviber security checklist.

## Affected Files
- `daemon/package.json` — new `web-push` dependency.
- `daemon/src/lib/push-sender.ts` — new.
- `daemon/src/api/app.ts` — new `/api/push/subscribe` route.
- `daemon/src/schemas/api.ts` — subscription body schema.
- `daemon/src/services/services.ts` — wires `NotifyPolicy.reconcile()` + dispatch into the poll loop.
- `daemon/src/domain/notify-policy.ts` — already exists, unmodified unless criterion 4 surfaces a real gap.
- `pwa/public/sw.js` — push + notificationclick handlers.
- `pwa/src/lib/api.ts` — new subscribe call.
- `pwa/src/App.tsx` — subscription flow.
- `docs/architecture-spec.md` — new entry (criterion 1, criterion 8).

## Technical Notes
`NotifyPolicy` (`daemon/src/domain/notify-policy.ts`) already exists, is fully unit-tested in isolation, and has ZERO call sites in the shipped app today (confirmed via workspace-wide grep) — this story is entirely "wire it up for real," not "design the policy." `config.ts` already validates `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` as optional env vars with no consumer yet.

This is a genuinely new subsystem (dependency, endpoint, service worker, PWA subscription flow) touching more surface than most single stories in this repo. If the implementer finds criterion 1's spike surfaces a real blocker (e.g. push genuinely requires unwanted outbound internet exposure for a tool whose entire security posture is "tailnet-only"), stop and return to brainstorming on the sender mechanism specifically, same as story `microviber-track-b-8` did for its own gated spike, rather than shipping a compromised design past that finding.

Explicitly out of scope, called out in `microviber-track-b-8`'s own notes and re-confirmed here: this story is the "build the actual sender" follow-up that story was told NOT to absorb — it is now this story's entire purpose, not an expansion of it.

## Manual Test Checklist
- [ ] Complete the spike (criterion 1) and record its outcome before writing any other code.
- [ ] `cd microviber && npm run typecheck && npm run lint && npm test` — all green.
- [ ] On a real phone: grant notification permission in the PWA, background the app, get a laptop session to go idle or hit `AskUserQuestion` — confirm a push notification arrives and tapping it opens the PWA to that session.
- [ ] Confirm a notification for a session that then gets opened/resolved is dismissed (or at minimum replaced, not left stale) per `NotifyPolicy`'s tag-per-session design.
- [ ] Restart the daemon — confirm the (documented, v1-acceptable-or-not per criterion 3) subscription persistence behavior matches what criterion 3 decided.
