import { describe, it, expect } from 'vitest';
import { relativeTime } from '../src/relative-time.js';

describe('relativeTime', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');
  it('renders minutes', () => {
    expect(relativeTime('2026-08-23T11:58:00Z', now)).toBe('2m ago');
  });
  it('renders hours with one decimal under 10h', () => {
    expect(relativeTime('2026-08-23T07:00:00Z', now)).toBe('5.0h ago');
  });
  it('renders days past 48h', () => {
    expect(relativeTime('2026-08-20T12:00:00Z', now)).toBe('3d ago');
  });
  it('handles bad input', () => {
    expect(relativeTime('not-a-date', now)).toBe('?');
  });
});
