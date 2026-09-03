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
    sendAnswer: async () => ({ ok: true }),
    _exit: () => { alive = false; exitCb(); },
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

  it('acquiring a handle whose child ALREADY exited reaps immediately (isOwned false right after acquire)', () => {
    const reg = new OwnershipRegistry();
    const h = fakeHandle('s1', { alive: false });
    reg.acquire('s1', h);
    expect(reg.isOwned('s1')).toBe(false);
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
