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
As the **MicroViber PWA**, I want the **daemon to expose `POST /api/sessions/:id/takeover` and `POST /api/sessions/:id/handback`**, with the prompt route refusing to send unless the session has actually been taken over, so that the phone has one honest write API instead of the built `owned` (fresh-start) endpoint and the attach path that never worked.

> **Shipped 2026-08-26** in commit `b907ce8` ("microviber-2: daemon takeover write API —
> handback, explicit 403, /owned removal", PR #5), on top of the takeover-route WIP from
> `59c355c`/`606273d`. Follow-up doc reconciliation landed in `41bd97d` (microviber-4). This
> supersedes the two mid-flight reconciliation notes that used to sit here — those tracked an
> interim state where AC4–6 were still open; they no longer are.

## Acceptance Criteria — all shipped
1. `POST /api/sessions/:id/takeover` exists, is idle-gated via `microviber-1`'s `domain/ownership.ts` (`ForbiddenTakeoverError` when state ≠ `idle`), calls `startTakeoverSession`, and is idempotent (a second call on an already-owned session returns the existing handle without re-spawning — see `ownership.ts`'s `takeover()`). Covered by `daemon/test/app.test.ts` (`takeover returns...`, `takeover on a non-idle session surfaces FORBIDDEN...`) and `domain/ownership.test.ts`.
   - **Shape delta from the original AC** (kept, not reverted): the route returns `{ id, mode: 'owned' }`, not a full `SessionSummary`. The PWA doesn't need more — it calls `refresh()` right after to reload the full list (see `pwa/src/App.tsx`'s `takeoverSession()`).
2. `GET /api/sessions` continues to return `lastPromptAt`-sorted sessions, each carrying `takenOver`/`writable` (plus a `lastPrompt` subtitle-preview field, a harmless scope-add from the same branch).
3. Contract discipline (zod in+out via existing `AppDeps`/`errorEnvelope`/`HTTP_STATUS`, no business logic in the handler) is maintained in the new routes.
4. **`POST /api/sessions/:id/handback` exists** (`daemon/src/api/app.ts:436`). It releases ownership via `domain/ownership.ts`'s `release()` and disposes the owned process; the session reverts to read-only in the next `GET /api/sessions` response. Route-level tests cover it in `daemon/test/app.test.ts`.
5. **`POST /api/sessions/:id/prompt` returns an explicit `403 FORBIDDEN`** when the session has no owned handle, decided as option (a) from the original open question — the route special-cases the not-owned case before calling `sendPrompt` rather than falling through to a `200` + `state: 'failed'` response. The rejected attempt is also audit-logged (review finding fixed in the same PR).
6. **`POST /api/sessions/owned` and `StartOwnedBody` are fully removed** from `daemon/src/api/app.ts`, `daemon/src/schemas/api.ts`, and `AppDeps` — verified absent in the current tree (grep finds zero references). The PWA's fresh-start UI was already gone (`microviber-3`), so this closed out the last dead surface on the server side too.
7. `daemon/test/node-spawner.test.ts` is typecheck-clean (`606273d`) — the `'error'`-event crash-prevention fix on a spawned `ChildProcess` and its test coverage are both in.
8. `docs/architecture-spec.md` and the functional spec were reconciled to the shipped takeover/handback/403 behavior in the same PR (and again in `microviber-4`, `41bd97d`).

## Affected Files
- `daemon/src/api/app.ts` — added `POST /api/sessions/:id/handback`; removed `POST /api/sessions/owned`; `/prompt` returns explicit 403 for not-owned sessions
- `daemon/src/services/services.ts` — `handback` wired to `domain/ownership.ts`'s `release()`; `startOwned` wiring removed
- `daemon/src/schemas/api.ts` — `StartOwnedBody` removed
- `daemon/test/app.test.ts` — handback route test + `/prompt` FORBIDDEN-when-not-owned test

## Technical Notes
This was plan.md Task 12's delta (the route half of "Delta from built code" item 4) plus the `/prompt` FORBIDDEN behavior described in Task 12. It depended on `microviber-1`'s domain/adapter layer (`startTakeoverSession`, `domain/ownership.ts`, the renamed `PromptSender.mode`).

Security note (spec §16.3): auth/bearer checks on these routes are unchanged from the existing middleware (Task 11) — this story only added takeover/handback business logic behind that existing gate, it did not touch auth itself.

## Manual Test Checklist
- [x] `npm run typecheck --prefix daemon` → exit 0
- [x] `npm test --prefix daemon` → all route tests pass (360/360 green as of 2026-09-05)
- [x] Verification script (`story-2-manual-test.sh`) — daemon started locally against a real idle Claude Code session; `takeover` → 200; `prompt` lands in the transcript; repeat `takeover` → same response, no duplicate process; `handback` → 200, then `GET /api/sessions` shows the session read-only again; `prompt` on a never-taken-over session → explicit 403 FORBIDDEN.
