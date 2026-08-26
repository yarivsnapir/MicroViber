import { describe, it, expect } from 'vitest';
import { buildPairingUrl, selectPairingTarget } from '../src/server/pairing.js';

describe('buildPairingUrl', () => {
  it('puts the token in the URL FRAGMENT (never sent to a server)', () => {
    const u = buildPairingUrl('laptop.ts.net', 8730, 'tok en/+=');
    expect(u.startsWith('https://laptop.ts.net:8730/#')).toBe(true);
    const [, fragment] = u.split('#');
    expect(fragment).toContain('token=');
    expect(fragment).toContain(encodeURIComponent('tok en/+='));
    // the token must not appear before the '#'
    expect(u.split('#')[0]).not.toContain('tok');
  });

  it('omits the port when it is the https default (443)', () => {
    const u = buildPairingUrl('my-laptop.tailabcd.ts.net', 443, 'tok', 'https');
    expect(u).toBe(`https://my-laptop.tailabcd.ts.net/#token=tok`);
  });

  it('omits the port when it is the http default (80)', () => {
    const u = buildPairingUrl('example.local', 80, 'tok', 'http');
    expect(u).toBe(`http://example.local/#token=tok`);
  });

  it('keeps a non-default port for both schemes', () => {
    expect(buildPairingUrl('x.ts.net', 8443, 'tok', 'https')).toContain(':8443');
    expect(buildPairingUrl('127.0.0.1', 8730, 'tok', 'http')).toContain(':8730');
  });
});

describe('selectPairingTarget', () => {
  it('targets the public HTTPS origin when a public host is configured (allowedHosts[0])', () => {
    const target = selectPairingTarget({ allowedHosts: ['my-laptop.tailabcd.ts.net'], bindAddress: '127.0.0.1', port: 8730 });
    expect(target).toEqual({ host: 'my-laptop.tailabcd.ts.net', port: 443, scheme: 'https' });
  });

  it('falls back to the local http origin when no public host is configured', () => {
    const target = selectPairingTarget({ allowedHosts: [], bindAddress: '127.0.0.1', port: 8730 });
    expect(target).toEqual({ host: '127.0.0.1', port: 8730, scheme: 'http' });
  });

  it('end-to-end: selectPairingTarget + buildPairingUrl produces a port-free public HTTPS pairing URL', () => {
    const target = selectPairingTarget({ allowedHosts: ['my-laptop.tailabcd.ts.net'], bindAddress: '127.0.0.1', port: 8730 });
    const u = buildPairingUrl(target.host, target.port, 'tok', target.scheme);
    expect(u).toBe('https://my-laptop.tailabcd.ts.net/#token=tok');
  });
});
