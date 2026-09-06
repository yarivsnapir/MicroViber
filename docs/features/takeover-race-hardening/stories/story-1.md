---
id: takeover-race-hardening-1
title: "Daemon: per-session in-flight lock prevents concurrent takeover() from double-spawning"
status: in-progress
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/4
---

## User Story
As the daemon's own reliability guarantee (not directly user-facing, but protects every session a user takes over), I want two concurrent `POST /api/sessions/:id/takeover` calls for the same session to never both spawn a `claude --resume` child, so that a network retry, a double-tap, or two devices racing never orphans an un-killed child process the registry has already forgotten about.

## Acceptance Criteria
1. `domain/ownership.ts`'s `takeover()` is guarded by a per-session in-flight lock (e.g. `Map<sessionId, Promise<OwnedSessionHandle>>`): a second call for a session already mid-takeover awaits the SAME in-flight promise instead of independently re-running the `existing?.alive` check, `assertIdleForTakeover`, and `spawn()`.
2. A test firing two concurrent `takeover()` calls for the same session (both starting before either resolves) asserts the injected `spawn` callback was invoked exactly once, and both callers receive the same resolved `OwnedSessionHandle`.
3. The lock entry is removed once the in-flight call settles (success OR failure) — a failed spawn must not permanently wedge future takeover attempts on that session behind a rejected promise.
4. Two concurrent takeover calls for DIFFERENT sessions are unaffected — each session's lock is independent (a test asserts both spawn independently and don't block each other).
5. Existing sequential-idempotency behavior (`existing?.alive` short-circuit for an already-owned session, per `daemon/test/app.test.ts`'s current takeover-idempotency coverage) is unchanged.
6. `microviber/docs/architecture-spec.md` gets this documented — either as a new threat-model entry (network-reachable process-spawn race; none of T1–T16 currently cover a legitimate-but-racing caller producing an orphaned child) or a note under the existing takeover section of the engineering standards, whichever the implementer judges is the better fit — plus a dated closing note referencing this issue's origin ("Found during story/microviber-2 security review").

## Affected Files
- `daemon/src/domain/ownership.ts` — the fix.
- `daemon/test/ownership.test.ts` — concurrent-call coverage.
- `docs/architecture-spec.md` — new entry or note (criterion 6).

## Technical Notes
The race: `takeover()`'s `existing?.alive` check (`ownership.ts:72-73`) and the eventual `registry.acquire()` (`ownership.ts:76`) are separated by an `await args.spawn()` — a second call arriving in that window sees no registry entry yet, passes the idle-gate too, and independently spawns; whichever `acquire()` runs second silently overwrites the first handle in the `Map`, and the first process is never killed (its `onExit` is never wired to `reap`, since `acquire` only wires the *last* handle set).

Suggested fix (from the filing issue): a per-session in-flight `Map<sessionId, Promise<...>>` that a second concurrent caller awaits, OR acquire-a-placeholder-before-spawn with rollback on failure — pick whichever composes more cleanly with the existing `OwnershipRegistry` class; either satisfies the acceptance criteria above.

Found during story/microviber-2's security review (informational, pre-existing, not worsened by that diff) — filed as GitHub issue #4, never previously turned into a story.

## Manual Test Checklist
- [ ] `cd microviber && npm run typecheck && npm run lint && npm test` — all green, including the new concurrent-takeover test.
- [ ] Manually fire two near-simultaneous `curl -X POST .../takeover` requests against a real idle session (e.g. backgrounding both curls with `&`) — confirm only one `claude` process is spawned (`ps aux | grep claude`), and no orphaned child remains after both requests resolve.
