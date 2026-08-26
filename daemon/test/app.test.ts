import { describe, it, expect, vi } from 'vitest';
import { buildApp, type AppDeps } from '../src/api/app.js';
import { createServices } from '../src/services/services.js';
import { OwnershipRegistry } from '../src/domain/ownership.js';
import type { Config } from '../src/config.js';
import type { OwnedSessionHandle } from '../src/lib/claude-adapter/session-manager.js';

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
      { id: 'b', title: 'B', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T10:00:00Z', mode: 'readonly', takenOver: false },
      { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T11:00:00Z', mode: 'readonly', takenOver: false },
    ],
    getTranscript: (id) => (id === 'known' ? { events: [], nextCursor: null } : null),
    sendPrompt: async (a) => ({ id: a.key, sessionId: a.sessionId, text: a.text, state: 'queued', sentAt: 0 }),
    takeover: async () => ({ id: 'taken-1', mode: 'owned' }),
    handback: async (id) => ({ id, mode: 'readonly' }),
    health: () => ({ ok: true }),
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
    const baseSummary = { id: 'a', title: 'A', folder: 'f', cwd: '/f', host: 'vscode' as const, writable: true, state: 'idle' as const, lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-08-23T11:00:00Z' };
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
