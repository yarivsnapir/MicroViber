import { describe, it, expect, vi } from 'vitest';
import { OwnershipRegistry, ForbiddenTakeoverError, assertIdleForTakeover, takeover } from '../src/domain/ownership.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';

function fakeHandle(sessionId: string, opts?: { alive?: boolean }): OwnedSessionHandle & { _exit: () => void } {
  let alive = opts?.alive ?? true;
  let exitCb: () => void = () => {};
  return {
    mode: 'owned', pid: 1, sessionId,
    get alive() { return alive; },
    kill: vi.fn(),
    onExit: (cb) => { if (!alive) { cb(); return; } exitCb = cb; },
    send: async () => ({ ok: true }),
    _exit: () => { alive = false; exitCb(); },
  };
}

/** A promise whose settlement the test controls — lets two takeover() calls start before either can finish. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

  it('acquiring a handle whose child ALREADY exited reaps immediately (isOwned false right after acquire)', () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1', { alive: false });
    reg.acquire('s1', h);
    expect(reg.isOwned('s1')).toBe(false);
  });
});

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

describe('assertIdleForTakeover', () => {
  it('does not throw when idle', () => {
    expect(() => assertIdleForTakeover('idle')).not.toThrow();
  });
  it('throws ForbiddenTakeoverError when working or stale', () => {
    expect(() => assertIdleForTakeover('working')).toThrow(ForbiddenTakeoverError);
    expect(() => assertIdleForTakeover('stale')).toThrow(ForbiddenTakeoverError);
  });
  it('assertIdleForTakeover accepts awaiting-input alongside idle (the actual bug fix)', () => {
    expect(() => assertIdleForTakeover('awaiting-input')).not.toThrow();
  });
  it('assertIdleForTakeover still rejects working and stale', () => {
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

  it('does NOT return a dead existing handle — falls through to idle-gate + spawn again', async () => {
    const reg = new OwnershipRegistry();
    const dead = fakeHandle('s1', { alive: false });
    // simulate a registry entry that went stale without reap having run
    (reg as unknown as { owned: Map<string, OwnedSessionHandle> }).owned = new Map([['s1', dead]]);
    const fresh = fakeHandle('s1');
    const spawn = vi.fn(async () => fresh);
    const result = await takeover({ sessionId: 's1', state: 'idle', registry: reg, spawn });
    expect(spawn).toHaveBeenCalledOnce();
    expect(result).toBe(fresh);
  });

  it('a dead existing handle on a non-idle state still throws ForbiddenTakeoverError (idle-gate still enforced on fallthrough)', async () => {
    const reg = new OwnershipRegistry();
    const dead = fakeHandle('s1', { alive: false });
    (reg as unknown as { owned: Map<string, OwnedSessionHandle> }).owned = new Map([['s1', dead]]);
    const spawn = vi.fn();
    await expect(takeover({ sessionId: 's1', state: 'working', registry: reg, spawn }))
      .rejects.toThrow(ForbiddenTakeoverError);
    expect(spawn).not.toHaveBeenCalled();
  });
});

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
