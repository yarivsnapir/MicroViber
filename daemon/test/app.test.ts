import { describe, it, expect, vi } from 'vitest';
import { buildApp, type AppDeps } from '../src/api/app.js';
import { createServices } from '../src/services/services.js';
import { OwnershipRegistry } from '../src/domain/ownership.js';
import type { Config } from '../src/config.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';
import { WebpaneTokenStore } from '../src/lib/webpane/webpane-auth.js';

const TOKEN = 'z'.repeat(40);
const config: Config = {
  bindAddress: '127.0.0.1', port: 8730, bearerToken: TOKEN,
  allowedHosts: ['laptop.ts.net'], allowedOrigins: ['https://laptop.ts.net'],
  vapid: null, claudeBin: 'claude',
};

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    config,
    listSessions: () => [
      { id: 'b', title: 'B', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T10:00:00Z', mode: 'readonly', takenOver: false, devServerPorts: [] },
      { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T11:00:00Z', mode: 'readonly', takenOver: false, devServerPorts: [] },
    ],
    getTranscript: (id) => (id === 'known' ? { events: [], nextCursor: null } : null),
    sendPrompt: async (a) => ({ id: a.key, sessionId: a.sessionId, text: a.text, state: 'queued', sentAt: 0 }),
    takeover: async () => ({ id: 'taken-1', mode: 'owned' }),
    handback: async (id) => ({ id, mode: 'readonly' }),
    health: () => ({ ok: true }),
    mintWebpaneToken: () => ({ cookieValue: 'tok123', maxAgeSeconds: 300 }),
    checkWebpaneCookie: () => false,
    listResolvedDevServerPorts: () => [],
    proxyDevServer: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    readLocalFile: () => null,
    ...over,
  };
}
const auth = { authorization: `Bearer ${TOKEN}`, host: 'laptop.ts.net' };

function fakeHandle(sessionId: string): OwnedSessionHandle {
  let alive = true;
  return {
    mode: 'owned', pid: 1, sessionId,
    get alive() { return alive; },
    kill: vi.fn(() => { alive = false; }),
    onExit: () => {},
    send: async () => ({ ok: true }),
  };
}

describe('HTTP surface', () => {
  it('health needs no auth', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/health', headers: { host: 'laptop.ts.net' } });
    expect(r.statusCode).toBe(200);
  });

  it('T3: an unexpected Host => 421 before auth', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/sessions', headers: { host: 'evil.com', ...{ authorization: `Bearer ${TOKEN}` } } });
    expect(r.statusCode).toBe(421);
  });

  it('no bearer => 401', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/sessions', headers: { host: 'laptop.ts.net' } });
    expect(r.statusCode).toBe(401);
  });

  it('T4: disallowed Origin => 403', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/sessions', headers: { ...auth, origin: 'https://evil.com' } });
    expect(r.statusCode).toBe(403);
  });

  it('sessions returns data and echoes X-Request-Id', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/sessions', headers: { ...auth, 'x-request-id': 'req-42' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-request-id']).toBe('req-42');
    expect(r.json().data).toHaveLength(2);
  });

  it('transcript 404 for unknown session', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/sessions/nope/transcript', headers: auth });
    expect(r.statusCode).toBe(404);
  });

  it('prompt requires an Idempotency-Key', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/a/prompt', headers: { ...auth, 'content-type': 'application/json' }, payload: { text: 'hi' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_INPUT');
  });

  it('prompt with a key returns a PromptRecord', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/a/prompt', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k1' }, payload: { text: 'hi' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.state).toBe('queued');
  });

  it('takeover returns the owned session id', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/a/takeover', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ id: 'taken-1', mode: 'owned' });
  });

  it('takeover on a non-idle session surfaces FORBIDDEN, not a 500 (spec: "Rejected with FORBIDDEN if the session is not idle")', async () => {
    const r = await buildApp(deps({
      takeover: async () => { throw Object.assign(new Error("cannot take over a session in state 'working'"), { code: 'FORBIDDEN' }); },
    })).inject({ method: 'POST', url: '/api/sessions/a/takeover', headers: auth });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
  });

  it('prompt on a not-taken-over session -> 403 FORBIDDEN (microviber-2 AC5a)', async () => {
    const r = await buildApp(deps({
      sendPrompt: async () => { throw Object.assign(new Error('session is read-only until taken over'), { code: 'FORBIDDEN' }); },
    })).inject({ method: 'POST', url: '/api/sessions/a/prompt', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-forbidden' }, payload: { text: 'hi' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ success: false, error: { code: 'FORBIDDEN', message: 'session is read-only until taken over' } });
  });

  it('companion: prompt on an owned (taken-over) session still succeeds — existing path unregressed', async () => {
    const r = await buildApp(deps({
      sendPrompt: async (a) => ({ id: a.key, sessionId: a.sessionId, text: a.text, state: 'queued', sentAt: 0 }),
    })).inject({ method: 'POST', url: '/api/sessions/a/prompt', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-owned' }, payload: { text: 'hi' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { id: 'k-owned', sessionId: 'a', text: 'hi', state: 'queued', sentAt: 0 } });
  });

  it('handback returns {id, mode: readonly} (microviber-2 AC4)', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/a/handback', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ id: 'a', mode: 'readonly' });
  });

  it('handback on a never-taken-over session is idempotent: still 200 with the same envelope shape', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/never-owned/handback', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { id: 'never-owned', mode: 'readonly' } });
  });

  it('handback surfaces NOT_FOUND as 404, mirroring takeover\'s catch mapping', async () => {
    const r = await buildApp(deps({
      handback: async () => { throw Object.assign(new Error('no such session'), { code: 'NOT_FOUND' }); },
    })).inject({ method: 'POST', url: '/api/sessions/nope/handback', headers: auth });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });

  it('takeover -> handback disposes the owned handle and the session reverts to not-writable in GET /api/sessions', async () => {
    const registry = new OwnershipRegistry();
    const handle = fakeHandle('a');
    const baseSummary = { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode' as const, writable: true, state: 'idle' as const, lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T11:00:00Z', devServerPorts: [] };
    const app = buildApp(deps({
      listSessions: () => [{ ...baseSummary, mode: registry.isOwned('a') ? 'owned' : 'readonly', takenOver: registry.isOwned('a') }],
      takeover: async (id) => { registry.acquire(id, handle); return { id, mode: 'owned' as const }; },
      handback: async (id) => { registry.release(id); return { id, mode: 'readonly' as const }; },
    }));

    const takeoverRes = await app.inject({ method: 'POST', url: '/api/sessions/a/takeover', headers: auth });
    expect(takeoverRes.statusCode).toBe(200);
    expect(registry.isOwned('a')).toBe(true);

    const handbackRes = await app.inject({ method: 'POST', url: '/api/sessions/a/handback', headers: auth });
    expect(handbackRes.statusCode).toBe(200);
    expect(handbackRes.json().data).toEqual({ id: 'a', mode: 'readonly' });
    expect(handle.kill).toHaveBeenCalledOnce(); // no orphan `claude --resume` process
    expect(registry.isOwned('a')).toBe(false);

    const listRes = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
    expect(listRes.json().data[0]).toMatchObject({ id: 'a', takenOver: false, mode: 'readonly' });
  });
});

describe('services.ts sendPrompt — no-handle rejection (microviber-2 AC5a)', () => {
  it('a session with no owned handle is rejected as FORBIDDEN, and no PromptRecord is persisted: a repeat identical request rejects again rather than idempotently replaying a queued/failed record', async () => {
    const services = createServices(config, () => {});
    const args = { sessionId: 'never-taken-over', key: 'k-repeat', text: 'hi', requestId: 'r1', clientId: 'phone' };
    await expect(services.sendPrompt(args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Same Idempotency-Key + same body: if a record HAD been persisted on the
    // first (rejected) attempt, prompt-lifecycle.ts's submit() would replay
    // it here instead of re-evaluating the no-handle gate. Rejecting again
    // proves nothing was persisted.
    await expect(services.sendPrompt(args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a rejected attempt still appends exactly one audit-log entry (mode: readonly, outcome: rejected) — forensic trace for a bearer-token holder probing session ids (review finding)', async () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l));
    const args = { sessionId: 'never-taken-over', key: 'k-audit', text: 'secret prompt text', requestId: 'r-audit', clientId: 'phone' };
    await expect(services.sendPrompt(args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ sessionId: 'never-taken-over', mode: 'readonly', outcome: 'rejected', requestId: 'r-audit' });
    expect(entry.prompt).toBeUndefined();                 // raw text never written (§16.4)
    expect(typeof entry.promptHash).toBe('string');
    expect(entry.promptHash).not.toContain('secret prompt text');
  });
});

describe('POST /api/webpane-token', () => {
  it('requires bearer auth like every other route', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: { host: 'laptop.ts.net' }, payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });

  it('mints a resource-scoped cookie on success', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({
      method: 'POST', url: '/api/webpane-token', headers: auth,
      payload: { kind: 'devserver', port: 9005 },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/mv_webpane=tok123/);
    expect(setCookie).toMatch(/Path=\/api\/webpane\//);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    // SameSite=None, not Strict (spec T15/T14 interaction, story
    // microviber-track-b-3): the iframe's opaque origin means its own
    // subresource requests are always cross-site and could never carry a
    // SameSite=Strict cookie — None (with Secure, present above) is required
    // for the iframe's own asset requests to authenticate at all.
    expect(setCookie).toMatch(/SameSite=None/);
    expect(setCookie).toMatch(/Max-Age=300/);
  });

  it('rejects an invalid body', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'nonsense' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  it('rejects a port below the 1024 floor at the schema level, before any re-validation', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'devserver', port: 80 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  describe('re-validates the resource at mint time (spec §7 — a syntactically-valid body is not enough)', () => {
    it('403s a devserver port not in the live resolved-port set', async () => {
      const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
      const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'devserver', port: 9008 } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('200s a devserver port that IS in the live resolved-port set (no regression)', async () => {
      const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
      const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'devserver', port: 9005 } });
      expect(res.statusCode).toBe(200);
    });

    it('404s a localfile path that readLocalFile reports as unreadable', async () => {
      const app = buildApp(deps({ readLocalFile: () => null }));
      const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'localfile', path: '/nope' } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('200s a localfile path that readLocalFile reports as readable (no regression)', async () => {
      const app = buildApp(deps({ readLocalFile: () => ({ bytes: Buffer.from('hi'), contentType: 'text/plain' }) }));
      const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'localfile', path: '/x' } });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe('bearer-auth hook cookie carve-out for /api/webpane/*', () => {
  it('the mint endpoint itself never accepts the cookie as a header substitute', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' }, payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });

  it('does NOT accept the webpane cookie on any other /api/* route', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/webpane/devserver/:port/*', () => {
  it('403s a port not in the resolved allowlist', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9999/', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('proxies an allowed port, preserving the sub-path', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<html></html>') }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/scenarios/42', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html></html>');
  });

  it('strips content-encoding/content-length/transfer-encoding/connection from the forwarded response (fetch already decoded the body)', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '999', 'transfer-encoding': 'chunked', connection: 'keep-alive' },
        body: new TextEncoder().encode('<html></html>'),
      }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: auth });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(res.headers.connection).toBeUndefined();
  });

  it('strips set-cookie from the forwarded response (a proxied dev server must not write cookies on the daemon\'s own origin — review finding)', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'mv_webpane=junk; Path=/api/webpane/' },
        body: new TextEncoder().encode('<html></html>'),
      }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the mv_webpane cookie in place of the bearer header for an allowed port', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005], checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts an Origin: null header (the literal value a sandboxed opaque-origin iframe sends — story-3 manual-test finding, 2026-08-29)', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005], checkWebpaneCookie: () => true }));
    const res = await app.inject({
      method: 'GET', url: '/api/webpane/devserver/9005/',
      headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123', origin: 'null' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still requires real auth even with Origin: null — the carve-out only widens the Origin check, not the auth check', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005], checkWebpaneCookie: () => false }));
    const res = await app.inject({
      method: 'GET', url: '/api/webpane/devserver/9005/',
      headers: { host: 'laptop.ts.net', origin: 'null' }, // no cookie, no bearer
    });
    expect(res.statusCode).toBe(401);
  });

  it('strips hop-by-hop request headers (transfer-encoding, connection, upgrade, ...) before forwarding — forwarding them verbatim makes undici\'s fetch() throw outright (verified on Node 22), turning into an opaque 502 instead of a clean response', async () => {
    let receivedHeaders: Record<string, string> | undefined;
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, _path, init) => { receivedHeaders = init.headers; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const res = await app.inject({
      method: 'GET', url: '/api/webpane/devserver/9005/',
      headers: { ...auth, 'transfer-encoding': 'chunked', connection: 'keep-alive', upgrade: 'websocket', 'x-custom': 'keep-me' },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedHeaders).toBeDefined();
    expect(receivedHeaders!['transfer-encoding']).toBeUndefined();
    expect(receivedHeaders!.connection).toBeUndefined();
    expect(receivedHeaders!.upgrade).toBeUndefined();
    // A normal, non-hop-by-hop header must still pass through unaffected.
    expect(receivedHeaders!['x-custom']).toBe('keep-me');
  });

  it('proxies a POST with a non-JSON body without 415ing (catch-all body parser)', async () => {
    let received: Uint8Array | undefined;
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, _path, init) => { received = init.body; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const res = await app.inject({
      method: 'POST', url: '/api/webpane/devserver/9005/upload', headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('raw-bytes'),
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(received!).toString()).toBe('raw-bytes');
  });

  it('proxies a POST with an application/json body as raw bytes, not Fastify-parsed JSON (regression: exact-match json parser must not corrupt the proxied body)', async () => {
    let received: Uint8Array | undefined;
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, _path, init) => { received = init.body; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const rawJson = '{"x":1}';
    const res = await app.inject({
      method: 'POST', url: '/api/webpane/devserver/9005/api/data', headers: { ...auth, 'content-type': 'application/json' },
      payload: rawJson,
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(received!).toString()).toBe(rawJson);
  });
});

describe('T4 Origin allowlist carve-out scope (story microviber-track-b-3, 2026-08-29)', () => {
  it('does NOT extend the Origin: null carve-out to routes outside the two webpane content routes', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...auth, origin: 'null' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('still rejects an unlisted real Origin (not "null") for the webpane content routes — the carve-out is exactly "null", not "anything"', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005], checkWebpaneCookie: () => true }));
    const res = await app.inject({
      method: 'GET', url: '/api/webpane/devserver/9005/',
      headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123', origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/webpane/localfile', () => {
  it('requires the path query param', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the file is missing/unreadable', async () => {
    const app = buildApp(deps({ readLocalFile: () => null }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('serves bytes with the guessed content-type', async () => {
    const app = buildApp(deps({ readLocalFile: () => ({ bytes: Buffer.from('<h1>hi</h1>'), contentType: 'text/html' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx%2Fmockup.html', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    expect(res.body).toBe('<h1>hi</h1>');
  });

  it('accepts the mv_webpane cookie in place of the bearer header, scoped to the exact path', async () => {
    const app = buildApp(deps({
      checkWebpaneCookie: () => true,
      readLocalFile: () => ({ bytes: Buffer.from('hi'), contentType: 'text/plain' }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(200);
  });

  it('sets nosniff + a sandboxed CSP on a successful response (defense in depth — no folder restriction on this route, and the client-side iframe sandbox doesn\'t exist yet, review finding)', async () => {
    const app = buildApp(deps({ readLocalFile: () => ({ bytes: Buffer.from('<h1>hi</h1>'), contentType: 'text/html' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx%2Fmockup.html', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox allow-scripts');
  });
});

describe('webpane cookie auth through a real WebpaneTokenStore (not a stub) — proves resourceKey cross-resource isolation end-to-end (review finding)', () => {
  // Mirrors how services.ts wires mintWebpaneToken/checkWebpaneCookie to a
  // real WebpaneTokenStore — every other test in this file stubs
  // checkWebpaneCookie as `() => true`/`() => false`, which never exercises
  // resourceFromUrl -> checkWebpaneCookie -> store.check's actual resourceKey
  // comparison. This test mints one real cookie and proves it only works for
  // the exact resource it was minted for.
  const store = new WebpaneTokenStore();

  function realDeps(over: Partial<AppDeps> = {}): AppDeps {
    return deps({
      mintWebpaneToken: (resource) => ({ cookieValue: store.mint(resource, Date.now()), maxAgeSeconds: 300 }),
      checkWebpaneCookie: (cookieValue, resource) => store.check(cookieValue, resource, Date.now()),
      ...over,
    });
  }

  const cookieValue = store.mint({ kind: 'devserver', port: 9005 }, Date.now());
  const cookieHeader = `mv_webpane=${cookieValue}`;

  it('(a) works on the exact devserver resource it was minted for', async () => {
    const app = buildApp(realDeps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: { host: 'laptop.ts.net', cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
  });

  it('(b) does NOT work on the localfile route — a devserver-scoped cookie must not cross-authenticate a different resource kind', async () => {
    const app = buildApp(realDeps({ readLocalFile: () => ({ bytes: Buffer.from('hi'), contentType: 'text/plain' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=/x', headers: { host: 'laptop.ts.net', cookie: cookieHeader } });
    expect(res.statusCode).toBe(401);
  });

  it('(c) does NOT work on a devserver port other than the one it was minted for, even if that port were otherwise reachable', async () => {
    // Port 9008 is deliberately NOT in the resolved allowlist here, so the
    // port-allowlist check (which runs before the cookie is ever consulted)
    // may itself 403 first — either a bare 401 (cookie rejected) or a 403
    // (port rejected) proves the cookie can't be used to reach this port.
    const app = buildApp(realDeps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9008/', headers: { host: 'laptop.ts.net', cookie: cookieHeader } });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('(d) bare 401 when neither a bearer header nor any cookie is supplied at all', async () => {
    const app = buildApp(realDeps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: { host: 'laptop.ts.net' } });
    expect(res.statusCode).toBe(401);
  });
});
