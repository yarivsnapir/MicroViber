import { describe, it, expect } from 'vitest';
import { buildApp, type AppDeps } from '../src/api/app.js';
import type { Config } from '../src/config.js';

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
      { id: 'b', title: 'B', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPromptAt: '2026-08-23T10:00:00Z', mode: 'readonly', takenOver: false },
      { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPromptAt: '2026-08-23T11:00:00Z', mode: 'readonly', takenOver: false },
    ],
    getTranscript: (id) => (id === 'known' ? { events: [], nextCursor: null } : null),
    sendPrompt: async (a) => ({ id: a.key, sessionId: a.sessionId, text: a.text, state: 'queued', sentAt: 0 }),
    startOwned: async () => ({ id: 'owned-1' }),
    health: () => ({ ok: true }),
    ...over,
  };
}
const auth = { authorization: `Bearer ${TOKEN}`, host: 'laptop.ts.net' };

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
});
