import { describe, it, expect, vi } from 'vitest';
import { authorizeUpgrade } from '../src/api/ws/authorize.js';
import { Hub } from '../src/api/ws/hub.js';

describe('T5 — WS upgrade authorization (CORS does not cover WS)', () => {
  const cfg = { hosts: ['laptop.ts.net'], origins: ['https://laptop.ts.net'], token: 't'.repeat(40) };
  it('accepts a good host + origin + bearer', () => {
    expect(authorizeUpgrade({ host: 'laptop.ts.net', origin: 'https://laptop.ts.net', authHeader: `Bearer ${cfg.token}` }, cfg).ok).toBe(true);
  });
  it('rejects a bad origin even with a valid token', () => {
    const r = authorizeUpgrade({ host: 'laptop.ts.net', origin: 'https://evil.com', authHeader: `Bearer ${cfg.token}` }, cfg);
    expect(r.ok).toBe(false);
  });
  it('rejects a missing/invalid bearer', () => {
    expect(authorizeUpgrade({ host: 'laptop.ts.net', origin: 'https://laptop.ts.net', authHeader: undefined }, cfg).ok).toBe(false);
  });
  it('rejects a bad host (rebinding)', () => {
    expect(authorizeUpgrade({ host: 'evil.com', origin: 'https://laptop.ts.net', authHeader: `Bearer ${cfg.token}` }, cfg).ok).toBe(false);
  });
});

describe('Hub pub/sub', () => {
  it('delivers events to all subscribers of a session', () => {
    const hub = new Hub();
    const a = vi.fn(); const b = vi.fn();
    hub.subscribe('s1', a); hub.subscribe('s1', b);
    hub.publish('s1', { kind: 'assistant', at: 't', text: 'hi' });
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
  });
  it('does not cross sessions', () => {
    const hub = new Hub();
    const a = vi.fn();
    hub.subscribe('s1', a);
    hub.publish('s2', { kind: 'assistant', at: 't', text: 'x' });
    expect(a).not.toHaveBeenCalled();
  });
  it('unsubscribe stops delivery and leaks no listener', () => {
    const hub = new Hub();
    const a = vi.fn();
    const off = hub.subscribe('s1', a);
    off();
    hub.publish('s1', { kind: 'assistant', at: 't', text: 'x' });
    expect(a).not.toHaveBeenCalled();
    expect(hub.subscriberCount('s1')).toBe(0);
  });
});
