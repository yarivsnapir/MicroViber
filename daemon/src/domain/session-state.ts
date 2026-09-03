export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';

const IDLE_AFTER_MS = 20_000;
// An open turn writes nothing to the transcript while a tool runs or the
// model composes (gaps of many minutes observed in production), so it keeps
// a session 'working' well past the 20s window — but capped: a turn left
// open by a crash mid-request must not read as working forever.
const OPEN_TURN_MAX_MS = 60 * 60_000;

/**
 * Spec §5.1 evaluation order, first-match-wins:
 *   1. pid gone                              -> stale
 *   2. a pending AskUserQuestion              -> awaiting-input (structural
 *      override, spec Feature 5 §6 — see doc comment on hasPendingQuestion)
 *   3. an async Agent dispatch has no
 *      matching task-notification yet        -> working (dispatch's own
 *      launch acknowledgement returns immediately, so the assistant parks
 *      with end_turn seconds later even though the job is still running)
 *   4. notify_idle arrived after last growth -> idle (faster confirmation)
 *   5. transcript grew within 20s            -> working
 *   6. turn still open, grew within 60min    -> working (tool in flight /
 *      model composing; transcripts stall for minutes mid-turn)
 *   7. otherwise                             -> idle
 *
 * Host-agnostic: the growth heuristics are the primary signal, so an
 * unopened session with no subscription still resolves (never undefined).
 * A session parked WAITING FOR THE USER closes its turn (the last assistant
 * entry stops with 'end_turn', so turnOpen is false) and goes idle after
 * 20s -- the case the idle push exists to serve. But a turn closed right
 * after dispatching a background Agent is parked waiting on ITS OWN job, not
 * on the user, so rule 3 must outrank both the notify_idle push and the
 * growth timeout — otherwise a multi-minute background fix wave reads as
 * idle for its whole duration.
 */
export function deriveState(input: {
  alive: boolean;
  lastActivityAt: string | null;
  notifyIdleAt: string | null;
  turnOpen: boolean;
  hasOutstandingBackgroundTask: boolean;
  /** A structural override (spec Feature 5 §6): a session genuinely blocked
   * on AskUserQuestion is awaiting-input regardless of transcript timing —
   * this is NOT a heuristic like the growth-window rules below it, so it's
   * checked right after the only other structural check (!alive) and before
   * every timing-based rule, including notify_idle and the outstanding
   * background-task check. */
  hasPendingQuestion: boolean;
  nowMs: number;
}): SessionState {
  if (!input.alive) return 'stale';

  if (input.hasPendingQuestion) return 'awaiting-input';

  if (input.hasOutstandingBackgroundTask) return 'working';

  if (input.notifyIdleAt) {
    const idleAt = Date.parse(input.notifyIdleAt);
    const growthAt = input.lastActivityAt ? Date.parse(input.lastActivityAt) : -Infinity;
    if (!Number.isNaN(idleAt) && idleAt >= growthAt) return 'idle';
  }

  if (input.lastActivityAt) {
    const growthAt = Date.parse(input.lastActivityAt);
    if (!Number.isNaN(growthAt)) {
      const sinceGrowth = input.nowMs - growthAt;
      if (sinceGrowth < IDLE_AFTER_MS) return 'working';
      if (input.turnOpen && sinceGrowth < OPEN_TURN_MAX_MS) return 'working';
    }
  }

  return 'idle';
}
