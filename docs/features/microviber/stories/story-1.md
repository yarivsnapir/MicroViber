---
id: microviber-1
title: Daemon — replace attach/owned write path with takeover-via-resume
status: done
project: microviber
depends_on: []
complexity: M
github_issue:
---

## User Story
As the **MicroViber daemon**, I want the **single write path to be a deliberate, idle-gated takeover that resumes a live session via `claude --resume <id>`** (instead of the abandoned peer-socket "attach" path and the ambiguous "owned/fresh-start" path), so that a phone-sent prompt always lands as a genuine user turn in the *same* transcript file the laptop session already owns.

## Acceptance Criteria

> **Scope note (absorbed 2026-08-24):** ACs 9-11 below (pairing URL over HTTPS reverse proxy) were added mid-implementation at the user's explicit request, after ACs 1-8 had already shipped and passed final review. The user was offered the choice of a new story vs. a separate branch vs. absorbing into this one, and explicitly chose to absorb it here rather than carve it out — this is unrelated in subject matter to the takeover-via-resume write path (ACs 1-8), but is small, self-contained (`pairing.ts`/`index.ts`/`config.ts` only), and does not touch any file ACs 1-8 touched.

1. `session-manager.ts` exposes `startTakeoverSession({ sessionId, cwd, spawner, claudeBin })`, sharing the spawn/stdin/init-parse core already built for `startOwnedSession` (Task 7, built). It spawns `claude --resume <sessionId> --input-format stream-json --output-format stream-json --dangerously-skip-permissions` and returns a handle whose `sessionId` equals the **resumed** id (not a freshly minted one) — verified against findings F13/F14.
2. The returned handle satisfies the existing `PromptSender` interface: `send()` writes a plain `{"type":"user"}` frame to stdin (F11, no `<cross-session-message>` wrapper); process exit/crash surfaces as a typed `EXTERNAL_SERVICE_ERROR` with `retryable: true`.
3. Takeover of a non-`idle` session is refused **before any process is spawned** — enforced at the orchestration boundary in `domain/ownership.ts`, independent of the route-level `FORBIDDEN` (that check is story `microviber-2`'s concern; this story's unit tests cover the domain-level gate only).
4. New `domain/ownership.ts` tracks the owned map keyed by resumed `sessionId`: `acquire()`, `release()` (kills the child, removes the entry), and `reap()` (a child that exits on its own is removed from the map so the session reverts to read-only without an explicit handback call).
5. `PromptSender.mode` is renamed from `'attach' | 'owned'` to `'readonly' | 'owned'` across the daemon; the attach/peer-socket doc comment and the not-implemented attach sender in `services.ts` are deleted (there is nothing else to remove — `peer-client.ts` was never built).
6. `registry.ts` derives a session's writable mode from owned-map membership rather than a stored `mode` field, and exposes `takenOver: boolean` per session.
7. `tail.ts` drops the wrapper-detection `injected` branch (`unwrapPeerMessage`/`CROSS_SESSION_RE`) from `normalizeLine`'s `'user'` case — no write path will ever again produce a `<cross-session-message>` wrapper (attach mode is deleted), so a `'user'` transcript entry is normalized with `injected: false` unconditionally at the tail layer. (Wiring `PromptLifecycle`'s existing session+text correlation into the live per-event `injected` flag sent to clients is a separate, not-yet-built pipeline — out of scope for this story; `prompt-lifecycle.ts` itself needs no change, since it is already mode-agnostic.)
8. All of the above ship with tests written first (TDD) per §16.7; a test exists for the "child dies with daemon, reverts to read-only, can be taken over again" safe default recorded in the plan for checkpoint 13.7.
9. `buildPairingUrl` (`pairing.ts`) omits the port when it equals the scheme's default (443 for `https`, 80 for `http`) — e.g. `https://my-laptop.tailXXXX.ts.net/#token=…` with no `:443` — and keeps the port for any non-default value (existing behavior for port 8730 is unchanged).
10. A new pure function (`selectPairingTarget` or equivalent) selects the printed pairing URL's target: when `config.allowedHosts[0]` is set, target `{ host: allowedHosts[0], port: 443, scheme: 'https' }` (the public HTTPS origin behind `tailscale serve`); otherwise fall back to today's `{ host: bindAddress, port, scheme: 'http' }`. Testable in isolation, without booting Fastify. `index.ts`'s startup print uses this function instead of hardcoding `'http'`.
11. The bearer token is never logged as a separate field — it only ever appears inside the printed pairing URL's `#token=` fragment (§16.4, unchanged from existing behavior — this AC exists to make sure the new code path doesn't regress it).

## Affected Files
- `daemon/src/lib/claude-adapter/session-manager.ts` — add `startTakeoverSession`, sharing spawn/stdin/init-parse with `startOwnedSession`
- `daemon/src/domain/ownership.ts` — new file: owned-map acquire/release/reap + idle-gate check
- `daemon/src/lib/claude-adapter/prompt-sender.ts` — `mode: 'attach' | 'owned'` → `'readonly' | 'owned'`; delete attach doc comment
- `daemon/src/services/services.ts` — delete the not-implemented `attachNotImplemented` sender stub; wire `owned` map lookups through the new `domain/ownership.ts` instead of the local `Map`
- `daemon/src/domain/registry.ts` — `SessionMode` `'attach' | 'owned'` → `'readonly' | 'owned'`; derive `writable`/`takenOver` from owned-map membership instead of a caller-supplied `mode`
- `daemon/src/lib/claude-adapter/tail.ts` — remove `unwrapPeerMessage`/`CROSS_SESSION_RE` wrapper-detection from `normalizeLine`'s `'user'` case; `injected` becomes unconditionally `false` at this layer
- `daemon/src/services/audit-log.ts` — `AuditEntry.mode: 'attach' | 'owned'` → `'readonly' | 'owned'`
- `daemon/test/**` (flat `test/` dir, not mirrored under `src/` — see `test/session-manager.test.ts`, `test/registry.test.ts`, `test/tail.test.ts`, `test/prompt-lifecycle.test.ts` for existing conventions) — new/updated unit tests for the above (TDD, written first)

**Deferred to `microviber-2` (recorded here since that story doesn't exist as a file yet — carry these into its Acceptance Criteria when it's carved):**
- **sessionId input validation before the takeover route goes live.** `domain/ownership.ts`'s `takeover()` and `session-manager.ts`'s `startTakeoverSession()` currently accept any `sessionId` string with no shape validation. Not exploitable in *this* story (array-based `child_process.spawn`, no shell; and no HTTP route reaches `sessionId` yet — `services.ts` still uses its own local `Map`, unwired to `domain/ownership.ts`). Once `microviber-2` wires `POST /api/sessions/:id/takeover`, validate `:id` against the expected session-id shape (zod, per §16.2) before it reaches `startTakeoverSession`.
- **Typed-error mapping at the HTTP boundary.** `startTakeoverSession`'s failure paths (`throw new Error(...)`) are plain `Error` objects, consistent with this file's pre-existing convention (the timeout-rejection path already did this before this story). When `microviber-2` wires a route around `takeover()`, map these to the daemon's canonical error-envelope codes (matching the existing pattern in `api/app.ts`'s other routes) rather than letting a raw `Error` reach the HTTP layer.

**AC 9-11 (absorbed pairing-URL work) affected files:**
- `daemon/src/server/pairing.ts` — `buildPairingUrl` gains default-port omission; new `selectPairingTarget` pure function
- `daemon/src/index.ts` — startup print uses `selectPairingTarget(config)` instead of hardcoding `'http'`
- `daemon/test/pairing.test.ts` — new tests for port omission and target selection

## Technical Notes
This is plan.md Task 6 (the write path — to build) plus the daemon-side portions of the "Delta from built code" list (items 1, 2, 3, 5, 6). Tasks 1–5, 7–22, 25 are already built and committed to `main` in `microviber/` under the superseded v2 (attach + owned) model; **do not re-implement them**, only convert the pieces named above.

Route-level wiring (`POST /api/sessions/:id/takeover` / `/handback`, and `FORBIDDEN` on `/prompt` when not owned) is deliberately **out of scope for this story** — it is story `microviber-2`'s Affected Files. This story ships the domain/adapter layer those routes will call.

Quarantine discipline (spec §16.1 / plan rule 2): all Claude-internals code stays inside `lib/claude-adapter/`; `domain/ownership.ts` holds only lifecycle logic (acquire/release/reap), no spawn calls of its own — it calls into the adapter.

**Rollout assumption:** none — this story only changes internal daemon modules (session-manager, ownership, prompt-sender, registry, prompt-lifecycle). It does not yet change the HTTP route surface, so the currently-built PWA keeps working against whatever routes exist until `microviber-2` and `microviber-3` land. This is a single-developer local tool (spec non-goal: "Not multi-user or multi-machine"), so there is no production-user exposure to protect against mid-sequence.

## Manual Test Checklist
- [x] `npm run typecheck --prefix daemon` → exit 0 (114/114 tests, includes AC 9-11's pairing-URL work)
- [x] `npm test --prefix daemon` → all new + existing daemon tests pass
- [x] `npm run lint --prefix .` (from `microviber/`) → clean
- [x] `npm run typecheck --prefix pwa` → exit 0; `npm test --prefix pwa` → 14/14 (AC 11's absorbed literal fix)
- [ ] Manual takeover smoke test (verification script, since this story has no UI yet): start a real idle Claude Code session, call `startTakeoverSession` against it directly (small script under `daemon/`), confirm a plain-turn prompt lands in the **same** transcript file (F13), then call `release()` and confirm the child process is torn down and the map no longer reports it as owned. **Deferred by user request (2026-08-24):** the user is installing Tailscale first and will run this against a real system afterward; code review/PR proceed without it having been run yet — recorded here, not fabricated as passed.
