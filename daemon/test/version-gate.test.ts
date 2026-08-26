import { describe, it, expect } from 'vitest';
import { gateWritability } from '../src/lib/claude-adapter/version-gate.js';

describe('gateWritability', () => {
  it('supported protocol => writable', () => {
    const g = gateWritability(1);
    expect(g.writable).toBe(true);
    expect(g).not.toHaveProperty('reason');
  });
  it('unsupported protocol => not writable, with a reason (fail closed)', () => {
    const g = gateWritability(2);
    expect(g.writable).toBe(false);
    if (!g.writable) expect(g.reason).toMatch(/protocol/i);
  });
  it('does NOT return a session state — the gate never sets state', () => {
    const g = gateWritability(2);
    expect(g).not.toHaveProperty('state');
  });
});
