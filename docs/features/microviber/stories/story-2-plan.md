# Story microviber-2 Implementation Plan — Daemon takeover/handback routes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Story: [story-2.md](story-2.md) · Issue: yarivsnapir/MicroViber#1 · Branch: `story/microviber-2` (microviber repo)

**Goal:** Finish the daemon's honest write API: explicit HTTP 403 on `/prompt` for a not-taken-over session, a `handback` route that releases ownership, removal of the dead `/owned` fresh-start surface, and docs that match.

**Architecture:** All changes live in the already-built layers: routes in `daemon/src/api/app.ts` (zod in/out, `errorEnvelope`, `HTTP_STATUS`, no business logic in handlers — AC 3), wiring in `daemon/src/services/services.ts`, ownership in `daemon/src/domain/ownership.ts` (`release()` exists, unused). TDD per task; gate = `npm run typecheck && npm run lint && npm test` from `microviber/`.

**Decision locked by the orchestrator (AC 5 option a):** `/prompt` on a session with no owned handle returns **HTTP 403 `FORBIDDEN`** (`errorEnvelope('FORBIDDEN', 'session is read-only until taken over')`), no `PromptRecord` created. The `readonlySender` fallback is removed from `sendPrompt`.

## Global Constraints

- Handlers stay logic-free: gating decisions surface as typed errors from `services.ts` / domain, mapped to HTTP codes in the route's existing catch pattern.
- No auth/middleware changes (spec §16.3) — routes sit behind the existing bearer/Host/Origin hooks.
- Nothing outside `daemon/src/lib/claude-adapter/` touches Claude internals (lint FENCE 2 enforces).
- Every task ends with the full gate green and one commit on `story/microviber-2`.

---

### Task 1: `/prompt` → 403 FORBIDDEN when not taken over

**Files:** Modify `daemon/src/services/services.ts` (sendPrompt: no-handle → throw `{code:'FORBIDDEN'}` typed error; delete `readonlySender`), `daemon/src/api/app.ts` (`/prompt` catch maps `FORBIDDEN` → `HTTP_STATUS.FORBIDDEN`). Test `daemon/test/app.test.ts`.

- [ ] Write failing test: POST `/api/sessions/:id/prompt` (valid bearer, Idempotency-Key, body) on a session with no owned handle → 403, body `{success:false, error:{code:'FORBIDDEN'}}`; and a companion test that an owned session still gets `{success:true}` (existing path unregressed).
- [ ] Run tests → new one fails (currently returns 200 + `state:'failed'`).
- [ ] Implement; check whether `prompt-lifecycle.submit()` persists a record before send — a 403-rejected prompt must not leave a `queued`/`failed` record behind (assert in the test via a second identical request returning 403 again, not an idempotent replay).
- [ ] Full gate → green. Commit `feat(daemon): /prompt returns 403 FORBIDDEN for not-taken-over sessions (microviber-2 AC5a)`.

### Task 2: `POST /api/sessions/:id/handback`

**Files:** Modify `daemon/src/api/app.ts` (new route), `daemon/src/services/services.ts` (AppDeps gains `handback(sessionId): Promise<{id:string; mode:'readonly'}>` wired to `OwnershipRegistry.release()`), possibly `daemon/src/domain/ownership.ts`. Test `daemon/test/app.test.ts` (+ `domain/ownership.test.ts` if release semantics change).

- [ ] Read `ownership.ts` + `session-manager.ts` handle shape first: `release()` currently only drops the map entry — handback MUST also dispose the owned child process (no orphan `claude --resume` process). If the handle exposes stop/kill/dispose, call it; if not, add it in the adapter and call through.
- [ ] Write failing tests: takeover → handback → 200 `{id, mode:'readonly'}`; subsequent `GET /api/sessions` shows the session not-writable; handback on a never-taken-over session → 200 idempotent no-op (same envelope); handback disposes the handle (spawner spy asserts child kill/dispose called).
- [ ] Implement; route follows the takeover route's exact shape (params, catch mapping incl. NOT_FOUND for unknown session id if takeover treats it so — mirror takeover's semantics).
- [ ] Full gate → green. Commit `feat(daemon): handback route releases ownership and disposes the owned process (microviber-2 AC4)`.

### Task 3: Remove the dead `/owned` surface

**Files:** Modify `daemon/src/api/app.ts` (remove route + `StartOwnedBody` import + `AppDeps.startOwned`), `daemon/src/schemas/api.ts` (remove `StartOwnedBody`), `daemon/src/services/services.ts` (remove `startOwned` wiring; keep `startOwnedSession` in the adapter ONLY if takeover's shared spawn core still uses it — check imports; delete if dead). Test `daemon/test/app.test.ts` (remove owned-route tests).

- [ ] Grep first: `grep -rn "startOwned\|StartOwnedBody\|sessions/owned" daemon/src daemon/test pwa/src` — enumerate all references; pwa/src/lib/api.ts's `startOwned` is story-3's scope, DO NOT touch pwa here.
- [ ] Remove daemon-side references; run gate; fix fallout (unused imports, types).
- [ ] Verify: `grep -rn "startOwned\|StartOwnedBody" daemon/src daemon/test` → empty (adapter-internal shared core may keep its own internals; only the route/schema/deps surface must be gone).
- [ ] Full gate → green. Commit `refactor(daemon): remove dead /api/sessions/owned surface (microviber-2 AC6)`.

### Task 4: Docs match the shipped API

**Files:** Modify `microviber/docs/architecture-spec.md` (API-surface section: takeover route is live — fix the "not yet wired" claim; add handback; document /prompt 403; remove /owned), `microviber/docs/functional-spec.md` (only if it names /owned or the 200+failed behavior — grep first).

- [ ] `grep -n "owned\|not yet wired\|state.*failed\|takeover" docs/*.md` — fix every stale statement to match Tasks 1–3.
- [ ] Verify: no doc claims /owned exists, no doc claims takeover unwired, /prompt 403 documented.
- [ ] Gate (docs don't affect it, still run) → green. Commit `docs: API surface matches takeover/handback/403 (microviber-2; also closes story-4's doc-accuracy AC)`.

### Task 5: Verification script (Step 10b artifact)

**Files:** Create `docs/features/microviber/stories/story-2-manual-test.sh` (Harness repo — NOT committed to microviber).

- [ ] Script (bash, curl-based, reads MV_PORT/token from the daemon's own config/token file, parameterized `BASE_URL`, `SESSION_ID`): health → list sessions (show writable flags) → takeover $SESSION_ID → 200; prompt → lands (poll transcript until the text appears); takeover again → idempotent same-id; prompt on a never-taken-over session id → 403; handback → 200; list shows read-only. ✅/❌ per check.
- [ ] Do not run it in this task — the orchestrator runs it at the manual-test step against a disposable session. Commit to the HARNESS repo with the story files.
