import { describe, it, expect } from 'vitest';
import { deriveState } from '../src/domain/session-state.js';

const now = Date.parse('2026-08-23T12:00:00.000Z');

describe('deriveState (spec §5.1, first-match-wins)', () => {
  it('pid gone => stale, regardless of anything else', () => {
    expect(deriveState({ alive: false, lastActivityAt: '2026-08-23T11:59:59Z', notifyIdleAt: null, turnOpen: true, nowMs: now })).toBe('stale');
  });
  it('growth within 20s => working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:50Z', notifyIdleAt: null, turnOpen: false, nowMs: now })).toBe('working');
  });
  it('no growth for 20s, turn closed => idle', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:30Z', notifyIdleAt: null, turnOpen: false, nowMs: now })).toBe('idle');
  });
  // The spec-review defect refined: a session parked WAITING FOR THE USER
  // ends its last assistant entry with stop_reason 'end_turn' (turnOpen:false)
  // and must go idle so the "waiting for you" push can fire...
  it('parked turn (assistant ended with end_turn), no growth for 20s => idle, NOT working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:00Z', notifyIdleAt: null, turnOpen: false, nowMs: now })).toBe('idle');
  });
  // ...while a genuinely OPEN turn (tool in flight, model composing) writes
  // nothing to the transcript for minutes at a time and must stay working —
  // this was the false-idle flapping seen in production.
  it('open turn (tool in flight), no growth for 20s => still working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:50:00Z', notifyIdleAt: null, turnOpen: true, nowMs: now })).toBe('working');
  });
  it('open turn abandoned for over an hour => idle (safety cap on the open-turn signal)', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T10:30:00Z', notifyIdleAt: null, turnOpen: true, nowMs: now })).toBe('idle');
  });
  it('notify_idle after last growth => idle even if the turn looks open (host knows best)', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:55Z', notifyIdleAt: '2026-08-23T11:59:58Z', turnOpen: true, nowMs: now })).toBe('idle');
  });
  it('unopened session, no subscription, no recent growth => idle via heuristic, never undefined', () => {
    expect(deriveState({ alive: true, lastActivityAt: null, notifyIdleAt: null, turnOpen: false, nowMs: now })).toBe('idle');
  });
  it('open turn with no activity timestamp at all => idle (cap needs a reference point)', () => {
    expect(deriveState({ alive: true, lastActivityAt: null, notifyIdleAt: null, turnOpen: true, nowMs: now })).toBe('idle');
  });
});
