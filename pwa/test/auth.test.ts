import { describe, it, expect } from 'vitest';
import { parseTokenFromHash } from '../src/lib/auth.js';

describe('parseTokenFromHash', () => {
  it('extracts a token from the fragment', () => {
    expect(parseTokenFromHash('#token=abcdefgh12345')).toBe('abcdefgh12345');
  });
  it('url-decodes special chars', () => {
    const raw = 'abcdef+/=ghij klmn';
    expect(parseTokenFromHash('#token=' + encodeURIComponent(raw))).toBe(raw);
  });
  it('rejects too-short / missing', () => {
    expect(parseTokenFromHash('#token=x')).toBeNull();
    expect(parseTokenFromHash('#nope=1')).toBeNull();
    expect(parseTokenFromHash('')).toBeNull();
  });
});
