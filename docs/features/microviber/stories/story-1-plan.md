# MicroViber Takeover-via-Resume (Daemon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's `attach`/`owned` write-path types and dead attach stub with a single takeover-via-resume write path (story `microviber-1`), without touching HTTP routes or the PWA.

**Architecture:** `session-manager.ts` gains `startTakeoverSession`, sharing a new `spawnHandle` core with the existing `startOwnedSession` (only argv differs: `--resume <id>` vs `-n <name>`). A new `domain/ownership.ts` holds the owned-map lifecycle (`acquire`/`release`/`reap`) and the idle-gate + orchestration (`takeover()`) as pure, dependency-injected logic — no I/O, per §16.1. `registry.ts`, `prompt-sender.ts`, `audit-log.ts` drop the `'attach'` mode value in favor of `'readonly' | 'owned'`; `registry.ts` derives `mode`/`takenOver` from owned-map membership instead of a caller-supplied string. `tail.ts` stops treating `<cross-session-message>` wrapper text specially, since no write path will ever produce one again. `services.ts` swaps its dead `attachNotImplemented` stub for a `readonlySender` and updates its `buildSummary` call site — this is the minimum needed to keep the daemon compiling and its existing behavior graceful; the real `/takeover`/`/handback` HTTP wiring is story `microviber-2`.

**Tech Stack:** Node 22, TypeScript strict, vitest, npm workspaces (`daemon/`).

## Global Constraints

- TDD required: write the failing test first, confirm it fails, then implement (§16.7).
- `domain/` files do no I/O (no spawning, no filesystem) — orchestration that needs both domain rules and adapter I/O takes the I/O as an injected callback (see `takeover()` below). This matches the existing precedent of `prompt-lifecycle.ts` importing only the `PromptSender` *type* from the adapter.
- Claude-internals stay quarantined in `lib/claude-adapter/` (§16.1); nothing outside it references spawn flags or transcript wrapper formats.
- No HTTP route changes, no `app.ts`/`AppDeps` signature changes, no PWA changes — those belong to stories `microviber-2` and `microviber-3`.
- Tests live flat under `daemon/test/` (not mirrored under `src/`) — follow the existing file-per-module convention (`test/session-manager.test.ts`, `test/registry.test.ts`, etc.).
- Every renamed `'attach'` literal must be hunted down across both `src/` and `test/` — TypeScript strict mode will fail to compile any leftover literal against the narrowed `'readonly' | 'owned'` union, which is the mechanism that guarantees this task list is exhaustive.

---

### Task 1: `session-manager.ts` — extract a shared spawn core, add `startTakeoverSession`

**Files:**
- Modify: `daemon/src/lib/claude-adapter/session-manager.ts` (full file, ~112 lines today)
- Test: `daemon/test/session-manager.test.ts` (append; existing 3 tests must keep passing unmodified)

**Interfaces:**
- Produces: `startTakeoverSession(opts: StartTakeoverOpts): Promise<OwnedSessionHandle>` where `StartTakeoverOpts = { spawner: Spawner; claudeBin: string; cwd: string; sessionId: string; _resolveImmediately?: string; initTimeoutMs?: number }`.
- Produces: `OwnedSessionHandle` gains `onExit(cb: () => void): void` (used by Task 2's `OwnershipRegistry` to reap on unexpected exit).
- Consumes: nothing new from other tasks; `PromptSender`/`userFrame` from `./prompt-sender.js` (unchanged import).

- [ ] **Step 1: Write the failing tests for `startTakeoverSession`**

Append to `daemon/test/session-manager.test.ts` (keep the existing `fakeChild` helper and its imports; add `startTakeoverSession` to the import line):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { startOwnedSession, startTakeoverSession, userFrame, type Spawner, type SpawnedChild } from '../src/lib/claude-adapter/session-manager.js';

// ...(existing fakeChild + userFrame + startOwnedSession describe blocks unchanged)...

describe('startTakeoverSession', () => {
  it('spawns claude --resume <sessionId> with the same stream-json flags', async () => {
    const child = fakeChild();
    const spawner: Spawner = vi.fn(() => child);
    const p = startTakeoverSession({ spawner, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    child._stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-42' }) + '\n');
    const h = await p;
    expect(h.sessionId).toBe('sess-42');
    expect(h.mode).toBe('owned');
    const argv = (spawner as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string[];
    expect(argv).toContain('--resume');
    expect(argv).toContain('sess-42');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('stream-json');
    expect(argv).not.toContain('-n');
  });

  it('rejects if the resumed process reports a different sessionId than requested (F13/F14 guard)', async () => {
    const child = fakeChild();
    const p = startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    child._stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-DIFFERENT' }) + '\n');
    await expect(p).rejects.toThrow(/different session/);
  });

  it('send() writes a plain user frame (no wrapper), same transport as owned mode', async () => {
    const child = fakeChild();
    const h = await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42', _resolveImmediately: 'sess-42' });
    const r = await h.send('answer the question');
    expect(r.ok).toBe(true);
    expect(child.writes.join('')).toContain('"text":"answer the question"');
    expect(child.writes.join('')).not.toContain('cross-session-message');
  });

  it('process exit/crash surfaces a retryable EXTERNAL_SERVICE_ERROR', async () => {
    const child = fakeChild();
    const h = await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42', _resolveImmediately: 'sess-42' });
    child._exit(1);
    const r = await h.send('too late');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('EXTERNAL_SERVICE_ERROR'); expect(r.retryable).toBe(true); }
  });
});

describe('OwnedSessionHandle.onExit', () => {
  it('fires registered listeners when the child exits, and alive flips false', async () => {
    const child = fakeChild();
    const h = await startOwnedSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', name: 'p', _resolveImmediately: 'owned-1' });
    let fired = false;
    h.onExit(() => { fired = true; });
    child._exit(0);
    expect(fired).toBe(true);
    expect(h.alive).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- session-manager`
Expected: FAIL — `startTakeoverSession` is not exported, and `onExit` does not exist on `OwnedSessionHandle`.

- [ ] **Step 3: Implement — extract shared core, add `startTakeoverSession` and `onExit`**

Replace the full contents of `daemon/src/lib/claude-adapter/session-manager.ts` with:

```typescript
import { type PromptSender, type SendOutcome, userFrame } from './prompt-sender.js';
export { userFrame } from './prompt-sender.js';

/** Injected process abstraction so the manager is unit-testable without spawning claude. */
export interface SpawnedChild {
  readonly pid: number;
  stdinWrite(data: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export type Spawner = (argv: string[], cwd: string) => SpawnedChild;

export interface OwnedSessionHandle extends PromptSender {
  readonly mode: 'owned';
  readonly pid: number;
  readonly sessionId: string;
  readonly alive: boolean;
  kill(): void;
  /** Registers a listener for process exit — used by domain/ownership.ts to reap unexpectedly-dead handles. */
  onExit(cb: () => void): void;
}

interface SpawnCoreOpts {
  spawner: Spawner;
  cwd: string;
  argv: string[];
  /** Test hook: resolve the sessionId synchronously instead of waiting on stdout. */
  _resolveImmediately?: string;
  /** ms to wait for the session_id to appear on stdout before failing. */
  initTimeoutMs?: number;
}

/**
 * Shared spawn + own-stdin + init-parse core for both owned-mode (fresh
 * session, Task 7) and takeover (resume, Task 6) handles — only argv differs
 * between the two callers below. Both write GENUINE user turns over the
 * documented SDK stream-json stdin transport (findings F11).
 */
function spawnHandle(opts: SpawnCoreOpts): Promise<OwnedSessionHandle> {
  const child = opts.spawner(opts.argv, opts.cwd);

  let alive = true;
  const exitListeners: Array<() => void> = [];
  child.onExit(() => {
    alive = false;
    for (const cb of exitListeners) cb();
  });

  const makeHandle = (sessionId: string): OwnedSessionHandle => ({
    mode: 'owned',
    pid: child.pid,
    sessionId,
    get alive() { return alive; },
    kill: () => child.kill(),
    onExit: (cb) => { exitListeners.push(cb); },
    async send(prompt: string, signal?: AbortSignal): Promise<SendOutcome> {
      if (!alive) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'session has exited', retryable: true };
      }
      if (signal?.aborted) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'aborted', retryable: true };
      }
      try {
        child.stdinWrite(userFrame(prompt) + '\n');
        return { ok: true };
      } catch (err) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: String(err), retryable: true };
      }
    },
  });

  if (opts._resolveImmediately) {
    return Promise.resolve(makeHandle(opts._resolveImmediately));
  }

  return new Promise<OwnedSessionHandle>((resolve, reject) => {
    const timeoutMs = opts.initTimeoutMs ?? 15000;
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('session did not report a session_id in time'));
    }, timeoutMs);

    child.onStdout((chunk) => {
      if (settled) return;
      buf += chunk;
      const nl = buf.lastIndexOf('\n');
      if (nl === -1) return;
      for (const line of buf.slice(0, nl).split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { session_id?: string };
          if (typeof o.session_id === 'string' && o.session_id) {
            settled = true;
            clearTimeout(timer);
            resolve(makeHandle(o.session_id));
            return;
          }
        } catch { /* partial/other line */ }
      }
      buf = buf.slice(nl + 1);
    });
  });
}

export interface StartOwnedOpts {
  spawner: Spawner;
  claudeBin: string;
  cwd: string;
  name: string;
  _resolveImmediately?: string;
  initTimeoutMs?: number;
}

/**
 * Owned mode: MicroViber launches a FRESH session over the documented SDK
 * stream-json transport and owns its stdin (findings F11). Phase-2 only
 * (fresh-session creation from the phone) — the MVP write path is takeover,
 * below.
 */
export function startOwnedSession(opts: StartOwnedOpts): Promise<OwnedSessionHandle> {
  const argv = [
    opts.claudeBin,
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '-n', opts.name,
  ];
  return spawnHandle({ spawner: opts.spawner, cwd: opts.cwd, argv, _resolveImmediately: opts._resolveImmediately, initTimeoutMs: opts.initTimeoutMs });
}

export interface StartTakeoverOpts {
  spawner: Spawner;
  claudeBin: string;
  cwd: string;
  sessionId: string;
  _resolveImmediately?: string;
  initTimeoutMs?: number;
}

/**
 * Takeover: resumes a live IDLE session's history into a daemon-owned
 * process via `claude --resume <sessionId>`. `--resume` continues the SAME
 * transcript file (findings F13) and works against a still-alive idle
 * session (F14) — MicroViber takes a turn writing to shared history, it
 * never forks it. The idle gate itself lives in domain/ownership.ts
 * (§16.1 — this adapter function has no opinion on session state).
 */
export async function startTakeoverSession(opts: StartTakeoverOpts): Promise<OwnedSessionHandle> {
  const argv = [
    opts.claudeBin,
    '--resume', opts.sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];
  const handle = await spawnHandle({
    spawner: opts.spawner, cwd: opts.cwd, argv,
    _resolveImmediately: opts._resolveImmediately, initTimeoutMs: opts.initTimeoutMs,
  });
  if (handle.sessionId !== opts.sessionId) {
    handle.kill();
    throw new Error(`takeover resumed a different session than requested (expected ${opts.sessionId}, got ${handle.sessionId})`);
  }
  return handle;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix daemon -- session-manager`
Expected: PASS (all original + new tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/lib/claude-adapter/session-manager.ts daemon/test/session-manager.test.ts
git commit -m "feat(daemon): add startTakeoverSession sharing session-manager's spawn core"
```

---

### Task 2: `domain/ownership.ts` — owned-map lifecycle (`acquire`/`release`/`reap`)

**Files:**
- Create: `daemon/src/domain/ownership.ts`
- Test: `daemon/test/ownership.test.ts` (new file)

**Interfaces:**
- Consumes: `OwnedSessionHandle` type from Task 1 (`../lib/claude-adapter/session-manager.js`) — specifically its `onExit`/`kill` members.
- Produces: `class OwnershipRegistry` with `isOwned(sessionId): boolean`, `get(sessionId): OwnedSessionHandle | undefined`, `acquire(sessionId, handle): void`, `release(sessionId): void`, `reap(sessionId): void`. Task 3 builds `takeover()` on top of this.

- [ ] **Step 1: Write the failing tests**

Create `daemon/test/ownership.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OwnershipRegistry } from '../src/domain/ownership.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';

function fakeHandle(sessionId: string): OwnedSessionHandle & { _exit: () => void } {
  let exitCb: () => void = () => {};
  return {
    mode: 'owned', pid: 1, sessionId, alive: true,
    kill: vi.fn(),
    onExit: (cb) => { exitCb = cb; },
    send: async () => ({ ok: true }),
    _exit: () => exitCb(),
  };
}

describe('OwnershipRegistry', () => {
  it('acquire marks a session owned; release kills the child and forgets it', () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    reg.acquire('s1', h);
    expect(reg.isOwned('s1')).toBe(true);
    expect(reg.get('s1')).toBe(h);
    reg.release('s1');
    expect(reg.isOwned('s1')).toBe(false);
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it('a child that exits on its own is reaped WITHOUT a kill call (already dead)', () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    reg.acquire('s1', h);
    h._exit();
    expect(reg.isOwned('s1')).toBe(false);
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('release on a session that was never owned is a no-op', () => {
    const reg = new OwnershipRegistry();
    expect(() => reg.release('nope')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- ownership`
Expected: FAIL — `src/domain/ownership.ts` does not exist.

- [ ] **Step 3: Implement**

Create `daemon/src/domain/ownership.ts`:

```typescript
import type { OwnedSessionHandle } from '../lib/claude-adapter/session-manager.js';

/**
 * Owned-map lifecycle (spec checkpoint 13.7): a session is writable only
 * while it holds an entry here, keyed by its resumed/owned sessionId. Pure
 * bookkeeping — no I/O, no spawning (that stays in the adapter, §16.1). The
 * safe default for a daemon restart: entries are in-memory only, so a
 * restart reverts every session to read-only; it can be taken over again.
 */
export class OwnershipRegistry {
  private owned = new Map<string, OwnedSessionHandle>();

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
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix daemon -- ownership`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/domain/ownership.ts daemon/test/ownership.test.ts
git commit -m "feat(daemon): add OwnershipRegistry — owned-map acquire/release/reap"
```

---

### Task 3: `domain/ownership.ts` — idle gate + `takeover()` orchestration

**Files:**
- Modify: `daemon/src/domain/ownership.ts` (append)
- Test: `daemon/test/ownership.test.ts` (append)

**Interfaces:**
- Consumes: `OwnershipRegistry` (Task 2, same file), `SessionState` type from `./session-state.js` (existing: `'working' | 'idle' | 'stale'`), `OwnedSessionHandle` type (Task 1).
- Produces: `class ForbiddenTakeoverError extends Error`, `assertIdleForTakeover(state: SessionState): void`, `takeover(args): Promise<OwnedSessionHandle>` — the function story `microviber-2`'s route handler will call, passing a real `spawn` callback that wraps `startTakeoverSession`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/ownership.test.ts` (add `ForbiddenTakeoverError`, `assertIdleForTakeover`, `takeover` to the import):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OwnershipRegistry, ForbiddenTakeoverError, assertIdleForTakeover, takeover } from '../src/domain/ownership.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';

// ...(fakeHandle + existing OwnershipRegistry describe block unchanged)...

describe('assertIdleForTakeover', () => {
  it('does not throw when idle', () => {
    expect(() => assertIdleForTakeover('idle')).not.toThrow();
  });
  it('throws ForbiddenTakeoverError when working or stale', () => {
    expect(() => assertIdleForTakeover('working')).toThrow(ForbiddenTakeoverError);
    expect(() => assertIdleForTakeover('stale')).toThrow(ForbiddenTakeoverError);
  });
});

describe('takeover orchestration', () => {
  it('refuses BEFORE any spawn when the session is not idle', async () => {
    const reg = new OwnershipRegistry();
    const spawn = vi.fn();
    await expect(takeover({ sessionId: 's1', state: 'working', registry: reg, spawn }))
      .rejects.toThrow(ForbiddenTakeoverError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns and acquires when idle', async () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    const spawn = vi.fn(async () => h);
    const result = await takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    expect(result).toBe(h);
    expect(reg.isOwned('s1')).toBe(true);
  });

  it('is idempotent: a second call on an already-owned session returns the same handle without spawning again', async () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1');
    const spawn = vi.fn(async () => h);
    await takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    const second = await takeover({ sessionId: 's1', state: 'working', registry: reg, spawn }); // state no longer matters once owned
    expect(second).toBe(h);
    expect(spawn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- ownership`
Expected: FAIL — `ForbiddenTakeoverError`, `assertIdleForTakeover`, `takeover` are not exported.

- [ ] **Step 3: Implement**

Append to `daemon/src/domain/ownership.ts`:

```typescript
import type { SessionState } from './session-state.js';

export class ForbiddenTakeoverError extends Error {
  constructor(state: SessionState) {
    super(`cannot take over a session in state '${state}' — takeover is only allowed while idle`);
    this.name = 'ForbiddenTakeoverError';
  }
}

export function assertIdleForTakeover(state: SessionState): void {
  if (state !== 'idle') throw new ForbiddenTakeoverError(state);
}

/**
 * Orchestrates one takeover: idempotent if already owned (returns the
 * existing handle without re-checking state or re-spawning — spec §3.2 does
 * not require staying idle once taken over); otherwise idle-gates BEFORE any
 * spawn, then spawns via the injected `spawn` callback (adapter I/O stays
 * outside domain/, §16.1) and acquires into the registry.
 */
export async function takeover(args: {
  sessionId: string;
  state: SessionState;
  registry: OwnershipRegistry;
  spawn: () => Promise<OwnedSessionHandle>;
}): Promise<OwnedSessionHandle> {
  const existing = args.registry.get(args.sessionId);
  if (existing) return existing;
  assertIdleForTakeover(args.state);
  const handle = await args.spawn();
  args.registry.acquire(args.sessionId, handle);
  return handle;
}
```

(`OwnershipRegistry` and its existing members from Task 2 are unchanged — this step only appends the new exports below them in the same file.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix daemon -- ownership`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/domain/ownership.ts daemon/test/ownership.test.ts
git commit -m "feat(daemon): idle-gate + takeover() orchestration in domain/ownership"
```

---

### Task 4: `prompt-sender.ts` + `registry.ts` — rename `'attach'` → `'readonly'`, derive from owned-map

**Files:**
- Modify: `daemon/src/lib/claude-adapter/prompt-sender.ts`
- Modify: `daemon/src/domain/registry.ts`
- Modify: `daemon/test/registry.test.ts`
- Modify: `daemon/test/app.test.ts` (mechanical fixture fix only — two `mode: 'attach'` literals fail to typecheck once `SessionMode` narrows; no route behavior changes)

**Interfaces:**
- Produces: `PromptSender.mode: 'readonly' | 'owned'` (was `'attach' | 'owned'`).
- Produces: `registry.buildSummary(d, ctx)` where `ctx: { isOwned: boolean; notifyIdleAt; alive; nowMs }` (was `{ mode: SessionMode; ... }`); `SessionSummary` gains `takenOver: boolean`.
- Consumes: nothing new — this is the rename story `microviber-1`'s Affected Files calls out explicitly.

- [ ] **Step 1: Write the failing tests**

Replace `daemon/test/registry.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/domain/registry.js';

const base = {
  id: 's1', title: 'T', folder: 'Harness-2', cwd: '/x/Harness-2', host: 'vscode' as const,
  peerProtocol: 1, socketPath: '/tmp/cc-socks/1.sock',
  lastPromptAt: '2026-08-23T11:00:00Z', lastActivityAt: '2026-08-23T11:59:50Z',
};
const now = Date.parse('2026-08-23T12:00:00.000Z');

describe('buildSummary', () => {
  it('mode is readonly and takenOver is false when the session is not in the owned map', () => {
    const s = buildSummary(base, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s).toMatchObject({ id: 's1', writable: true, state: 'working', mode: 'readonly', takenOver: false });
    expect(s).not.toHaveProperty('socketPath');
    expect(s).not.toHaveProperty('peerProtocol');
  });
  it('mode is owned and takenOver is true when the session is in the owned map', () => {
    const s = buildSummary(base, { isOwned: true, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s.mode).toBe('owned');
    expect(s.takenOver).toBe(true);
  });
  it('unsupported protocol => writable:false, state still derived (not stale)', () => {
    const s = buildSummary({ ...base, peerProtocol: 2 }, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s.writable).toBe(false);
    expect(s.state).toBe('working'); // NOT stale — it still mirrors
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- registry`
Expected: FAIL — `buildSummary`'s ctx type doesn't have `isOwned`; `mode`/`takenOver` assertions mismatch the current `'attach'`-based output.

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/prompt-sender.ts`, replace the doc comment and `mode` type:

```typescript
/**
 * The one interface the write path implements. The API layer holds a
 * PromptSender per session and never knows the daemon internals behind it.
 * Read (registry/tail) is always on and shared; write exists only for a
 * taken-over session ('owned') — everything else is 'readonly' and refuses
 * to send until a deliberate takeover (spec §3.2 hard rule).
 */
export type SendOutcome =
  | { ok: true }
  | { ok: false; code: 'EXTERNAL_SERVICE_ERROR'; message: string; retryable: boolean };

export interface PromptSender {
  readonly mode: 'readonly' | 'owned';
  send(prompt: string, signal?: AbortSignal): Promise<SendOutcome>;
}

/** A plain stream-json user turn — the documented transport, no wrapper (findings F11). */
export function userFrame(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}
```

Replace the full contents of `daemon/src/domain/registry.ts`:

```typescript
import { gateWritability } from '../lib/claude-adapter/version-gate.js';
import { deriveState, type SessionState } from './session-state.js';
import type { Host } from '../lib/claude-adapter/classify.js';

export type SessionMode = 'readonly' | 'owned';

/** What the API and PWA see. Never includes socketPath, peerProtocol, or any token. */
export interface SessionSummary {
  id: string;
  title: string;
  folder: string;
  cwd: string;
  host: Host;
  writable: boolean;
  state: SessionState;
  lastActivityAt: string | null;
  lastPromptAt: string | null;
  mode: SessionMode;
  /** True while this session holds an entry in the owned map (domain/ownership.ts). */
  takenOver: boolean;
}

/** The adapter facts the registry needs (a DiscoveredSession, structurally). */
export interface DiscoveredLike {
  id: string;
  title: string;
  folder: string;
  cwd: string;
  host: Host;
  peerProtocol: number;
  socketPath: string;
  lastPromptAt: string | null;
  lastActivityAt: string | null;
}

export function buildSummary(
  d: DiscoveredLike,
  ctx: { isOwned: boolean; notifyIdleAt: string | null; alive: boolean; nowMs: number },
): SessionSummary {
  return {
    id: d.id,
    title: d.title,
    folder: d.folder,
    cwd: d.cwd,
    host: d.host,
    writable: gateWritability(d.peerProtocol).writable,
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      nowMs: ctx.nowMs,
    }),
    lastActivityAt: d.lastActivityAt,
    lastPromptAt: d.lastPromptAt,
    mode: ctx.isOwned ? 'owned' : 'readonly',
    takenOver: ctx.isOwned,
  };
}

/** Sort key: most-recently-prompted first (spec §3). */
export function bySortOrder(a: SessionSummary, b: SessionSummary): number {
  return (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '');
}
```

In `daemon/test/app.test.ts`, fix the two now-non-compiling fixture literals (lines 16-17 today) — change both `mode: 'attach'` to `mode: 'readonly'` and add `takenOver: false` to each (the `SessionSummary` fixture objects `listSessions` returns):

```typescript
    listSessions: () => [
      { id: 'b', title: 'B', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPromptAt: '2026-08-23T10:00:00Z', mode: 'readonly', takenOver: false },
      { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPromptAt: '2026-08-23T11:00:00Z', mode: 'readonly', takenOver: false },
    ],
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck --prefix daemon && npm test --prefix daemon`
Expected: typecheck exit 0; all tests (including `app.test.ts` and `registry.test.ts`) PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/lib/claude-adapter/prompt-sender.ts daemon/src/domain/registry.ts daemon/test/registry.test.ts daemon/test/app.test.ts
git commit -m "refactor(daemon): rename PromptSender/SessionMode 'attach' -> 'readonly'; derive from owned-map"
```

---

### Task 5: `tail.ts` — drop wrapper-detection `injected` branch

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Modify: `daemon/test/tail.test.ts`

**Interfaces:**
- Produces: `normalizeLine`'s `'user'` case now always returns `injected: false`; `unwrapPeerMessage` and `CROSS_SESSION_RE` are deleted (dead code — no write path produces the wrapper anymore, attach mode is gone).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

In `daemon/test/tail.test.ts`, replace the existing "unwraps a cross-session-message..." test with:

```typescript
  it('does NOT unwrap a cross-session-message wrapper anymore — attach mode is gone, so it is just literal text', () => {
    const wrapped = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/29905.sock" from-name="harness-2-f9" from-mode="bypass">\ncommit it and open the PR\n</cross-session-message>\n\nThis came from another Claude session.';
    const e = normalizeLine(userLine(wrapped)) as Extract<TranscriptEvent, { kind: 'user' }>;
    expect(e.kind).toBe('user');
    expect(e.text).toBe(wrapped);
    expect(e.injected).toBe(false);
  });
```

(Leave the other four existing tests in the file untouched — plain user turn, assistant text, tool_use collapse, unrenderable lines.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- tail`
Expected: FAIL — the current code still unwraps the wrapper and sets `injected: true`.

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/tail.ts`, delete the `CROSS_SESSION_RE` constant and the `unwrapPeerMessage` function entirely, and change the `'user'` branch in `normalizeLine`:

```typescript
  if (e.type === 'user') {
    return { kind: 'user', at, text: blocks.text ?? '', injected: false };
  }
```

(The rest of the file — `normalizeContent`, `summarizeToolInput`, `parseChunk`, the `TranscriptEvent` union with its `injected: boolean` field — is unchanged; `injected` stays in the type for whatever future daemon-side-correlation wiring eventually sets it per-event, which is out of this story's scope.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix daemon -- tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "refactor(daemon): drop cross-session-message unwrap from tail — attach mode removed"
```

---

### Task 6: `audit-log.ts` — rename `'attach'` → `'readonly'`

**Files:**
- Modify: `daemon/src/services/audit-log.ts`
- Modify: `daemon/test/audit-log.test.ts`

**Interfaces:**
- Produces: `AuditEntry.mode: 'readonly' | 'owned'` (was `'attach' | 'owned'`).

- [ ] **Step 1: Write the failing test (fixture fix)**

In `daemon/test/audit-log.test.ts`, change the one `mode: 'attach'` literal (first test) to `mode: 'readonly'`:

```typescript
    log.record({ sessionId: 's1', mode: 'readonly', clientId: 'phone', prompt: 'secret prompt', outcome: 'queued', requestId: 'r1', at: '2026-08-23T12:00:00Z' });
    const e = JSON.parse(lines[0]!);
    expect(e).toMatchObject({ sessionId: 's1', mode: 'readonly', clientId: 'phone', outcome: 'queued', requestId: 'r1' });
```

(The other two tests already use `mode: 'owned'` — untouched.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- audit-log`
Expected: FAIL — TypeScript rejects `mode: 'readonly'` against the still-`'attach' | 'owned'` type (a compile-time failure surfaces via `npm run typecheck`; vitest itself may still run against stale JS — run `npm run typecheck --prefix daemon` alongside this step to see the real failure).

- [ ] **Step 3: Implement**

In `daemon/src/services/audit-log.ts`, change the `mode` field:

```typescript
export interface AuditEntry {
  sessionId: string;
  mode: 'readonly' | 'owned';
  clientId: string;
  prompt: string;      // hashed on record; the text is NEVER written (§16.4)
  outcome: string;
  requestId: string;
  at: string;
}
```

(Everything else in the file — the `record()` method, the `AuditLog` class — is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck --prefix daemon && npm test --prefix daemon -- audit-log`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/services/audit-log.ts daemon/test/audit-log.test.ts
git commit -m "refactor(daemon): rename AuditEntry.mode 'attach' -> 'readonly'"
```

---

### Task 7: `services.ts` — remove the dead attach stub, wire `buildSummary`'s new ctx shape

**Files:**
- Modify: `daemon/src/services/services.ts`

**Interfaces:**
- Consumes: `buildSummary`'s new `{ isOwned, ... }` ctx (Task 4), `PromptSender.mode: 'readonly' | 'owned'` (Task 4).
- No new exports — `AppDeps` (from `api/app.ts`) is untouched; `startOwned`/`sendPrompt` keep their existing signatures. Story `microviber-2` replaces `startOwned` with `takeover`/`handback` later.

**Note on tests:** `services.ts` has no dedicated unit test today — `createServices` calls `nodeDiscoverySources()` directly (not dependency-injected), so `listSessions()`/`sendPrompt()` can't be unit-tested without touching the real `~/.claude` filesystem. This task is a mechanical rename forced to compile correctly by Task 4's type changes; correctness is verified by `npm run typecheck` (the removed `attachNotImplemented`'s `mode: 'attach'` literal would no longer satisfy `PromptSender`, so a leftover reference is a compile error, not a silent bug) plus the full test suite in Task 8. This is a pre-existing testing gap in the file, not one this story is scoped to fix.

- [ ] **Step 1: n/a (no new test — see note above)**

- [ ] **Step 2: Confirm the compile failure exists first**

Run: `npm run typecheck --prefix daemon`
Expected (before Step 3's edit): FAIL — `attachNotImplemented: PromptSender = { mode: 'attach', ... }` no longer satisfies `PromptSender.mode: 'readonly' | 'owned'`, and the `buildSummary(d, { mode: owned.has(d.id) ? 'owned' : 'attach', ... })` call no longer matches `buildSummary`'s new ctx parameter type.

- [ ] **Step 3: Implement**

In `daemon/src/services/services.ts`, replace the `attachNotImplemented` constant and its two call sites:

```typescript
  const readonlySender: PromptSender = {
    mode: 'readonly',
    send: async () => ({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'session is read-only until taken over', retryable: false }),
  };

  function listSessions(): SessionSummary[] {
    const now = Date.now();
    const discovered = discoverSessions(sources);
    const out = discovered.map((d) => {
      cwdById.set(d.id, d.cwd);
      return buildSummary(d, { isOwned: owned.has(d.id), notifyIdleAt: null, alive: true, nowMs: now });
    });
    return out.sort(bySortOrder);
  }
```

And in `sendPrompt`:

```typescript
    async sendPrompt(a) {
      const sender = owned.get(a.sessionId) ?? readonlySender;
      const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.text, sender, nowMs: Date.now() });
      audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.text, outcome: rec.state, requestId: a.requestId, at: new Date().toISOString() });
      return rec;
    },
```

Also update the file's top doc comment (currently: "Attach-mode send is not built yet (Task 6), so it fails honestly rather than pretending.") to:

```typescript
/**
 * Wires the real adapter + domain into AppDeps. Owned sessions are tracked so
 * they render with mode:'owned' and route sends to their stdin; every other
 * discovered session is read-only and its sendPrompt fails honestly rather
 * than pretending. Real takeover (story microviber-2) will move ownership
 * into domain/ownership.ts's OwnershipRegistry and add /takeover, /handback
 * routes; this story only removes the dead attach stub.
 */
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck --prefix daemon`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/services/services.ts
git commit -m "refactor(daemon): replace dead attachNotImplemented stub with readonlySender"
```

---

### Task 8: Full verification + story wrap-up

**Files:** none (verification only).

- [ ] **Step 1: Run the full daemon suite**

Run: `npm run typecheck --prefix daemon`
Expected: exit 0.

Run: `npm test --prefix daemon`
Expected: all tests pass — old and new.

Run: `npm run lint` (from `microviber/` root)
Expected: clean.

- [ ] **Step 2: Confirm no PWA/route regressions were introduced**

Run: `npm run typecheck --prefix pwa && npm test --prefix pwa`
Expected: unchanged/green — this story touches only `daemon/`, so the PWA workspace must be untouched (still calling the old `/owned` route and old `mode` values via its own `lib/types.ts`, which is fine — that mismatch is expected and resolved by story `microviber-3`, per story-1's Rollout assumption note).

- [ ] **Step 3: Commit is already done per-task — no additional commit needed here.**

---

## Self-Review

**1. Spec/story coverage** — walking story `microviber-1`'s 8 Acceptance Criteria:
1. ✅ Task 1 (`startTakeoverSession`, resumed-id verified via the mismatch-guard test).
2. ✅ Task 1 (`send()` writes a plain frame; exit/crash → typed retryable error — shared core, same behavior as owned mode already had).
3. ✅ Task 3 (`assertIdleForTakeover` + `takeover()`, refuses before any spawn, unit-tested).
4. ✅ Task 2 (`OwnershipRegistry.acquire/release/reap`).
5. ✅ Task 4 (`PromptSender.mode` rename) + Task 7 (`attachNotImplemented` deleted, `services.ts` doc comment updated).
6. ✅ Task 4 (`registry.ts` derives `mode`/`takenOver` from `isOwned`).
7. ✅ Task 5 (`tail.ts` drops wrapper detection; `prompt-lifecycle.ts` correctly needs no change — it was already mode-agnostic, corrected from the story's original draft after reading the real code).
8. ✅ Every task is TDD (or, for Task 7, an explicit documented exception with a stated reason); Task 3's idempotent-ownership test covers checkpoint 13.7's safe default at the domain layer (full daemon-restart behavior is inherently untestable without a real process restart — the in-memory-map design is what guarantees the safe default, and that design is what's under test).

**2. Placeholder scan** — no TBD/TODO; every step has real, runnable code.

**3. Type consistency** — `OwnedSessionHandle` (Task 1) is the exact type `OwnershipRegistry` (Task 2/3) and `services.ts` (Task 7) consume; `PromptSender.mode`/`SessionMode`/`AuditEntry.mode` all converge on the same `'readonly' | 'owned'` union across Tasks 4 and 6; `buildSummary`'s ctx shape (`isOwned`) is used identically in its test (Task 4) and its one real call site in `services.ts` (Task 7).

**Known follow-on work correctly left out of this story** (confirmed against `microviber/stories/README.md`'s dependency graph): HTTP `/takeover`/`/handback` routes and `AppDeps` changes (`microviber-2`); PWA composer/picker changes (`microviber-3`); wiring `PromptLifecycle`'s correlation into a live per-event `injected` flag sent to clients (not part of the "Delta from built code" list — a pre-existing gap, not newly introduced).

---

## Addendum (2026-08-24)

### Task 9: Pairing URL over HTTPS reverse proxy

Absorbed into this story at the user's explicit request after Tasks 1-8 and the final review had already completed and shipped (see story-1.md's ACs 9-11 and its scope note). Unrelated to the takeover-via-resume write path — this is the daemon's startup pairing-URL construction, for running behind `tailscale serve` (Tailscale terminates HTTPS on the `*.ts.net` name; the daemon itself still binds `127.0.0.1` over plain HTTP).

**Files:**
- Modify: `daemon/src/server/pairing.ts`
- Modify: `daemon/src/index.ts`
- Test: `daemon/test/pairing.test.ts` (append; existing test must keep passing unmodified)

**Interfaces:**
- Modifies: `buildPairingUrl(host, port, token, scheme)` — same signature, now omits the port from the returned URL when it equals the scheme's default (443 for `https`, 80 for `http`).
- Produces: `selectPairingTarget(config: { allowedHosts: string[]; bindAddress: string; port: number }): { host: string; port: number; scheme: 'http' | 'https' }` — a pure function, no Fastify/network dependency, importable and testable standalone.
- Consumes (in `index.ts`): `selectPairingTarget` replaces the hardcoded `'http'` literal in the startup print.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/pairing.test.ts` (add `selectPairingTarget` to the import line; keep the existing `buildPairingUrl` "puts the token in the URL FRAGMENT" test untouched — it uses port 8730, a non-default port, so its expected output does not change):

```typescript
import { describe, it, expect } from 'vitest';
import { buildPairingUrl, selectPairingTarget } from '../src/server/pairing.js';

describe('buildPairingUrl', () => {
  it('puts the token in the URL FRAGMENT (never sent to a server)', () => {
    const u = buildPairingUrl('laptop.ts.net', 8730, 'tok en/+=');
    expect(u.startsWith('https://laptop.ts.net:8730/#')).toBe(true);
    const [, fragment] = u.split('#');
    expect(fragment).toContain('token=');
    expect(fragment).toContain(encodeURIComponent('tok en/+='));
    expect(u.split('#')[0]).not.toContain('tok');
  });

  it('omits the port when it is the https default (443)', () => {
    const u = buildPairingUrl('my-laptop.tailabcd.ts.net', 443, 'tok', 'https');
    expect(u).toBe(`https://my-laptop.tailabcd.ts.net/#token=tok`);
  });

  it('omits the port when it is the http default (80)', () => {
    const u = buildPairingUrl('example.local', 80, 'tok', 'http');
    expect(u).toBe(`http://example.local/#token=tok`);
  });

  it('keeps a non-default port for both schemes', () => {
    expect(buildPairingUrl('x.ts.net', 8443, 'tok', 'https')).toContain(':8443');
    expect(buildPairingUrl('127.0.0.1', 8730, 'tok', 'http')).toContain(':8730');
  });
});

describe('selectPairingTarget', () => {
  it('targets the public HTTPS origin when a public host is configured (allowedHosts[0])', () => {
    const target = selectPairingTarget({ allowedHosts: ['my-laptop.tailabcd.ts.net'], bindAddress: '127.0.0.1', port: 8730 });
    expect(target).toEqual({ host: 'my-laptop.tailabcd.ts.net', port: 443, scheme: 'https' });
  });

  it('falls back to the local http origin when no public host is configured', () => {
    const target = selectPairingTarget({ allowedHosts: [], bindAddress: '127.0.0.1', port: 8730 });
    expect(target).toEqual({ host: '127.0.0.1', port: 8730, scheme: 'http' });
  });

  it('end-to-end: selectPairingTarget + buildPairingUrl produces a port-free public HTTPS pairing URL', () => {
    const target = selectPairingTarget({ allowedHosts: ['my-laptop.tailabcd.ts.net'], bindAddress: '127.0.0.1', port: 8730 });
    const u = buildPairingUrl(target.host, target.port, 'tok', target.scheme);
    expect(u).toBe('https://my-laptop.tailabcd.ts.net/#token=tok');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix daemon -- pairing`
Expected: FAIL — `selectPairingTarget` is not exported; the port-omission tests fail against the current unconditional `:${port}` interpolation.

- [ ] **Step 3: Implement**

Replace the full contents of `daemon/src/server/pairing.ts`:

```typescript
/**
 * Pairing URL with the bearer token in the FRAGMENT. Browsers never send the
 * fragment to a server, so the token cannot leak into access logs or referers
 * (spec T8). The PWA reads it client-side and clears it from the URL.
 *
 * The port is omitted when it equals the scheme's default (443 for https, 80
 * for http) — the common case behind a reverse proxy (`tailscale serve`
 * terminates HTTPS on the public `*.ts.net` name at :443).
 */
export function buildPairingUrl(host: string, port: number, token: string, scheme: 'http' | 'https' = 'https'): string {
  const isDefaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  const portPart = isDefaultPort ? '' : `:${port}`;
  return `${scheme}://${host}${portPart}/#token=${encodeURIComponent(token)}`;
}

/**
 * Selects what the startup pairing URL should point at. When a public host
 * is configured (MV_ALLOWED_HOSTS' first entry — the daemon already requires
 * this to be set for the Host-allowlist check, T3), the daemon is assumed to
 * be reachable there over HTTPS via a reverse proxy (e.g. `tailscale serve`,
 * which terminates HTTPS on the `*.ts.net` name and forwards to the daemon's
 * local bind). Otherwise, fall back to the daemon's own local http origin —
 * unchanged pre-existing behavior for a bare local run.
 */
export function selectPairingTarget(
  config: { allowedHosts: string[]; bindAddress: string; port: number },
): { host: string; port: number; scheme: 'http' | 'https' } {
  const publicHost = config.allowedHosts[0];
  if (publicHost) {
    return { host: publicHost, port: 443, scheme: 'https' };
  }
  return { host: config.bindAddress, port: config.port, scheme: 'http' };
}
```

In `daemon/src/index.ts`, update the import and the startup print line:

```typescript
import { buildPairingUrl, selectPairingTarget } from './server/pairing.js';
```

```typescript
  await app.listen({ host: config.bindAddress, port: config.port });
  console.log(`MicroViber daemon listening on ${config.bindAddress}:${config.port}`);
  const pairingTarget = selectPairingTarget(config);
  console.log(`Pair (open on your phone): ${buildPairingUrl(pairingTarget.host, pairingTarget.port, config.bearerToken, pairingTarget.scheme)}`);
```

(No change to `config.ts` — `allowedHosts` already exists on `Config` and is already populated from `MV_ALLOWED_HOSTS`, per the story's Required Behavior #2 primary option. Do not add `MV_PUBLIC_URL` — it was offered as an alternative, not required, and the simpler `allowedHosts[0]` path already satisfies the requirement with no new config surface.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix daemon -- pairing`
Expected: PASS — all 8 tests (1 original + 3 `buildPairingUrl` port tests + 3 `selectPairingTarget` tests + 1 end-to-end test).

Run: `npm run typecheck --prefix daemon`
Expected: exit 0.

Run: `npm test --prefix daemon`
Expected: full suite green (108 + new pairing tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/server/pairing.ts daemon/src/index.ts daemon/test/pairing.test.ts
git commit -m "feat(daemon): pairing URL supports HTTPS reverse proxy (tailscale serve)"
```

**No `any` check:** neither the test nor implementation code introduces `any` anywhere — `selectPairingTarget`'s parameter is a fully-typed structural object, satisfying the user's explicit "no `any` without a `// reason:` comment" acceptance bar trivially (there is no `any` to justify).

**Self-review against story-1.md's ACs 9-11:**
- AC 9 ✅ — port omission for both scheme defaults, non-default ports retained, existing test (port 8730) unaffected.
- AC 10 ✅ — `selectPairingTarget` is pure, takes a narrow structural config shape, no Fastify/network dependency; `index.ts` now calls it instead of hardcoding `'http'`.
- AC 11 ✅ — `index.ts`'s only token-related log line remains the pairing-URL print itself (already the case pre-change — verified no other `console.log`/`console.error` in `index.ts` references `config.bearerToken` or `bearerToken` directly); no separate token field is ever logged.
