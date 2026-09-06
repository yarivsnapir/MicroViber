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
  /** Takeovers currently in flight — from entering `takeover()` until the run settles (acquired, short-circuited, or failed) — keyed by sessionId; see `coalesceTakeover`. */
  private inFlight = new Map<string, Promise<OwnedSessionHandle>>();

  isOwned(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  get(sessionId: string): OwnedSessionHandle | undefined {
    return this.owned.get(sessionId);
  }

  acquire(sessionId: string, handle: OwnedSessionHandle): void {
    this.owned.set(sessionId, handle);
    handle.onExit(() => this.reap(sessionId, handle));
  }

  /** Deliberate hand-back: kill the child and forget it. */
  release(sessionId: string): void {
    const handle = this.owned.get(sessionId);
    if (!handle) return;
    handle.kill();
    this.owned.delete(sessionId);
  }

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

  /**
   * Per-session in-flight lock for takeover (issue #4, arch spec T17). While
   * one takeover of `sessionId` is in flight — from the moment `takeover()`
   * enters until its run settles — every concurrent caller for the SAME
   * session gets that same promise instead of invoking `run` again. Without
   * it, two racing callers (a network retry, a double-tap, two paired devices)
   * both see no registry entry, both pass the idle gate, and both spawn;
   * `acquire` keeps only the last handle and the first child is orphaned —
   * never killed (`release` kills only the handle currently held), and since
   * both children's `onExit` reap by sessionId, the orphan's eventual exit
   * deletes the survivor's entry and flips a live owned session back to
   * read-only. The entry is dropped when the run settles, success OR failure,
   * so a failed spawn can't wedge later attempts behind a rejected promise.
   * The map is keyed per session, so takeovers of different sessions never
   * wait on each other.
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

export class ForbiddenTakeoverError extends Error {
  constructor(state: SessionState) {
    super(`cannot take over a session in state '${state}' — takeover is only allowed while idle or awaiting-input`);
    this.name = 'ForbiddenTakeoverError';
  }
}

/**
 * A session blocked on AskUserQuestion ('awaiting-input') is just as
 * takeover-eligible as 'idle' — it is, structurally, waiting on the user,
 * the exact case takeover exists to serve (spec Feature 5 §6, the bug this
 * gate extension fixes: previously such a session read as 'working' for up
 * to an hour and could never be taken over from the phone).
 */
export function assertIdleForTakeover(state: SessionState): void {
  if (state !== 'idle' && state !== 'awaiting-input') throw new ForbiddenTakeoverError(state);
}

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
