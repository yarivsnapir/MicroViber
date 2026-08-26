export type SessionState = 'working' | 'idle' | 'stale';

const IDLE_AFTER_MS = 20_000;

/**
 * Spec §5.1 evaluation order, first-match-wins:
 *   1. pid gone                              -> stale
 *   2. notify_idle arrived after last growth -> idle (faster confirmation)
 *   3. transcript grew within 20s            -> working
 *   4. otherwise                             -> idle
 *
 * Host-agnostic: the 20s no-growth heuristic is the primary signal, so an
 * unopened session with no subscription still resolves (never undefined), and
 * a session parked on an OPEN assistant turn with no further growth becomes
 * idle -- the case the idle push exists to serve.
 */
export function deriveState(input: {
  alive: boolean;
  lastActivityAt: string | null;
  notifyIdleAt: string | null;
  nowMs: number;
}): SessionState {
  if (!input.alive) return 'stale';

  if (input.notifyIdleAt) {
    const idleAt = Date.parse(input.notifyIdleAt);
    const growthAt = input.lastActivityAt ? Date.parse(input.lastActivityAt) : -Infinity;
    if (!Number.isNaN(idleAt) && idleAt >= growthAt) return 'idle';
  }

  if (input.lastActivityAt) {
    const growthAt = Date.parse(input.lastActivityAt);
    if (!Number.isNaN(growthAt) && input.nowMs - growthAt < IDLE_AFTER_MS) return 'working';
  }

  return 'idle';
}
