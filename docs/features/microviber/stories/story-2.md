---
id: microviber-2
title: Daemon — takeover/handback routes replace owned/attach stubs
status: done
project: microviber
depends_on: [microviber-1]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/1
---

## User Story
As the **MicroViber PWA (future consumer)**, I want the **daemon to expose `POST /api/sessions/:id/takeover` and `POST /api/sessions/:id/handback`**, with the prompt route refusing to send unless the session has actually been taken over, so that the phone has one honest write API instead of the built `owned` (fresh-start) endpoint and the attach path that never worked.

> **Reconciled 2026-08-26, then re-reconciled the same day** after a concurrent live bug-fix
> session absorbed and committed the working tree (`59c355c "feat: takeover write path +
> live-testing fixes"`, on top of the initial public release `69ab44f`). `microviber/main` is
> clean at that commit. About half of this story shipped there; the rest is still open,
> **unchanged from the first reconciliation pass** — committing the WIP didn't finish any of
> the items below.
>
> **Update:** `59c355c`'s message claimed "typecheck 0, lint 0, 161/161 tests green," which
> did not hold at that commit — `npm run typecheck --prefix daemon` failed with 3
> `exactOptionalPropertyTypes` errors in `daemon/test/node-spawner.test.ts`. That has since
> been fixed and pushed as `606273d "fix(test): node-spawner deferred literals conform to
> exactOptionalPropertyTypes"`, on top of `59c355c`. Re-verified: `npm run typecheck --prefix
> daemon` now exits 0 at `606273d`. The gate is genuinely green now (typecheck 0, lint 0,
> 161/161 tests). `docs/architecture-spec.md` separately still **understates** what shipped:
> it states `POST /api/sessions/:id/takeover` is "not yet wired to HTTP routes" and only
> `/owned` exists — false, the route is live in `app.ts` (see AC 1). Flagged as a doc-accuracy
> item for `microviber-4`.

## Acceptance Criteria — already shipped in the WIP (verify + keep on pickup)
1. `POST /api/sessions/:id/takeover` exists, is idle-gated via `microviber-1`'s `domain/ownership.ts` (`ForbiddenTakeoverError` when state ≠ `idle`), calls `startTakeoverSession`, and is idempotent (a second call on an already-owned session returns the existing handle without re-spawning — see `ownership.ts`'s `takeover()`). Covered by `daemon/test/app.test.ts` (`takeover returns...`, `takeover on a non-idle session surfaces FORBIDDEN...`) and `domain/ownership.test.ts`.
   - **Shape delta from the original AC** (adopt this, don't revert it): the route returns `{ id, mode: 'owned' }`, not a full `SessionSummary`. The PWA doesn't need more — it calls `refresh()` right after to reload the full list (see `pwa/src/App.tsx`'s `takeoverSession()`). Update the AC wording to this shape when this story is picked up; the original "returns the now-writable `SessionSummary`" phrasing is stale.
2. `GET /api/sessions` continues to return `lastPromptAt`-sorted sessions, each carrying `takenOver`/`writable`. (The WIP also adds a `lastPrompt` field for a subtitle preview — unplanned but harmless scope-add from the same branch; not part of this story's contract, no action needed.)
3. Contract discipline (zod in+out via existing `AppDeps`/`errorEnvelope`/`HTTP_STATUS`, no business logic in the handler) is maintained in the new route.

## Acceptance Criteria — still open
4. **`POST /api/sessions/:id/handback` does not exist yet.** Add it: release ownership via `domain/ownership.ts`'s `release()` (already built, unused by any route today), and the session must revert to read-only in the next `GET /api/sessions` response. No route-level test exists yet either.
5. **`POST /api/sessions/:id/prompt`'s FORBIDDEN gate is not wired at the HTTP level.** Today, sending to a session with no owned handle silently falls through to `readonlySender` in `services.ts`, which returns `{ ok: false, code: 'EXTERNAL_SERVICE_ERROR', retryable: false }` — `prompt-lifecycle.ts`'s `submit()` turns that into a `200` response with `PromptRecord.state: 'failed'`, not an HTTP-level `FORBIDDEN`. Per this story's original intent ("replacing the old attach path's silent failure with an explicit, typed rejection"), decide and implement one of: (a) have the route special-case a not-owned session before calling `sendPrompt` and return `403 FORBIDDEN` directly, or (b) accept the current `200`+`state:'failed'` behavior as sufficiently explicit and update the AC wording instead of the code. Either is defensible; pick one and make the AC match the code (don't leave the two disagreeing, as they do today).
6. **`POST /api/sessions/owned` (fresh-start) and its `StartOwnedBody` schema are still present** in `daemon/src/api/app.ts` / `daemon/src/schemas/api.ts` / `AppDeps.startOwned`. Remove them per the original AC — the PWA's fresh-start UI is already gone (`microviber-3`'s WIP removed `SessionPicker`'s "＋ start phone session" button), so this route is now genuinely dead on the server side too.

## Acceptance Criteria — done since the last pass
7. ~~Finish `daemon/test/node-spawner.test.ts`.~~ **Done, commit `606273d`.** `node-spawner.ts`'s `'error'`-event crash-prevention fix (an unhandled `error` event on a spawned `ChildProcess` used to kill the whole daemon process) and its test coverage are both in and typecheck-clean. `npm run typecheck --prefix daemon` exits 0.

## Affected Files
- `daemon/src/api/app.ts` — add `POST /api/sessions/:id/handback`; remove `POST /api/sessions/owned`; resolve the `/prompt` FORBIDDEN question (AC 5)
- `daemon/src/services/services.ts` — wire `handback` to `domain/ownership.ts`'s `release()`; remove `startOwned` wiring
- `daemon/src/schemas/api.ts` — remove `StartOwnedBody` once `/owned` is fully removed
- `daemon/test/app.test.ts` — add handback route test + the `/prompt` FORBIDDEN-when-not-owned test (whichever shape AC 5 lands on)

## Technical Notes
This is plan.md Task 12's delta (the route half of "Delta from built code" item 4) plus the `/prompt` FORBIDDEN behavior described in Task 12. It depends entirely on `microviber-1`'s domain/adapter layer (`startTakeoverSession`, `domain/ownership.ts`, the renamed `PromptSender.mode`) — `microviber-1` is `done`, and the WIP already builds on it correctly.

Security note (spec §16.3): auth/bearer checks on these routes are unchanged from the existing middleware (Task 11, built) — this story only adds the takeover/handback business logic behind that existing gate, it does not touch auth itself.

**Rollout assumption:** once this story ships, the daemon's HTTP surface no longer matches the currently-built PWA (which still calls `/owned` in `pwa/src/lib/api.ts`, even though nothing in the UI calls it anymore) — that mismatch is expected and is resolved by `microviber-3`. Single-developer local tool, no production users affected by the transient mismatch.

## Manual Test Checklist
- [x] `npm run typecheck --prefix daemon` → exit 0 (confirmed at HEAD `606273d`; failed at `59c355c`, fixed since — see AC 7)
- [ ] `npm test --prefix daemon` → all route tests pass (currently 142/142 green, part of the repo-wide 161/161)
- [ ] Verification script (backend-only, no UI yet): start the daemon locally against a real idle Claude Code session; `curl -X POST .../sessions/:id/takeover` with a valid bearer token → 200; `curl -X POST .../sessions/:id/prompt` → prompt lands in the transcript; call `takeover` again → same response, no duplicate process; `curl -X POST .../sessions/:id/handback` → 200, then `GET /api/sessions` shows the session read-only again; `curl` `/prompt` on a never-taken-over session → whichever explicit rejection AC 5 settles on.
