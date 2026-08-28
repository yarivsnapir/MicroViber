import { describe, it, expect } from 'vitest';
import { resolveDevServerPort } from '../../src/lib/webpane/port-resolver.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => files[p] ?? null };
}

describe('resolveDevServerPort (spec §3 — first match wins)', () => {
  it('tier 1: reads PORT= from the folder .env, never executes it', () => {
    const deps = fakeFs({ '/proj/.env': 'FOO=bar\nPORT=9015\nBAZ=qux\n' });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(9015);
  });

  it('tier 2: falls back to devports.json (full-path keyed) when no .env PORT', () => {
    const deps = fakeFs({});
    expect(resolveDevServerPort('/proj', { '/proj': { port: 9005 } }, deps)).toBe(9005);
  });

  it('tier 1 wins over tier 2 when both are present', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=1111\n' });
    expect(resolveDevServerPort('/proj', { '/proj': { port: 9005 } }, deps)).toBe(1111);
  });

  it('tier 3: scans vite.config.* for a port: field when tiers 1-2 are absent', () => {
    const deps = fakeFs({ '/proj/vite.config.ts': 'export default { server: { port: 3000 } }' });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(3000);
  });

  it('tier 3: scans package.json scripts for a --port flag', () => {
    const deps = fakeFs({ '/proj/package.json': JSON.stringify({ scripts: { dev: 'vite --port 4200' } }) });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(4200);
  });

  it('returns null when no tier resolves anything', () => {
    expect(resolveDevServerPort('/proj', {}, fakeFs({}))).toBeNull();
  });

  it('never executes/imports the scanned files — only regexes their raw text', () => {
    // A file that would throw if imported/required must not crash resolution.
    const deps = fakeFs({ '/proj/vite.config.ts': 'throw new Error("do not import me"); export default { port: 3000 }' });
    expect(() => resolveDevServerPort('/proj', {}, deps)).not.toThrow();
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(3000);
  });
});
