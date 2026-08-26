import type { OwnedSessionHandle } from '../lib/claude-adapter/session-manager.js';
import type { SessionState } from './session-state.js';

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
  if (existing?.alive) return existing;
  assertIdleForTakeover(args.state);
  const handle = await args.spawn();
  args.registry.acquire(args.sessionId, handle);
  return handle;
}
