import { describe, it, expect } from 'vitest';
import { excludeSelfPort } from '../src/services/services.js';

describe('excludeSelfPort (spec §3 — devServerPort must never allowlist the daemon itself)', () => {
  it('nulls out a resolved port that matches the daemon\'s own listening port', () => {
    expect(excludeSelfPort(8730, 8730)).toBeNull();
  });

  it('passes through a resolved port that differs from the daemon\'s own port', () => {
    expect(excludeSelfPort(5173, 8730)).toBe(5173);
  });

  it('passes through null unchanged', () => {
    expect(excludeSelfPort(null, 8730)).toBeNull();
  });
});
