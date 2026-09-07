import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApi } from '../src/lib/api.js';

describe('api.handback (microviber-3 AC 6/7)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/sessions/{id}/handback with the bearer header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 's1', mode: 'readonly' } }),
    });
    const api = createApi('http://x.test', 'tok-123');

    const result = await api.handback('s1');

    expect(result).toEqual({ id: 's1', mode: 'readonly' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/sessions/s1/handback');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  // AC 7: the dead fresh-start client fn and the daemon route it called are
  // removed entirely, not just unused — enforced at the type level (any
  // lingering reference fails `npm run typecheck`) and verified by grep in
  // the story report, not by a runtime assertion here.
});

describe('api.postAnswer (askuserquestion-answer-mechanism-2)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs {answer:{toolUseId,selections}} to /prompt with the idempotency key and bearer header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 'k', sessionId: 's', text: 'x', state: 'queued', sentAt: 0 } }),
    });
    const api = createApi('http://x.test', 'tok-123');

    const result = await api.postAnswer('s', 't1', [['Yes']], 'k');

    expect(result.state).toBe('queued');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/sessions/s/prompt');
    expect(JSON.parse(String(init.body))).toEqual({ answer: { toolUseId: 't1', selections: [['Yes']] } });
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('k');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });
});

describe('mintWebpaneToken', () => {
  it('POSTs the resource and resolves on success, without requiring cookies to be visible to JS (HttpOnly)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('http://x', 'tok');
    await api.mintWebpaneToken({ kind: 'devserver', port: 9005 });
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/webpane-token', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ kind: 'devserver', port: 9005 }),
    }));
    vi.unstubAllGlobals();
  });

  it('throws ApiError on a non-ok response (e.g. port no longer resolved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ success: false, error: { code: 'FORBIDDEN', message: 'port is not currently resolved' } }),
    }));
    const api = createApi('http://x', 'tok');
    await expect(api.mintWebpaneToken({ kind: 'devserver', port: 9999 })).rejects.toThrow('port is not currently resolved');
    vi.unstubAllGlobals();
  });
});

describe('push API (story push-notification-dispatch-1)', () => {
  // The daemon parses this body with a `.strict()` zod schema (daemon/src/schemas/api.ts),
  // so a wrapper key or a stray field is a 400 — hence toStrictEqual, not toEqual.
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } };

  it('subscribePush POSTs the bare PushSubscription.toJSON() to /api/push/subscribe with the bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('http://x.test', 'tok-123');

    await api.subscribePush(subscription);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toStrictEqual(subscription); // no wrapper key, no extra fields
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    vi.unstubAllGlobals();
  });

  it('subscribePush throws ApiError on a non-ok response (e.g. the daemon rejects the endpoint, T18)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ success: false, error: { code: 'INVALID_INPUT', message: 'invalid push subscription' } }),
    }));
    const api = createApi('http://x.test', 'tok-123');
    await expect(api.subscribePush(subscription)).rejects.toThrow('invalid push subscription');
    vi.unstubAllGlobals();
  });

  it('getPushConfig GETs /api/push/config with the bearer and unwraps body.data', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { enabled: true, publicKey: 'BKEY' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('http://x.test', 'tok-123');

    await expect(api.getPushConfig()).resolves.toStrictEqual({ enabled: true, publicKey: 'BKEY' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/push/config');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    vi.unstubAllGlobals();
  });
});
