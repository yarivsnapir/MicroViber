import { describe, it, expect } from 'vitest';
import { isHostAllowed } from '../src/api/middleware/host-allowlist.js';
import { isOriginAllowed } from '../src/api/middleware/cors.js';
import { checkBearer } from '../src/api/middleware/auth.js';
import { resolveRequestId } from '../src/api/middleware/request-id.js';

describe('T3 DNS-rebinding — Host allowlist', () => {
  const allow = ['laptop.tail-scale.ts.net', 'localhost', '127.0.0.1'];
  it('accepts an allowlisted Host (port stripped)', () => {
    expect(isHostAllowed('laptop.tail-scale.ts.net:8730', allow)).toBe(true);
    expect(isHostAllowed('127.0.0.1:8730', allow)).toBe(true);
  });
  it('rejects an attacker-controlled Host (the rebinding vector)', () => {
    expect(isHostAllowed('evil.example.com', allow)).toBe(false);
    expect(isHostAllowed('', allow)).toBe(false);
  });
});

describe('T4/T5 CORS + WS Origin', () => {
  const allow = ['https://laptop.tail-scale.ts.net'];
  it('allows a listed Origin', () => {
    expect(isOriginAllowed('https://laptop.tail-scale.ts.net', allow)).toBe(true);
  });
  it('rejects an unlisted Origin and never allows *', () => {
    expect(isOriginAllowed('https://evil.example.com', allow)).toBe(false);
    expect(allow).not.toContain('*');
  });
  it('allows a missing Origin (non-browser / same-origin)', () => {
    expect(isOriginAllowed(undefined, allow)).toBe(true);
  });
});

describe('bearer auth', () => {
  const token = 'a'.repeat(40);
  it('accepts the correct bearer', () => {
    expect(checkBearer(`Bearer ${token}`, token)).toBe(true);
  });
  it('rejects absent / wrong / non-bearer', () => {
    expect(checkBearer(undefined, token)).toBe(false);
    expect(checkBearer('Bearer nope', token)).toBe(false);
    expect(checkBearer(token, token)).toBe(false); // must be "Bearer <t>"
  });
});

describe('X-Request-Id', () => {
  it('reuses an incoming id', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
  });
  it('mints one when absent', () => {
    const id = resolveRequestId(undefined);
    expect(id.length).toBeGreaterThan(8);
  });
});
