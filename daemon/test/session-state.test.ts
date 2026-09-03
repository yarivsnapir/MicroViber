import { describe, it, expect } from 'vitest';
import { deriveState } from '../src/domain/session-state.js';

const now = Date.parse('2026-08-23T12:00:00.000Z');

describe('deriveState (spec §5.1, first-match-wins)', () => {
  it('pid gone => stale, regardless of anything else', () => {
    expect(deriveState({ alive: false, lastActivityAt: '2026-08-23T11:59:59Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('stale');
  });
  it('growth within 20s => working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:50Z', notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('working');
  });
  it('no growth for 20s, turn closed => idle', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:30Z', notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });
  // The spec-review defect refined: a session parked WAITING FOR THE USER
  // ends its last assistant entry with stop_reason 'end_turn' (turnOpen:false)
  // and must go idle so the "waiting for you" push can fire...
  it('parked turn (assistant ended with end_turn), no growth for 20s => idle, NOT working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:00Z', notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });
  // ...while a genuinely OPEN turn (tool in flight, model composing) writes
  // nothing to the transcript for minutes at a time and must stay working —
  // this was the false-idle flapping seen in production.
  it('open turn (tool in flight), no growth for 20s => still working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:50:00Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('working');
  });
  it('open turn abandoned for over an hour => idle (safety cap on the open-turn signal)', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T10:30:00Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });
  it('notify_idle after last growth => idle even if the turn looks open (host knows best)', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:55Z', notifyIdleAt: '2026-08-23T11:59:58Z', turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });
  it('unopened session, no subscription, no recent growth => idle via heuristic, never undefined', () => {
    expect(deriveState({ alive: true, lastActivityAt: null, notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });
  it('open turn with no activity timestamp at all => idle (cap needs a reference point)', () => {
    expect(deriveState({ alive: true, lastActivityAt: null, notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: false, nowMs: now })).toBe('idle');
  });

  // A dispatched background Agent's launch acknowledgement returns
  // immediately, so the assistant routinely parks with end_turn seconds
  // later — turnOpen goes false while the job itself can keep running for
  // minutes. Without this rule the session reads as idle for the whole
  // background run (the bug this section guards against).
  describe('outstanding background task (async Agent dispatch, no notification yet)', () => {
    it('parked turn (end_turn), no growth for minutes => working, NOT idle', () => {
      expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:50:00Z', notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: true, nowMs: now })).toBe('working');
    });
    it('outranks a notify_idle push that arrived after last growth', () => {
      expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:55Z', notifyIdleAt: '2026-08-23T11:59:58Z', turnOpen: true, hasPendingQuestion: false, hasOutstandingBackgroundTask: true, nowMs: now })).toBe('working');
    });
    it('pid gone still wins over an outstanding background task', () => {
      expect(deriveState({ alive: false, lastActivityAt: '2026-08-23T11:59:59Z', notifyIdleAt: null, turnOpen: false, hasPendingQuestion: false, hasOutstandingBackgroundTask: true, nowMs: now })).toBe('stale');
    });
  });

  // Feature 5 §6: a session genuinely blocked on AskUserQuestion is
  // 'awaiting-input' regardless of transcript timing — the actual bug this
  // task fixes (deriveState previously read this as 'working' for up to an
  // hour, and takeover was gated on 'idle', so a session blocked on a
  // question could never be taken over from the phone).
  it('a pending AskUserQuestion overrides every timing-based rule — awaiting-input even with fresh growth', () => {
    const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasOutstandingBackgroundTask: false, hasPendingQuestion: true, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
    expect(state).toBe('awaiting-input');
  });

  it('a dead session is still stale even with a pending question — !alive is checked first', () => {
    const state = deriveState({ alive: false, lastActivityAt: null, notifyIdleAt: null, turnOpen: true, hasOutstandingBackgroundTask: false, hasPendingQuestion: true, nowMs: 0 });
    expect(state).toBe('stale');
  });

  it('without a pending question, behavior is unchanged from before (regression guard)', () => {
    const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasOutstandingBackgroundTask: false, hasPendingQuestion: false, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
    expect(state).toBe('working');
  });
});
