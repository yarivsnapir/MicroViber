---
id: microviber-track-c-13
title: Terminal REST routes — create, list, kill
status: todo
project: microviber
depends_on: [microviber-track-c-11, microviber-track-c-12]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/59
---

## User Story
As a **developer**, I want **bearer-authenticated routes to create, list and kill terminals**, so that **the phone can manage shells before the live stream exists to type into them**.

## Acceptance Criteria
1. `POST /api/terminals` with body `{ cwd }` creates a PTY and returns `{ id, cwd, createdAt }`.
2. **No client-supplied argv, anywhere.** The daemon always runs the user's login shell, built server-side from `config`. A body carrying argv is rejected by the schema, not ignored.
3. `POST` returns `403` when `cwd` is outside `listKnownFolders()` (story 12), checked **before** any spawn.
4. `POST` returns `403` when `MV_TERMINAL_MAX_SESSIONS` is already reached — rejected, never silently queued.
5. `GET /api/terminals` lists `{ id, cwd, alive, createdAt, claudeSessionId }[]`. `claudeSessionId` is always `null` in this story; story 19 resolves it.
6. `DELETE /api/terminals/:id` kills and deregisters, and is **idempotent** — `200` on an already-closed id, matching `handback`'s established shape.
7. Every route is bearer-authenticated on the control plane and uses the existing error envelope.
8. Every request body and response is zod-validated at the boundary, like every other input in this repo.
9. A test asserts the gate and the picker share one source: a `cwd` absent from `listKnownFolders()` is refused (AC3), and one present is accepted.
10. An audit-log entry is appended on terminal creation, carrying the `cwd`. Creating a shell is a write action reachable from the phone, and the existing audit sink is where write actions are recorded.
11. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/api/app.ts` — the three routes.
- `daemon/src/schemas/api.ts` — request/response schemas, including the no-argv rejection.
- `daemon/src/services/services.ts` — wiring the registry and the allowlist gate behind a service method.
- `daemon/src/services/audit-log.ts` — the create entry (AC10), if the existing sink needs a new event kind.
- `daemon/test/app.test.ts` — auth, envelope, the 403s, idempotent delete.
- `daemon/test/services.test.ts` — gate-before-spawn ordering.

## Technical Notes
**Why no argv even though it grants nothing.** A client that can type into a shell can already run anything, so accepting an argv would grant no new capability. It would, however, move "which binary runs" from a daemon decision to a client decision, which makes the audit trail weaker and the route harder to reason about (`spec.md` §2.3). Both create paths — this one and story 19's — build argv server-side.

**Gate ordering is load-bearing.** The allowlist check must run before `spawn`, not after, so a rejected `cwd` never reaches the OS. Assert the ordering in a test rather than trusting reading order; that is the shape T14's gate uses.

**Still no UI and no stream.** These routes are reachable but nothing in the PWA calls them, and there is no way to type into a created terminal until story 14. Safe to merge alone: purely additive surface.

**T18 applies from this story onward.** Once `POST /api/terminals` exists, arbitrary command execution on the laptop is reachable from the phone **without** the idle gate takeover imposes. `spec.md` §5.1's T18 row states the mitigation set (two-factor tunnel + bearer, daemon off by default, the starting-folder allowlist, the cap, the reaper) and its accepted residual honestly. Confirm that row is present in `docs/architecture-spec.md` — if Feature A's threat rows have not been merged into the architecture spec yet, this story adds T18 there, because the capability lands here.

## Manual Test Checklist
- [ ] `story-13-check.sh`: runs the gate, then exercises the full route surface with a real bearer (from the token file, never printed) — create in a valid folder, create in `/etc` (expect 403), create past the cap (expect 403), create with an argv in the body (expect a schema rejection), list, delete, delete again (expect 200), list again. PASS/FAIL per check, and it cleans up every terminal it made.
- [ ] No UI in this story, so nothing to look at in the app.
