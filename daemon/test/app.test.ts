import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect, type Socket } from 'node:net';
import { buildApp, buildUpgradeRequestHead, hostHeaderPort, type AppDeps } from '../src/api/app.js';
import { createServices } from '../src/services/services.js';
import { OwnershipRegistry } from '../src/domain/ownership.js';
import type { Config } from '../src/config.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';
import { WebpaneTokenStore } from '../src/lib/webpane/webpane-auth.js';

const TOKEN = 'z'.repeat(40);
const config: Config = {
  bindAddress: '127.0.0.1', port: 8730, bearerToken: TOKEN,
  allowedHosts: ['laptop.ts.net'], allowedOrigins: ['https://laptop.ts.net'],
  vapid: null, claudeBin: 'claude', webpaneContentPort: 8443,
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
    resolveWebpaneCookie: () => null,
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
    sendAnswer: async () => ({ ok: true }),
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

  it('prompt with an optional toolUseId in the body threads it through to deps.sendPrompt (spec §6 answer path)', async () => {
    let captured: { toolUseId?: string } | undefined;
    const r = await buildApp(deps({
      sendPrompt: async (a) => { captured = a; return { id: a.key, sessionId: a.sessionId, text: a.text, ...(a.toolUseId !== undefined ? { toolUseId: a.toolUseId } : {}), state: 'queued', sentAt: 0 }; },
    })).inject({
      method: 'POST', url: '/api/sessions/a/prompt',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-answer' },
      payload: { text: 'Yes', toolUseId: 'toolu_1' },
    });
    expect(r.statusCode).toBe(200);
    expect(captured?.toolUseId).toBe('toolu_1');
    expect(r.json().data.toolUseId).toBe('toolu_1');
  });

  it('prompt with no toolUseId in the body threads undefined through (existing plain-text path unregressed)', async () => {
    let captured: { toolUseId?: string } | undefined;
    const r = await buildApp(deps({
      sendPrompt: async (a) => { captured = a; return { id: a.key, sessionId: a.sessionId, text: a.text, state: 'queued', sentAt: 0 }; },
    })).inject({
      method: 'POST', url: '/api/sessions/a/prompt',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-plain' },
      payload: { text: 'hi' },
    });
    expect(r.statusCode).toBe(200);
    expect(captured?.toolUseId).toBeUndefined();
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
    // Path=/ (not /api/webpane/) since the content origin serves proxied
    // dev-server traffic at root paths; the daemon only ACCEPTS the cookie on
    // webpane surfaces, so the narrower browser-side path bound moved
    // server-side (story microviber-track-b-3).
    expect(setCookie).toMatch(/Path=\/;/);
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

describe('webpane content plane — Host :8443 root proxy (story microviber-track-b-3, 2026-08-30)', () => {
  const contentHost = { host: 'laptop.ts.net:8443' };
  const devCookie = { ...contentHost, cookie: 'mv_webpane=tok123' };
  const devResource = { kind: 'devserver' as const, port: 9005 };

  it('proxies an arbitrary root path (e.g. an absolute /_next asset) to the cookie-bound port, preserving path and query', async () => {
    let proxied: { port: number; path: string } | undefined;
    const app = buildApp(deps({
      resolveWebpaneCookie: () => devResource,
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (port, path) => { proxied = { port, path }; return { status: 200, headers: { 'content-type': 'text/javascript' }, body: new TextEncoder().encode('js') }; },
    }));
    const res = await app.inject({ method: 'GET', url: '/_next/static/chunks/app.js?v=1', headers: devCookie });
    expect(res.statusCode).toBe(200);
    expect(proxied).toEqual({ port: 9005, path: '/_next/static/chunks/app.js?v=1' });
  });

  it('401s without a valid cookie — content-plane auth is the cookie capability, nothing else', async () => {
    const app = buildApp(deps({ resolveWebpaneCookie: () => null }));
    const res = await app.inject({ method: 'GET', url: '/_next/app.js', headers: contentHost });
    expect(res.statusCode).toBe(401);
  });

  describe('error responses answer document/iframe navigations as readable HTML, not a raw JSON envelope (post-story-3 bug report, 2026-08-30)', () => {
    // An expired mv_webpane cookie at the framed app's next document load used
    // to serve the JSON error envelope AS the iframe's document — Chrome's raw
    // JSON viewer ("Pretty-print" bar over a white page). Navigations must get
    // a human-readable HTML page; programmatic requests keep the JSON envelope.
    it('401 on an iframe document navigation (sec-fetch-dest: iframe) is HTML with a readable message', async () => {
      const app = buildApp(deps({ resolveWebpaneCookie: () => null }));
      const res = await app.inject({ method: 'GET', url: '/', headers: { ...contentHost, 'sec-fetch-dest': 'iframe' } });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('expired');
    });

    it('401 on a navigation detected via Accept: text/html (no sec-fetch-dest) is HTML too', async () => {
      const app = buildApp(deps({ resolveWebpaneCookie: () => null }));
      const res = await app.inject({ method: 'GET', url: '/', headers: { ...contentHost, accept: 'text/html,application/xhtml+xml' } });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('401 on a fetch-style request (no HTML Accept, no document sec-fetch-dest) keeps the JSON envelope', async () => {
      const app = buildApp(deps({ resolveWebpaneCookie: () => null }));
      const res = await app.inject({ method: 'GET', url: '/_next/app.js', headers: { ...contentHost, 'sec-fetch-dest': 'script', accept: '*/*' } });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('403 (port left the live allowlist) on a document navigation is HTML', async () => {
      const app = buildApp(deps({ resolveWebpaneCookie: () => devResource, listResolvedDevServerPorts: () => [] }));
      const res = await app.inject({ method: 'GET', url: '/', headers: { ...devCookie, 'sec-fetch-dest': 'iframe' } });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('502 (dev server unreachable) on a document navigation is HTML, with the upstream error HTML-escaped', async () => {
      const app = buildApp(deps({
        resolveWebpaneCookie: () => devResource,
        listResolvedDevServerPorts: () => [9005],
        proxyDevServer: async () => { throw new Error('connect ECONNREFUSED <script>alert(1)</script>'); },
      }));
      const res = await app.inject({ method: 'GET', url: '/', headers: { ...devCookie, 'sec-fetch-dest': 'iframe' } });
      expect(res.statusCode).toBe(502);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).not.toContain('<script>');
      expect(res.body).toContain('&lt;script&gt;');
    });
  });

  it('401s a localfile-bound cookie — only a devserver capability routes the content plane', async () => {
    const app = buildApp(deps({ resolveWebpaneCookie: () => ({ kind: 'localfile', path: '/tmp/x.html' }) }));
    const res = await app.inject({ method: 'GET', url: '/anything', headers: devCookie });
    expect(res.statusCode).toBe(401);
  });

  it('403s when the cookie-bound port has left the live resolved allowlist', async () => {
    const app = buildApp(deps({ resolveWebpaneCookie: () => devResource, listResolvedDevServerPorts: () => [] }));
    const res = await app.inject({ method: 'GET', url: '/', headers: devCookie });
    expect(res.statusCode).toBe(403);
  });

  it('never exposes the daemon control-plane API on the content origin — /api/sessions with a valid BEARER is proxied to the dev server, not answered by the daemon', async () => {
    let proxiedPath: string | undefined;
    const app = buildApp(deps({
      resolveWebpaneCookie: () => devResource,
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, path) => { proxiedPath = path; return { status: 200, headers: {}, body: new TextEncoder().encode('devserver-owns-this') }; },
    }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...devCookie, authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(proxiedPath).toBe('/api/sessions');
    expect(res.body).toBe('devserver-owns-this'); // NOT the daemon's session list
  });

  it('forwards a POST body read from the raw stream (no route-level parser runs on the content plane)', async () => {
    let received: Uint8Array | undefined;
    const app = buildApp(deps({
      resolveWebpaneCookie: () => devResource,
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, _path, init) => { received = init.body; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const res = await app.inject({ method: 'POST', url: '/en', headers: { ...devCookie, 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(received!).toString()).toBe('{"a":1}');
  });

  it('still enforces the Host allowlist on the content port (T3 applies to both planes)', async () => {
    const app = buildApp(deps({ resolveWebpaneCookie: () => devResource, listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example.com:8443', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(421);
  });

  it('does not treat the daemon\'s own port as the content plane — main-origin behavior is untouched', async () => {
    const app = buildApp(deps({ resolveWebpaneCookie: () => devResource, listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'laptop.ts.net:8730', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true }); // the daemon's health, not a proxy
  });

  // ── Cross-site rejection (review finding C2 / I6) ──
  const contentDeps = (over: Partial<AppDeps> = {}): AppDeps => deps({
    resolveWebpaneCookie: () => devResource,
    listResolvedDevServerPorts: () => [9005],
    proxyDevServer: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('ok') }),
    ...over,
  });

  it('rejects a cross-site Origin (present + mismatched) with 403 — the SameSite=None cookie makes this reachable', async () => {
    const app = buildApp(contentDeps());
    const res = await app.inject({ method: 'GET', url: '/', headers: { ...devCookie, origin: 'https://evil.example.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('allows a matching same-origin Origin (https://<host:port>) — proxied 200', async () => {
    const app = buildApp(contentDeps());
    const res = await app.inject({ method: 'GET', url: '/', headers: { ...devCookie, origin: 'https://laptop.ts.net:8443' } });
    expect(res.statusCode).toBe(200);
  });

  it('allows a request with NO Origin header at all (the legit iframe document load / same-origin GET subresource) — proxied 200', async () => {
    const app = buildApp(contentDeps());
    const res = await app.inject({ method: 'GET', url: '/', headers: devCookie });
    expect(res.statusCode).toBe(200);
  });

  // ── Response hygiene (review findings I1/C2/M5 / I6) ──
  it('strips set-cookie, content-encoding, and every access-control-* header from the relayed response, and sets referrer-policy + a frame-ancestors CSP', async () => {
    const app = buildApp(contentDeps({
      proxyDevServer: async () => ({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'sid=1; Path=/',
          'content-encoding': 'gzip',
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
        },
        body: new TextEncoder().encode('<html></html>'),
      }),
    }));
    const res = await app.inject({ method: 'GET', url: '/', headers: devCookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain('frame-ancestors');
    // frame-ancestors names the control origin (host with content port stripped).
    expect(String(res.headers['content-security-policy'])).toContain('https://laptop.ts.net');
  });

  it('does not let a proxied dev server override the daemon\'s own content-security-policy or referrer-policy (security regression: reply.header() overwrites, not appends)', async () => {
    const app = buildApp(contentDeps({
      proxyDevServer: async () => ({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'evil'",
          'referrer-policy': 'unsafe-url',
        },
        body: new TextEncoder().encode('<html></html>'),
      }),
    }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { ...devCookie, origin: 'https://laptop.ts.net:8443' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-security-policy'])).toContain('frame-ancestors');
    expect(String(res.headers['content-security-policy'])).not.toContain("default-src 'evil'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('carries the daemon\'s frame-ancestors CSP + referrer-policy on early error returns too, not just the success path', async () => {
    // A 401 (no cookie) is still a content-plane response and must carry the
    // clickjacking + referrer guards — they are set up front, before the auth
    // checks, not only after the upstream copy loop.
    const app = buildApp(contentDeps({ resolveWebpaneCookie: () => null }));
    const res = await app.inject({ method: 'GET', url: '/', headers: contentHost });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['content-security-policy'])).toContain('frame-ancestors');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  // ── Body cap (review finding I3 / I6) ──
  it('413s a POST body over the 10MB cap; a small body still proxies fine', async () => {
    let received: Uint8Array | undefined;
    const app = buildApp(contentDeps({
      proxyDevServer: async (_p, _path, init) => { received = init.body; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const small = await app.inject({ method: 'POST', url: '/upload', headers: { ...devCookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('hi') });
    expect(small.statusCode).toBe(200);
    expect(Buffer.from(received!).toString()).toBe('hi');

    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const over = await app.inject({ method: 'POST', url: '/upload', headers: { ...devCookie, 'content-type': 'application/octet-stream' }, payload: tooBig });
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe('INVALID_INPUT');
  });
});

describe('PWA shell static serving — frame-ancestors as a real header (story microviber-track-b-3 cleanup)', () => {
  it('serves the shell with a frame-ancestors CSP header on HTML, and not on other assets', async () => {
    const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const dir = mkdtempSync(j(tmpdir(), 'mv-pwa-'));
    wf(j(dir, 'index.html'), '<!doctype html><title>x</title>');
    wf(j(dir, 'app.js'), 'console.log(1)');
    const app = buildApp(deps({ pwaDir: dir }));
    const html = await app.inject({ method: 'GET', url: '/', headers: { host: 'laptop.ts.net' } });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    const js = await app.inject({ method: 'GET', url: '/app.js', headers: { host: 'laptop.ts.net' } });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-security-policy']).toBeUndefined();
  });
});

describe('buildUpgradeRequestHead — content-plane WebSocket handshake forwarding (story microviber-track-b-3)', () => {
  it('preserves the WS handshake headers (connection/upgrade/sec-websocket-key/version) that the HTTP proxy would strip as hop-by-hop', () => {
    const out = buildUpgradeRequestHead('GET', '/_next/webpack-hmr?id=abc', {
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'k===', 'sec-websocket-version': '13',
    }, 9005);
    expect(out).toContain('GET /_next/webpack-hmr?id=abc HTTP/1.1\r\n');
    expect(out).toContain('connection: Upgrade\r\n');
    expect(out).toContain('upgrade: websocket\r\n');
    expect(out).toContain('sec-websocket-key: k===\r\n');
    expect(out.endsWith('\r\n\r\n')).toBe(true);
  });

  it('DROPS sec-websocket-protocol — this repo carries the bearer token in it for the control-plane /ws socket, so it must never leak to a dev server (review finding M7)', () => {
    const out = buildUpgradeRequestHead('GET', '/', {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'bearer.secret-token',
    }, 9005);
    expect(out.toLowerCase()).not.toContain('sec-websocket-protocol');
    expect(out).not.toContain('secret-token');
  });

  it('rewrites host to the loopback upstream and never leaks cookie/authorization/origin', () => {
    const out = buildUpgradeRequestHead('GET', '/', {
      host: 'laptop.ts.net:8443', cookie: 'mv_webpane=secret', authorization: 'Bearer secret', origin: 'https://laptop.ts.net:8443',
      'user-agent': 'phone',
    }, 9005);
    expect(out).toContain('host: 127.0.0.1:9005\r\n');
    expect(out).toContain('user-agent: phone\r\n');
    expect(out).not.toContain('laptop.ts.net');
    expect(out).not.toContain('secret');
    expect(out.toLowerCase()).not.toContain('origin:');
  });
});

describe('T4 Origin allowlist carve-out scope (story microviber-track-b-3, 2026-08-29)', () => {
  it('does NOT extend the Origin: null carve-out to routes outside the surviving webpane localfile route', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...auth, origin: 'null' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('still rejects an unlisted real Origin (not "null") for the webpane localfile route — the carve-out is exactly "null", not "anything"', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true, readLocalFile: () => ({ bytes: Buffer.from('x'), contentType: 'text/plain' }) }));
    const res = await app.inject({
      method: 'GET', url: '/api/webpane/localfile?path=/x',
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
  // Mirrors how services.ts wires the mint/check/resolve trio to a real
  // WebpaneTokenStore — every other test stubs these as constants, which never
  // exercises store.check/store.resolve's actual resourceKey comparison. This
  // block mints one real devserver cookie and proves it authorizes ONLY the
  // exact resource it was minted for, across both surviving surfaces: the
  // CONTENT plane (via store.resolve, the routing key) and the main-origin
  // localfile route (via store.check).
  const store = new WebpaneTokenStore();

  function realDeps(over: Partial<AppDeps> = {}): AppDeps {
    return deps({
      mintWebpaneToken: (resource) => ({ cookieValue: store.mint(resource, Date.now()), maxAgeSeconds: 300 }),
      checkWebpaneCookie: (cookieValue, resource) => store.check(cookieValue, resource, Date.now()),
      resolveWebpaneCookie: (cookieValue) => store.resolve(cookieValue, Date.now()),
      ...over,
    });
  }

  const devCookieValue = store.mint({ kind: 'devserver', port: 9005 }, Date.now());
  const devCookieHeader = `mv_webpane=${devCookieValue}`;
  const localCookieValue = store.mint({ kind: 'localfile', path: '/x' }, Date.now());

  it('(a) a devserver cookie routes the CONTENT plane to the exact port it was minted for', async () => {
    const app = buildApp(realDeps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('ok') }),
    }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'laptop.ts.net:8443', cookie: devCookieHeader } });
    expect(res.statusCode).toBe(200);
  });

  it('(b) that same devserver cookie does NOT cross-authenticate the localfile route (different resource kind)', async () => {
    const app = buildApp(realDeps({ readLocalFile: () => ({ bytes: Buffer.from('hi'), contentType: 'text/plain' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=/x', headers: { host: 'laptop.ts.net', cookie: devCookieHeader } });
    expect(res.statusCode).toBe(401);
  });

  it('(c) the content plane 403s once the cookie-bound port leaves the live allowlist — the port check runs even with a valid cookie', async () => {
    const app = buildApp(realDeps({ listResolvedDevServerPorts: () => [] }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'laptop.ts.net:8443', cookie: devCookieHeader } });
    expect(res.statusCode).toBe(403);
  });

  it('(d) a localfile-bound cookie does NOT route the content plane — only a devserver capability does', async () => {
    const app = buildApp(realDeps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'laptop.ts.net:8443', cookie: `mv_webpane=${localCookieValue}` } });
    expect(res.statusCode).toBe(401);
  });

  it('(e) bare 401 on the content plane when no cookie is supplied at all', async () => {
    const app = buildApp(realDeps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'laptop.ts.net:8443' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('hostHeaderPort (unit)', () => {
  it('extracts an explicit port', () => {
    expect(hostHeaderPort('laptop.ts.net:8443')).toBe(8443);
  });
  it('returns null when no port is present', () => {
    expect(hostHeaderPort('laptop.ts.net')).toBeNull();
  });
  it('extracts a port from a bracketed IPv6 host', () => {
    expect(hostHeaderPort('[::1]:8443')).toBe(8443);
  });
  it('returns null for a bracketed IPv6 host with no port', () => {
    expect(hostHeaderPort('[::1]')).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(hostHeaderPort(undefined)).toBeNull();
  });
});

describe('content-plane WebSocket upgrade — live socket handshake (review findings C1/C4)', () => {
  const servers: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  async function liveServer(over: Partial<AppDeps> = {}): Promise<number> {
    const app = buildApp(deps(over));
    servers.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port assigned');
    return addr.port;
  }

  // Sends a raw WS upgrade request and resolves with the response status line
  // (the refuse branch always writes one and closes). The success path never
  // writes a status line here — upstream 9005 isn't listening, so the splice
  // just tears down — so these cases all target refuse branches.
  function rawUpgrade(port: number, extra: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock: Socket = connect(port, '127.0.0.1', () => {
        const lines = [
          'GET /_next/webpack-hmr HTTP/1.1',
          ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
        ];
        sock.write(lines.join('\r\n') + '\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\r\n');
        if (nl !== -1) { resolve(buf.slice(0, nl)); sock.destroy(); }
      });
      sock.on('error', reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error('upgrade handshake timed out')); });
    });
  }

  // A plain HTTP GET (used to prove the daemon is still alive after a peer RST).
  function rawGet(port: number, path: string, host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock: Socket = connect(port, '127.0.0.1', () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d.toString(); });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error('GET timed out')); });
    });
  }

  it('bad Host => 421', async () => {
    const port = await liveServer({ resolveWebpaneCookie: () => ({ kind: 'devserver', port: 9005 }), listResolvedDevServerPorts: () => [9005] });
    const line = await rawUpgrade(port, { Host: 'evil.example.com:8443' });
    expect(line).toContain('421');
  });

  it('right host but no/invalid cookie => 401', async () => {
    const port = await liveServer({ resolveWebpaneCookie: () => null });
    const line = await rawUpgrade(port, { Host: 'laptop.ts.net:8443' });
    expect(line).toContain('401');
  });

  it('valid cookie + allowlisted port but Origin mismatch => 403 (C1)', async () => {
    const port = await liveServer({ resolveWebpaneCookie: () => ({ kind: 'devserver', port: 9005 }), listResolvedDevServerPorts: () => [9005] });
    const line = await rawUpgrade(port, { Host: 'laptop.ts.net:8443', Origin: 'https://evil.example.com' });
    expect(line).toContain('403');
  });

  it('valid cookie + matching Origin but port not in the allowlist => 403', async () => {
    const port = await liveServer({ resolveWebpaneCookie: () => ({ kind: 'devserver', port: 9005 }), listResolvedDevServerPorts: () => [] });
    const line = await rawUpgrade(port, { Host: 'laptop.ts.net:8443', Origin: 'https://laptop.ts.net:8443' });
    expect(line).toContain('403');
  });

  it('does NOT crash the daemon when the client RSTs immediately after a refuse — a subsequent normal request still succeeds (C4)', async () => {
    const port = await liveServer({ resolveWebpaneCookie: () => null });
    // Fire several refuse-then-RST handshakes: send a valid upgrade with a bad
    // host (=> refuse writes a status line to a peer that has already gone
    // away), then destroy immediately so the server's write hits a reset peer.
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write('GET /_next/webpack-hmr HTTP/1.1\r\nHost: evil.example.com:8443\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
          sock.destroy(); // RST before/while the server writes its refuse
          resolve();
        });
        sock.on('error', () => resolve()); // ECONNRESET on our side is expected/fine
      });
    }
    // If the upgrade handler had thrown on the peer reset, the daemon process
    // would be dead and this would hang/reject. A clean 200 proves it survived.
    const resp = await rawGet(port, '/api/health', 'laptop.ts.net');
    expect(resp).toContain('200');
  });
});
