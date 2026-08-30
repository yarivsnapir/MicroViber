import { describe, it, expect } from 'vitest';
import { WebpaneTokenStore, parseCookieHeader, resourceKey } from '../../src/lib/webpane/webpane-auth.js';

describe('parseCookieHeader', () => {
  it('extracts a named cookie from a Cookie header', () => {
    expect(parseCookieHeader('a=1; mv_webpane=abc123; b=2', 'mv_webpane')).toBe('abc123');
  });
  it('returns undefined when absent or header missing', () => {
    expect(parseCookieHeader('a=1', 'mv_webpane')).toBeUndefined();
    expect(parseCookieHeader(undefined, 'mv_webpane')).toBeUndefined();
  });
});

describe('resourceKey', () => {
  it('distinguishes devserver and localfile resources, and different values within each kind', () => {
    expect(resourceKey({ kind: 'devserver', port: 9005 })).not.toBe(resourceKey({ kind: 'devserver', port: 9008 }));
    expect(resourceKey({ kind: 'localfile', path: '/a' })).not.toBe(resourceKey({ kind: 'localfile', path: '/b' }));
    expect(resourceKey({ kind: 'devserver', port: 9005 })).not.toBe(resourceKey({ kind: 'localfile', path: '/9005' }));
  });
});

describe('WebpaneTokenStore (spec §7 "Iframe auth")', () => {
  it('a minted token validates only against the exact resource it was minted for', () => {
    const store = new WebpaneTokenStore();
    const token = store.mint({ kind: 'devserver', port: 9005 }, 0);
    expect(store.check(token, { kind: 'devserver', port: 9005 }, 1000)).toBe(true);
    expect(store.check(token, { kind: 'devserver', port: 9008 }, 1000)).toBe(false);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 1000)).toBe(false);
  });

  it('expires after 5 minutes (Max-Age=300 in the spec)', () => {
    const store = new WebpaneTokenStore();
    const token = store.mint({ kind: 'localfile', path: '/x' }, 0);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 299_000)).toBe(true);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 300_001)).toBe(false);
  });

  it('rejects an unknown/undefined token', () => {
    const store = new WebpaneTokenStore();
    expect(store.check(undefined, { kind: 'devserver', port: 9005 }, 0)).toBe(false);
    expect(store.check('not-a-real-token', { kind: 'devserver', port: 9005 }, 0)).toBe(false);
  });

  it('re-minting for a new resource does not invalidate a still-live token for a different resource', () => {
    const store = new WebpaneTokenStore();
    const t1 = store.mint({ kind: 'devserver', port: 9005 }, 0);
    store.mint({ kind: 'devserver', port: 9008 }, 0);
    expect(store.check(t1, { kind: 'devserver', port: 9005 }, 100)).toBe(true);
  });

  describe('resolve — the content-plane root proxy routing key (story microviber-track-b-3)', () => {
    it('returns the exact resource a live token was minted for', () => {
      const store = new WebpaneTokenStore();
      const t = store.mint({ kind: 'devserver', port: 9005 }, 0);
      expect(store.resolve(t, 100)).toEqual({ kind: 'devserver', port: 9005 });
    });

    it('returns null for an expired token — same 5-minute TTL as check()', () => {
      const store = new WebpaneTokenStore();
      const t = store.mint({ kind: 'devserver', port: 9005 }, 0);
      expect(store.resolve(t, 5 * 60_000 + 1)).toBeNull();
    });

    it('returns null for an unknown or undefined token', () => {
      const store = new WebpaneTokenStore();
      expect(store.resolve(undefined, 0)).toBeNull();
      expect(store.resolve('not-a-real-token', 0)).toBeNull();
    });
  });
});
