import { describe, it, expect } from 'vitest';
import { deriveState } from '../src/domain/session-state.js';

const now = Date.parse('2026-08-23T12:00:00.000Z');

describe('deriveState (spec §5.1, first-match-wins)', () => {
  it('pid gone => stale, regardless of anything else', () => {
    expect(deriveState({ alive: false, lastActivityAt: '2026-08-23T11:59:59Z', notifyIdleAt: null, nowMs: now })).toBe('stale');
  });
  it('growth within 20s => working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:50Z', notifyIdleAt: null, nowMs: now })).toBe('working');
  });
  it('no growth for 20s => idle', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:30Z', notifyIdleAt: null, nowMs: now })).toBe('idle');
  });
  // THE DEFECT the spec review caught: a session parked on an open assistant turn
  // (no further growth) must become idle so the "waiting for you" push can fire.
  it('open turn, no growth for 20s => idle, NOT working', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:00Z', notifyIdleAt: null, nowMs: now })).toBe('idle');
  });
  it('notify_idle after last growth => idle (faster confirmation)', () => {
    expect(deriveState({ alive: true, lastActivityAt: '2026-08-23T11:59:55Z', notifyIdleAt: '2026-08-23T11:59:58Z', nowMs: now })).toBe('idle');
  });
  it('unopened session, no subscription, no recent growth => idle via heuristic, never undefined', () => {
    expect(deriveState({ alive: true, lastActivityAt: null, notifyIdleAt: null, nowMs: now })).toBe('idle');
  });
});
