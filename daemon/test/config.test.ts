import { describe, it, expect } from 'vitest';
import { loadConfig, isBindAllowed } from '../src/config.js';

const base = { MV_BIND_ADDRESS: '127.0.0.1', MV_PORT: '8730', MV_CLAUDE_BIN: 'claude' };

describe('isBindAllowed (spec T1/T2 — never public, never 0.0.0.0)', () => {
  it('rejects wildcard binds', () => {
    expect(isBindAllowed('0.0.0.0')).toBe(false);
    expect(isBindAllowed('::')).toBe(false);
    expect(isBindAllowed('')).toBe(false);
  });
  it('allows loopback', () => {
    expect(isBindAllowed('127.0.0.1')).toBe(true);
    expect(isBindAllowed('::1')).toBe(true);
  });
  it('allows private + tailnet ranges', () => {
    expect(isBindAllowed('192.168.1.5')).toBe(true);
    expect(isBindAllowed('10.0.0.9')).toBe(true);
    expect(isBindAllowed('100.101.102.103')).toBe(true); // Tailscale CGNAT
  });
  it('rejects public addresses', () => {
    expect(isBindAllowed('8.8.8.8')).toBe(false);
    expect(isBindAllowed('93.184.216.34')).toBe(false);
  });
});

describe('loadConfig', () => {
  it('parses a valid env', () => {
    const c = loadConfig(base);
    expect(c.bindAddress).toBe('127.0.0.1');
    expect(c.port).toBe(8730);
  });
  it('crashes on a missing required var (not on first request)', () => {
    expect(() => loadConfig({ MV_PORT: '8730' })).toThrow();
  });
  it('refuses to start on a public / wildcard bind', () => {
    expect(() => loadConfig({ ...base, MV_BIND_ADDRESS: '0.0.0.0' })).toThrow(/bind/i);
    expect(() => loadConfig({ ...base, MV_BIND_ADDRESS: '8.8.8.8' })).toThrow(/bind/i);
  });
  it('auto-generates a bearer token when absent, and it is long', () => {
    const c = loadConfig(base);
    expect(c.bearerToken.length).toBeGreaterThanOrEqual(32);
  });
});
