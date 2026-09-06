# takeover-race-hardening-1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Story:** `docs/features/takeover-race-hardening/stories/story-1.md` (GitHub issue [#4](https://github.com/yarivsnapir/MicroViber/issues/4))

**Goal:** Two concurrent `takeover()` calls for the same session must never both spawn a `claude --resume` child — the second caller awaits the first caller's in-flight promise.

**Architecture:** `OwnershipRegistry` (`daemon/src/domain/ownership.ts`) gains a second map, `inFlight: Map<sessionId, Promise<OwnedSessionHandle>>`, exposed through one method, `coalesceTakeover(sessionId, run)`: if an entry exists it is returned as-is; otherwise `run()` is invoked once, its promise is stored, and a `.finally` drops the entry when it settles (success or failure). `takeover()` moves its whole body — the `existing?.alive` short-circuit, `assertIdleForTakeover`, `spawn()`, `acquire()` — inside that `run` callback, so a racing caller re-runs none of it. The lock lives on the registry (per-daemon instance, already injected into `takeover()`), not in module scope, so tests stay isolated and the daemon keeps exactly one place that knows which sessions are owned or becoming owned. Pure bookkeeping, no I/O — `domain/` stays free of spawning per the adapter quarantine (§16.1 / arch spec §6).

**Tech Stack:** Node 22, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest 4 (`daemon/test/**/*.test.ts`), eslint (typescript-eslint recommended; `no-explicit-any` is an error).

## Global Constraints

- Quality gate before every commit, run from `microviber/`: `npm run typecheck && npm run lint && npm test` — all three green (arch spec §6 "Testing gate"). Baseline on this branch: daemon 362 tests / pwa 139 tests, all passing.
- `domain/` does no I/O and never spawns; `spawn` stays an injected callback (arch spec §6 "Adapter quarantine", §3 layering fence `schemas/ → domain/ → services/ → api/`).
- No `any` without a `// reason:` comment; no unused vars (eslint).
- `services/services.ts:184-209` (the only production caller of `takeover()`) must need NO change — the signature `takeover(args: { sessionId; state; registry; spawn }) => Promise<OwnedSessionHandle>` is preserved.
- Existing sequential-idempotency behaviour (`existing?.alive` short-circuit; dead handle falls through to gate + spawn) is unchanged — every test already in `daemon/test/ownership.test.ts` keeps passing untouched.
- Commit subjects are prefixed `takeover-race-hardening-1:` (story-development Step 11b — a subject that doesn't carry the story id is a bundling smell).
- All paths in this plan are relative to `microviber/` (the MicroViber repo root). `cd microviber` first from the workspace root.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `daemon/src/domain/ownership.ts` | Ownership bookkeeping + takeover orchestration | Add `inFlight` map + `coalesceTakeover()` to `OwnershipRegistry` (Task 1); route `takeover()` through it (Task 2) |
| `daemon/test/ownership.test.ts` | Unit tests for the above | Add a `deferred<T>()` helper, a `describe` for the lock primitive (Task 1), a `describe` for concurrent `takeover()` calls (Task 2) |
| `docs/architecture-spec.md` | Threat model + component map | New row **T17** in the §5 table; one sentence on the §3 `ownership.ts` bullet (Task 3) |

No new files. `services/services.ts` and `api/app.ts` untouched.

---

### Task 1: `OwnershipRegistry.coalesceTakeover()` — the per-session in-flight lock

**Files:**
- Modify: `daemon/src/domain/ownership.ts:11-39` (the `OwnershipRegistry` class)
- Test: `daemon/test/ownership.test.ts` (add helper after `fakeHandle`, add a new `describe` after the `OwnershipRegistry` describe block that ends at line 50)

**Interfaces:**
- Consumes: `OwnedSessionHandle` from `../lib/claude-adapter/session-manager.js` (already imported).
- Produces: `OwnershipRegistry.coalesceTakeover(sessionId: string, run: () => Promise<OwnedSessionHandle>): Promise<OwnedSessionHandle>` — Task 2 calls exactly this.

- [ ] **Step 1: Add the `deferred<T>()` test helper**

In `daemon/test/ownership.test.ts`, directly after the `fakeHandle` function (after line 16), add:

```ts
/** A promise whose settlement the test controls — lets two takeover() calls start before either can finish. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

- [ ] **Step 2: Write the failing tests for the lock primitive**

Append to `daemon/test/ownership.test.ts`, after the `describe('OwnershipRegistry', …)` block (i.e. after line 50, before `describe('assertIdleForTakeover', …)`):

```ts
describe('OwnershipRegistry.coalesceTakeover — per-session in-flight lock (issue #4)', () => {
  it('concurrent callers for the same session share ONE run: run invoked once, both get the same result', async () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    const d = deferred<OwnedSessionHandle>();
    const run = vi.fn(() => d.promise);
    const p1 = reg.coalesceTakeover('s1', run);
    const p2 = reg.coalesceTakeover('s1', run);
    expect(run).toHaveBeenCalledOnce();
    d.resolve(h);
    await expect(Promise.all([p1, p2])).resolves.toEqual([h, h]);
  });

  it('drops the in-flight entry once the run resolves — a later call runs again', async () => {
    const reg = new OwnershipRegistry();
    const run = vi.fn(async () => fakeHandle('s1'));
    await reg.coalesceTakeover('s1', run);
    await reg.coalesceTakeover('s1', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops the in-flight entry once the run REJECTS — a failed spawn does not wedge later attempts', async () => {
    const reg = new OwnershipRegistry();
    const d = deferred<OwnedSessionHandle>();
    const failing = vi.fn(() => d.promise);
    const p1 = reg.coalesceTakeover('s1', failing);
    const p2 = reg.coalesceTakeover('s1', failing);
    d.reject(new Error('spawn failed'));
    const settled = await Promise.allSettled([p1, p2]);
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(failing).toHaveBeenCalledOnce();

    const h = fakeHandle('s1');
    const ok = vi.fn(async () => h);
    await expect(reg.coalesceTakeover('s1', ok)).resolves.toBe(h);
    expect(ok).toHaveBeenCalledOnce();
  });

  it('locks are per session: concurrent runs for DIFFERENT sessions both run and settle independently', async () => {
    const reg = new OwnershipRegistry();
    const d1 = deferred<OwnedSessionHandle>();
    const d2 = deferred<OwnedSessionHandle>();
    const run1 = vi.fn(() => d1.promise);
    const run2 = vi.fn(() => d2.promise);
    const p1 = reg.coalesceTakeover('s1', run1);
    const p2 = reg.coalesceTakeover('s2', run2);
    expect(run1).toHaveBeenCalledOnce();
    expect(run2).toHaveBeenCalledOnce();

    const h2 = fakeHandle('s2');
    d2.resolve(h2);
    await expect(p2).resolves.toBe(h2); // s2 settles while s1 is still pending

    const h1 = fakeHandle('s1');
    d1.resolve(h1);
    await expect(p1).resolves.toBe(h1);
  });
});
```

Why `Promise.allSettled` in the rejection test: it attaches a handler to BOTH rejected promises synchronously, so neither can be reported as an unhandled rejection between assertions.

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `microviber/`): `cd daemon && npx vitest run test/ownership.test.ts`

Expected: the 4 new tests FAIL with `TypeError: reg.coalesceTakeover is not a function`; the pre-existing 13 tests in the file still pass.

- [ ] **Step 4: Implement `coalesceTakeover` on `OwnershipRegistry`**

In `daemon/src/domain/ownership.ts`, change the class to:

```ts
export class OwnershipRegistry {
  private owned = new Map<string, OwnedSessionHandle>();
  /** Takeovers currently between their idle-gate and `acquire`, keyed by sessionId — see `coalesceTakeover`. */
  private inFlight = new Map<string, Promise<OwnedSessionHandle>>();

  isOwned(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  get(sessionId: string): OwnedSessionHandle | undefined {
    return this.owned.get(sessionId);
  }

  acquire(sessionId: string, handle: OwnedSessionHandle): void {
    this.owned.set(sessionId, handle);
    handle.onExit(() => this.reap(sessionId));
  }

  /** Deliberate hand-back: kill the child and forget it. */
  release(sessionId: string): void {
    const handle = this.owned.get(sessionId);
    if (!handle) return;
    handle.kill();
    this.owned.delete(sessionId);
  }

  /** The child exited on its own (crash, laptop `/resume` stealing it, etc.) — forget it without killing. */
  reap(sessionId: string): void {
    this.owned.delete(sessionId);
  }

  /**
   * Per-session in-flight lock for takeover (issue #4, arch spec T17). While
   * one takeover of `sessionId` is mid-flight — gate passed, `spawn()` not yet
   * resolved, nothing acquired yet — every concurrent caller for the SAME
   * session gets that same promise instead of invoking `run` again. Without
   * it, two racing callers (a network retry, a double-tap, two paired devices)
   * both see no registry entry, both pass the idle gate, and both spawn;
   * `acquire` keeps only the last handle and the first child is orphaned —
   * never killed, never reaped (its `onExit` was never wired). The entry is
   * dropped when the run settles, success OR failure, so a failed spawn can't
   * wedge later attempts behind a rejected promise. The map is keyed per
   * session, so takeovers of different sessions never wait on each other.
   *
   * `run` is expected to be an async function (a synchronous throw would
   * propagate to the caller without storing anything — no lock leak either way).
   */
  coalesceTakeover(sessionId: string, run: () => Promise<OwnedSessionHandle>): Promise<OwnedSessionHandle> {
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const attempt = run().finally(() => { this.inFlight.delete(sessionId); });
    this.inFlight.set(sessionId, attempt);
    return attempt;
  }
}
```

Ordering note (why `.finally` is enough): `run()`'s promise settles → the `.finally` callback runs and deletes the entry → only then does `attempt` settle and wake the awaiting callers. So by the time any caller continues, the lock is already gone; a caller that immediately retries gets a fresh run.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd daemon && npx vitest run test/ownership.test.ts`

Expected: 17 tests pass (13 pre-existing + 4 new).

- [ ] **Step 6: Run the full quality gate**

Run (from `microviber/`): `npm run typecheck && npm run lint && npm test`

Expected: exit 0; daemon 366 tests, pwa 139 tests.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/domain/ownership.ts daemon/test/ownership.test.ts
git commit -m "takeover-race-hardening-1: OwnershipRegistry.coalesceTakeover per-session in-flight lock"
```

---

### Task 2: Route `takeover()` through the lock — concurrent calls spawn once

**Files:**
- Modify: `daemon/src/domain/ownership.ts:59-78` (the `takeover` function and its doc comment)
- Test: `daemon/test/ownership.test.ts` (new `describe` appended at the end of the file, after the existing `describe('takeover orchestration', …)` block)

**Interfaces:**
- Consumes: `OwnershipRegistry.coalesceTakeover(sessionId: string, run: () => Promise<OwnedSessionHandle>): Promise<OwnedSessionHandle>` from Task 1; `deferred<T>()` test helper from Task 1 Step 1.
- Produces: unchanged public signature — `takeover(args: { sessionId: string; state: SessionState; registry: OwnershipRegistry; spawn: () => Promise<OwnedSessionHandle> }): Promise<OwnedSessionHandle>`. `services/services.ts:197` keeps calling it exactly as today.

- [ ] **Step 1: Write the failing tests for concurrent `takeover()` calls**

Append to the end of `daemon/test/ownership.test.ts`:

```ts
describe('takeover orchestration — concurrent calls for one session (issue #4)', () => {
  it('two concurrent takeover() calls for the same session spawn exactly once and resolve to the same handle', async () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    const d = deferred<OwnedSessionHandle>();
    const spawn = vi.fn(() => d.promise);
    const p1 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    const p2 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn }); // starts before p1 can resolve
    d.resolve(h);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(r1).toBe(h);
    expect(r2).toBe(h);
    expect(reg.get('s1')).toBe(h);
  });

  it('the second concurrent caller awaits the in-flight promise instead of re-running the idle gate', async () => {
    // The racing caller's own state snapshot would FAIL the gate; it must still
    // receive the in-flight result — the gate ran once, for the call that spawns.
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    const d = deferred<OwnedSessionHandle>();
    const spawn = vi.fn(() => d.promise);
    const p1 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    const p2 = takeover({ sessionId: 's1', state: 'working', registry: reg, spawn });
    d.resolve(h);
    await expect(p2).resolves.toBe(h);
    await expect(p1).resolves.toBe(h);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('a failed in-flight spawn rejects every concurrent caller (one spawn), then the NEXT takeover attempt is unblocked', async () => {
    const reg = new OwnershipRegistry();
    const d = deferred<OwnedSessionHandle>();
    const spawn = vi.fn(() => d.promise);
    const p1 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    const p2 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    d.reject(new Error('session did not report a session_id in time'));
    const settled = await Promise.allSettled([p1, p2]);
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(spawn).toHaveBeenCalledOnce();
    expect(reg.isOwned('s1')).toBe(false);

    const h = fakeHandle('s1');
    const retry = vi.fn(async () => h);
    await expect(takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn: retry })).resolves.toBe(h);
    expect(retry).toHaveBeenCalledOnce();
    expect(reg.isOwned('s1')).toBe(true);
  });

  it('after a successful concurrent takeover the lock is released: when that child later dies, a fresh takeover spawns again', async () => {
    const reg = new OwnershipRegistry();
    const first = fakeHandle('s1');
    const d = deferred<OwnedSessionHandle>();
    const spawn = vi.fn(() => d.promise);
    const p1 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    const p2 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    d.resolve(first);
    await Promise.all([p1, p2]);
    expect(spawn).toHaveBeenCalledOnce();

    first._exit(); // child crashed → reaped
    expect(reg.isOwned('s1')).toBe(false);

    const second = fakeHandle('s1');
    const respawn = vi.fn(async () => second);
    await expect(takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn: respawn })).resolves.toBe(second);
    expect(respawn).toHaveBeenCalledOnce();
    expect(reg.get('s1')).toBe(second);
  });

  it('concurrent takeovers for DIFFERENT sessions each spawn and do not block each other', async () => {
    const reg = new OwnershipRegistry();
    const d1 = deferred<OwnedSessionHandle>();
    const d2 = deferred<OwnedSessionHandle>();
    const spawn1 = vi.fn(() => d1.promise);
    const spawn2 = vi.fn(() => d2.promise);
    const p1 = takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn: spawn1 });
    const p2 = takeover({ sessionId: 's2', state: 'idle', registry: reg, spawn: spawn2 });
    expect(spawn1).toHaveBeenCalledOnce();
    expect(spawn2).toHaveBeenCalledOnce();

    const h2 = fakeHandle('s2');
    d2.resolve(h2);
    await expect(p2).resolves.toBe(h2); // s2 finishes while s1 is still mid-spawn
    expect(reg.isOwned('s2')).toBe(true);
    expect(reg.isOwned('s1')).toBe(false);

    const h1 = fakeHandle('s1');
    d1.resolve(h1);
    await expect(p1).resolves.toBe(h1);
    expect(reg.isOwned('s1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd daemon && npx vitest run test/ownership.test.ts`

Expected, on the pre-Task-2 `takeover()`:
- test 1 FAILS — `spawn` called 2 times (both callers spawned).
- test 2 FAILS — `p2` rejects with `ForbiddenTakeoverError` (the second caller re-ran the gate).
- test 3 FAILS — `spawn` called 2 times.
- test 4 FAILS — `spawn` called 2 times in the concurrent phase.
- test 5 PASSES already — it is the "don't over-lock" guard; it must still pass after Step 3.
All 17 tests from Task 1 keep passing.

- [ ] **Step 3: Move `takeover()`'s body inside the lock**

Replace `daemon/src/domain/ownership.ts:59-78` (doc comment + function) with:

```ts
/**
 * Orchestrates one takeover: idempotent if already owned (returns the
 * existing handle without re-checking state or re-spawning — spec §3.2 does
 * not require staying idle once taken over); otherwise idle-gates BEFORE any
 * spawn, then spawns via the injected `spawn` callback (adapter I/O stays
 * outside domain/, §16.1) and acquires into the registry.
 *
 * The whole sequence runs under the registry's per-session in-flight lock
 * (`coalesceTakeover`, issue #4): a second call for a session already
 * mid-takeover awaits the SAME promise — it re-runs neither the
 * `existing?.alive` check, nor the idle gate, nor `spawn()` — so two racing
 * callers can never double-spawn and orphan the first child.
 */
export function takeover(args: {
  sessionId: string;
  state: SessionState;
  registry: OwnershipRegistry;
  spawn: () => Promise<OwnedSessionHandle>;
}): Promise<OwnedSessionHandle> {
  return args.registry.coalesceTakeover(args.sessionId, async () => {
    const existing = args.registry.get(args.sessionId);
    if (existing?.alive) return existing;
    assertIdleForTakeover(args.state);
    const handle = await args.spawn();
    args.registry.acquire(args.sessionId, handle);
    return handle;
  });
}
```

Notes for the implementer:
- `takeover` is no longer declared `async` — it returns the lock's promise directly. The inner arrow IS `async`, so `assertIdleForTakeover`'s throw becomes a rejection of the shared promise (the existing "refuses BEFORE any spawn" test asserts `.rejects.toThrow(ForbiddenTakeoverError)` — still satisfied). `services/services.ts:197` `await`s the result, so the change is invisible to it.
- Do NOT move the `existing?.alive` check outside the lock: AC1 lists it among the things a racing caller must not independently re-run, and keeping one path is simpler.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd daemon && npx vitest run test/ownership.test.ts`

Expected: 22 tests pass (13 pre-existing + 4 from Task 1 + 5 from this task). Also confirm the untouched `daemon/test/app.test.ts` takeover tests still pass: `cd daemon && npx vitest run test/app.test.ts`.

- [ ] **Step 5: Run the full quality gate**

Run (from `microviber/`): `npm run typecheck && npm run lint && npm test`

Expected: exit 0; daemon 371 tests, pwa 139 tests.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/domain/ownership.ts daemon/test/ownership.test.ts
git commit -m "takeover-race-hardening-1: takeover() runs under the per-session lock — concurrent calls spawn once"
```

---

### Task 3: Architecture spec — threat-model entry T17 + component-map note

**Files:**
- Modify: `docs/architecture-spec.md` — §5 threat-model table (append a row after the **T16** row, which is the last row of the table, ending just before the `---` that precedes `## 6. Engineering standards`); §3 `domain/` sub-module list, the `ownership.ts` bullet (currently reads "`ownership.ts` — `OwnershipRegistry`: bookkeeping for which session ids are currently owned by a daemon-spawned process. … Also defines `assertIdleForTakeover` / `ForbiddenTakeoverError`, the hard "idle-only" gate.").

**Interfaces:**
- Consumes: the method name `coalesceTakeover` (Task 1) and the test file path `daemon/test/ownership.test.ts` (Tasks 1–2) — the prose below must reference exactly those.
- Produces: nothing code-facing.

Judgement call recorded (story criterion 6 leaves it to the implementer): this goes in as a **new threat-model row T17**, not only a note under the takeover section. Rationale: §5's framing is "reachability requires two factors, and every mitigation ensures a network-reachable write is deliberate" — an orphaned `claude --resume` child that still holds a live stdin into the session, which the daemon has forgotten and can neither kill nor reap, is a network-reachable path to an unmanaged process, and none of T1–T16 name it. The §3 bullet gets one sentence so a reader of the component map finds the lock where the code is.

- [ ] **Step 1: Append the T17 row to the §5 table**

Insert immediately after the **T16** row (the line starting `| **T16** |`), as a new table row on a single line:

```markdown
| **T17** | Two takeover requests for the same session race — a network retry, a double-tap, or two paired devices both `POST /api/sessions/:id/takeover` before either finishes. Each sees no registry entry yet (the first `spawn()` is still awaiting), each passes the idle gate, each spawns its own `claude --resume` child; `acquire` keeps only the last handle, so the first child is orphaned — never killed, never reaped (its `onExit` was never wired), still holding a live stdin into the session. Both callers hold the bearer, so this is not an attacker's move — but it is a network-reachable path to a process the daemon has forgotten it owns, which none of T1–T16 cover. | `OwnershipRegistry.coalesceTakeover` (`domain/ownership.ts`): a per-session in-flight `Map<sessionId, Promise<OwnedSessionHandle>>`. `takeover()`'s whole sequence — the `existing?.alive` short-circuit, the idle gate, `spawn()`, `acquire()` — runs inside it, so a second caller for a session already mid-takeover awaits the SAME promise and re-runs none of it. The entry is dropped when the call settles (success or failure), so a failed spawn can't wedge later attempts behind a rejected promise; the lock is keyed per session, so takeovers of different sessions never wait on each other. Sequential idempotency (an alive owned handle is returned without re-spawning) is unchanged. Covered by `daemon/test/ownership.test.ts`: two concurrent same-session calls → one spawn, both get the same handle; a racing caller whose own state snapshot would fail the gate still gets the in-flight handle; a rejected spawn rejects both callers once and unblocks the next attempt; different sessions spawn independently. (takeover-race-hardening-1, 2026-09-06 — found during story/microviber-2's security review as informational/pre-existing, filed as GitHub issue #4) |
```

- [ ] **Step 2: Extend the §3 `ownership.ts` bullet**

Change the `ownership.ts` bullet under "**`domain/` sub-modules, as committed:**" to:

```markdown
- `ownership.ts` — `OwnershipRegistry`: bookkeeping for which session ids are currently
  owned by a daemon-spawned process. In-memory only — a daemon restart reverts every
  session to read-only, and it can be taken over again. Also defines
  `assertIdleForTakeover` / `ForbiddenTakeoverError`, the hard "idle-only" gate, and
  `coalesceTakeover`, the per-session in-flight lock that `takeover()` runs under so two
  racing takeover calls for one session can never double-spawn (T17,
  takeover-race-hardening-1).
```

- [ ] **Step 3: Verify the edits**

Run (from `microviber/`):

```bash
grep -c '^| \*\*T17\*\* |' docs/architecture-spec.md        # expect 1
grep -n 'coalesceTakeover' docs/architecture-spec.md          # expect 2 hits: §3 bullet + T17 row
awk -F'|' '/^\| \*\*T17\*\* \|/ { print NF }' docs/architecture-spec.md   # expect 5 (same column count as the other rows: leading empty, #, Threat, Mitigation, trailing empty)
```

- [ ] **Step 4: Run the full quality gate (docs-only change, but it is the pre-commit rule)**

Run: `npm run typecheck && npm run lint && npm test` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture-spec.md
git commit -m "takeover-race-hardening-1: arch spec T17 — concurrent takeover double-spawn race and its lock"
```

---

### Task 4 (added 2026-09-06 after the final whole-branch review): identity-aware `reap` — a superseded child's late exit never drops the survivor

The lock from Tasks 1–2 closes the *concurrent-spawn* path to "two children for one
session". The final whole-branch review found a second path to the same end state,
pre-existing on `main` and outside the original criteria, absorbed here by user decision
(same file, same invariant, and it is what makes the T17 mitigation true end-to-end):
`acquire` wires `handle.onExit(() => this.reap(sessionId))` and `reap` deletes by key with
no identity check, so **handback (`release()` kills + deletes synchronously) followed by a
re-takeover that `acquire`s a fresh handle before the old process has actually exited**
ends with the old child's late `onExit` deleting the *survivor's* entry — a live orphan,
the session silently read-only again, and a later handback a no-op because `release` no
longer holds the handle to kill.

**Files:**
- Modify: `daemon/src/domain/ownership.ts` — `acquire` (bind the handle into `onExit`) and `reap` (identity guard + doc comment); the `coalesceTakeover` JSDoc's in-flight-span clause (Minor 1 from the same review).
- Modify: `docs/architecture-spec.md` — T17 threat cell (the adapter's resolve timing, Minor 2), T17 mitigation cell (the identity-aware-`reap` complement), §3 `ownership.ts` bullet.
- Test: `daemon/test/ownership.test.ts` — a new `describe('OwnershipRegistry.reap — identity-aware (story AC7, from the final whole-branch review)', …)` appended at the end of the file.

**Interfaces:**
- Produces: `OwnershipRegistry.reap(sessionId: string, handle?: OwnedSessionHandle): void` — the second parameter is OPTIONAL, so the old one-argument call shape stays valid and no caller outside `ownership.ts` needs a change. `acquire`, `release`, `get`, `isOwned`, `coalesceTakeover` and `takeover()` keep their signatures; `release` is unchanged outright.
- Consumes: nothing new — `OwnedSessionHandle` is already imported, and the identity check is a reference comparison against `this.owned.get(sessionId)`.

- [x] **Step 1: Write the failing tests for identity-aware reap**

Append to the end of `daemon/test/ownership.test.ts` a `describe('OwnershipRegistry.reap — identity-aware (story AC7, from the final whole-branch review)', …)` with three tests:

1. `'a late exit from a handed-back child does not reap the handle that took over afterwards'` — registry-level: `acquire(h1)` → `release` (handback: `kill()` sent, entry dropped, but `h1`'s exit event has NOT fired) → `acquire(h2)` (the re-takeover lands inside `h1`'s SIGTERM→exit window) → `h1._exit()`; asserts `isOwned('s1') === true` and `get('s1') === h2`.
2. `'the CURRENT handle exiting still reaps — the identity check does not break the normal path'` — same setup, then `h1._exit()` AND `h2._exit()`; asserts `isOwned('s1') === false`. This is the "don't over-guard" test: it must pass before AND after the fix.
3. `'through takeover(): takeover → handback → re-takeover, then the first child exits late — the session stays owned by the second handle'` — the same sequence driven through the public `takeover()` (plus `expect(first.kill).toHaveBeenCalledOnce()` on the handback); asserts the session is still owned by `second` after `first._exit()`.

- [x] **Step 2: Run the tests to verify they fail**

Run (from `microviber/`): `cd daemon && npx vitest run test/ownership.test.ts`

Expected on the pre-Task-4 `reap`: tests 1 and 3 FAIL with `AssertionError: expected false to be true` (the late exit reaped the survivor); test 2 PASSES already by design (it is the guard). All 24 earlier tests in the file keep passing — i.e. **2 failed / 24 passed**.

- [x] **Step 3: Make `reap` identity-aware**

In `daemon/src/domain/ownership.ts`, bind the handle into the exit hook:

```ts
  acquire(sessionId: string, handle: OwnedSessionHandle): void {
    this.owned.set(sessionId, handle);
    handle.onExit(() => this.reap(sessionId, handle));
  }
```

and guard the delete:

```ts
  /**
   * The child exited on its own (crash, laptop `/resume` stealing it, etc.) — forget it without killing.
   *
   * Identity-aware (story AC7, arch spec T17): when `handle` is given and the
   * registry's CURRENT entry for `sessionId` is a different handle, this is a
   * late exit from a superseded child — handback (`release`) killed it, then a
   * re-takeover acquired a fresh handle before the old process actually died —
   * and it must NOT drop the survivor, or a live owned session would silently
   * flip back to read-only and the orphan would be unreachable to `release`.
   * Without a handle the delete is unconditional (no such caller exists today;
   * `acquire` always binds one).
   */
  reap(sessionId: string, handle?: OwnedSessionHandle): void {
    if (handle && this.owned.get(sessionId) !== handle) return;
    this.owned.delete(sessionId);
  }
```

`release` stays exactly as it is (it kills whatever handle the registry currently holds, which is now always the right one). `grep -rn "reap(" daemon/src --include='*.ts'` finds only these two sites — the `onExit` wiring in `acquire` and the definition itself — so the optional parameter changes nothing else.

- [x] **Step 4: Tighten the `coalesceTakeover` JSDoc's in-flight span (review Minor 1)**

The comment described the locked window as "mid-flight — gate passed, `spawn()` not yet resolved, nothing acquired yet", which under-states it: `takeover()` moved its *whole* body inside the lock in Task 2, so the window opens on entry, before the gate. Replace that clause with "in flight — from the moment `takeover()` enters until its run settles" and re-wrap. No code change.

- [x] **Step 5: Architecture spec — T17 complement + the adapter's resolve timing (review Minor 2)**

Three edits to `docs/architecture-spec.md`, keeping the T17 row one line with 5 `|`-columns:
- Threat cell, after "…which none of T1–T16 cover.": note that the adapter resolves the takeover spawn synchronously (`startTakeoverSession` always passes `_resolveImmediately`), so the pre-fix check→acquire window was microtasks wide and a second HTTP request could not land inside it — the lock makes the guarantee independent of the adapter's resolve timing rather than an accident of it.
- Mitigation cell, immediately before the dated closing note: the "Complement (same story, from the final whole-branch review)" sentence describing the handback→re-takeover→late-exit path and the identity-aware `reap` that closes it, pointing at the "identity-aware" tests.
- §3 `ownership.ts` bullet: "… can never double-spawn, **and an identity-aware `reap` so a superseded child's late exit never drops the survivor's entry** (T17, takeover-race-hardening-1)."

- [x] **Step 6: Verify**

```bash
cd daemon && npx vitest run test/ownership.test.ts       # expect 26 passed (24 + 2 newly fixed)
cd daemon && npx vitest run test/app.test.ts             # unchanged, green
grep -c '^| \*\*T17\*\* |' docs/architecture-spec.md      # expect 1
awk -F'|' '/^\| \*\*T1[67]\*\* \|/ { print NF }' docs/architecture-spec.md   # expect 5 and 5
grep -o 'coalesceTakeover' docs/architecture-spec.md | wc -l                # expect 2
```

- [x] **Step 7: Run the full quality gate**

Run (from `microviber/`): `npm run typecheck && npm run lint && npm test` — expected exit 0; daemon 375 tests (372 + 3), pwa 139 tests.

- [x] **Step 8: Commit**

```bash
git add daemon/src/domain/ownership.ts daemon/test/ownership.test.ts docs/architecture-spec.md \
        docs/features/takeover-race-hardening/stories/story-1.md \
        docs/features/takeover-race-hardening/stories/story-1-plan.md
git commit -m "takeover-race-hardening-1: identity-aware reap (AC7) — a superseded child's late exit no longer drops the survivor; T17 complement + JSDoc span"
```

---

## Acceptance-criteria coverage

| Story AC | Where |
|---|---|
| 1 — per-session in-flight lock; second call awaits the same promise, re-runs nothing | Task 1 Step 4 (`coalesceTakeover`), Task 2 Step 3 (`takeover` body inside the lock), Task 2 test 2 (gate not re-run) |
| 2 — two concurrent calls ⇒ `spawn` once, same handle to both | Task 2 test 1 |
| 3 — lock cleared on success AND failure; failed spawn doesn't wedge | Task 1 tests 2–3 (primitive), Task 2 tests 3–4 (through `takeover`) |
| 4 — different sessions independent | Task 1 test 4, Task 2 test 5 |
| 5 — sequential idempotency unchanged | existing `describe('takeover orchestration')` tests, untouched, still green after Task 2 |
| 6 — architecture-spec entry + dated closing note referencing issue #4 / microviber-2 review | Task 3 |
| 7 — identity-aware reap; handback→re-takeover→late exit keeps the survivor | Task 4 (tests: "identity-aware" describe in ownership.test.ts) |

## Out of scope (do not touch)

- `services/services.ts` — no change needed; the lock is below it.
- The stale "threat model T1–T12" wording in the §5 heading and in `CLAUDE.md` (the table already runs to T16) — pre-existing, not this story's.
- The story's second manual-test item (two near-simultaneous real `curl` takeovers against a live daemon) is a human-only check of the running system, handled at the story-development Step 11 checkpoint, not by this plan.
- The final whole-branch review's three remaining notes were left as documented notes, not fixed, and are out of scope for this story: (a) no liveness bound on `coalesceTakeover`'s `run()` — a `spawn()` that never settles pins the lock for that session forever (the adapter resolves immediately today, so there is no such path in production); (b) the restart residual — a daemon restart clears the in-memory registry but a `--dangerously-skip-permissions` child that outlived it is still running, unowned and unkillable by the new process; (c) `release()` during an in-flight takeover — a handback that lands between the gate and `acquire()` is overwritten by the takeover it raced, since `release` does not consult `inFlight`. Each would need its own story.
