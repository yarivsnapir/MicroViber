import { describe, it, expect, vi, beforeEach } from 'vitest';
import { excludeSelfPort, createServices } from '../src/services/services.js';
import type { Config } from '../src/config.js';
import { PushSubscriptionStore, type StoreFs } from '../src/lib/push-subscription-store.js';

const state = vi.hoisted(() => ({
  transcriptText: '' as string | null,
  writes: [] as string[],
}));

vi.mock('../src/lib/claude-adapter/node-sources.js', () => ({
  nodeDiscoverySources: () => ({
    listSessionFiles: () => ['/fake/sessions/sess-1.json'],
    readFile: () => JSON.stringify({
      pid: process.pid, sessionId: 'sess-1', cwd: '/fake/cwd', startedAt: 1700000000000,
      version: '2.1.228', peerProtocol: 1, kind: 'interactive', entrypoint: 'cli',
      messagingSocketPath: '/tmp/fake.sock', name: 'fake',
    }),
    isAlive: () => true,
    mtimeMs: () => 1,
    readTranscript: () => '',
  }),
  readTranscriptText: () => state.transcriptText,
}));

vi.mock('../src/lib/claude-adapter/node-spawner.js', () => ({
  nodeSpawner: () => ({
    pid: 4242,
    stdinWrite: (d: string) => { state.writes.push(d); },
    onStdout: () => {},
    onExit: () => {},
    kill: () => {},
  }),
}));

describe('excludeSelfPort (spec §3 — devServerPorts must never allowlist the daemon itself)', () => {
  it('filters out an entry whose port matches the daemon\'s own listening port', () => {
    expect(excludeSelfPort([{ folder: 'f', port: 8730 }], 8730)).toEqual([]);
  });

  it('passes through an entry whose port differs from the daemon\'s own port', () => {
    expect(excludeSelfPort([{ folder: 'f', port: 5173 }], 8730)).toEqual([{ folder: 'f', port: 5173 }]);
  });

  it('filters only the matching entry out of a mixed list, keeping the rest', () => {
    const resolved = [{ folder: 'a', port: 8730 }, { folder: 'b', port: 5173 }];
    expect(excludeSelfPort(resolved, 8730)).toEqual([{ folder: 'b', port: 5173 }]);
  });

  it('passes through an empty list unchanged', () => {
    expect(excludeSelfPort([], 8730)).toEqual([]);
  });

  it('also excludes the webpane CONTENT port when passed (review finding M8 — a dev server resolving to the content port must not make the daemon proxy into its own front end)', () => {
    const resolved = [{ folder: 'a', port: 8443 }, { folder: 'b', port: 5173 }, { folder: 'c', port: 8730 }];
    expect(excludeSelfPort(resolved, 8730, 8443)).toEqual([{ folder: 'b', port: 5173 }]);
  });
});

const config: Config = {
  bindAddress: '127.0.0.1', port: 8730, bearerToken: 'z'.repeat(40),
  allowedHosts: [], allowedOrigins: [], vapid: null, claudeBin: 'claude', webpaneContentPort: 8443,
};


const pendingTranscript = JSON.stringify({
  type: 'assistant', timestamp: '2026-09-03T12:00:00Z',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } }] },
}) + '\n';
const answer = { toolUseId: 'toolu_2', selections: [['No']] };

describe('createServices — answer path (spec §5)', () => {
  beforeEach(() => { state.transcriptText = pendingTranscript; state.writes = []; });

  it('composes the answer text and sends it as a PLAIN user turn, never a tool_result frame', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k1', body: { answer }, requestId: 'r1', clientId: 'phone' });
    expect(rec.state).toBe('queued');
    expect(rec.text).toBe('Answering your question:\n- Confirm: No');
    expect(rec.answerBody).toBe(JSON.stringify(answer));
    const wire = state.writes.join('');
    expect(wire).toContain('"type":"text"');
    expect(wire).toContain('Answering your question:');
    expect(wire).not.toContain('tool_result');
  });

  it('becomes accepted when getTranscript observes the composed text as a user turn', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k2', body: { answer }, requestId: 'r2', clientId: 'phone' });
    state.transcriptText = pendingTranscript + JSON.stringify({ type: 'user', timestamp: '2026-09-03T12:00:30Z', message: { role: 'user', content: [{ type: 'text', text: 'Answering your question:\n- Confirm: No' }] } }) + '\n';
    services.getTranscript('sess-1', undefined);
    expect(rec.state).toBe('accepted');
  });

  it('REGRESSION (review round 1): a same-key replay after the answer landed returns the original record instead of 400 "no longer pending"', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const first = await services.sendPrompt({ sessionId: 'sess-1', key: 'k3', body: { answer }, requestId: 'r3', clientId: 'phone' });
    state.transcriptText = pendingTranscript + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Answering your question:\n- Confirm: No' }] } }) + '\n';
    const replay = await services.sendPrompt({ sessionId: 'sess-1', key: 'k3', body: { answer }, requestId: 'r3b', clientId: 'phone' });
    expect(replay).toBe(first);
    expect(state.writes).toHaveLength(1);
  });

  it('a same-key replay with a different answer is rejected INVALID_INPUT', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    await services.sendPrompt({ sessionId: 'sess-1', key: 'k4', body: { answer }, requestId: 'r4', clientId: 'phone' });
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k4', body: { answer: { toolUseId: 'toolu_2', selections: [['Yes']] } }, requestId: 'r4b', clientId: 'phone' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['no pending question', '', 'question is no longer pending'],
    ['stale toolUseId', pendingTranscript, 'question is no longer pending'],
  ])('rejects INVALID_INPUT (%s), writes nothing, and audits the rejection with the canonical body', async (_name, transcript, message) => {
    state.transcriptText = transcript;
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l));
    await services.takeover('sess-1');
    const body = transcript ? { toolUseId: 'toolu_STALE', selections: [['No']] } : answer;
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k5', body: { answer: body }, requestId: 'r5', clientId: 'phone' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message });
    expect(state.writes).toHaveLength(0);
    const rejected = lines.map((l) => JSON.parse(l) as { outcome: string; promptHash: string }).find((e) => e.outcome === 'rejected');
    expect(rejected).toBeDefined();
    const { createHash } = await import('node:crypto');
    expect(rejected?.promptHash).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    // and a retry under the same key is evaluated afresh (no record was persisted)
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k5', body: { answer: body }, requestId: 'r5b', clientId: 'phone' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an unknown label and a wrong selections count before any write', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k6', body: { answer: { toolUseId: 'toolu_2', selections: [['Maybe']] } }, requestId: 'r6', clientId: 'phone' })).rejects.toMatchObject({ message: 'unknown option for Confirm' });
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k7', body: { answer: { toolUseId: 'toolu_2', selections: [['No'], ['No']] } }, requestId: 'r7', clientId: 'phone' })).rejects.toMatchObject({ message: 'answer must cover every question' });
    expect(state.writes).toHaveLength(0);
  });

  it('an answer to a not-taken-over session is 403 FORBIDDEN, audited readonly/rejected, no record', async () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l));
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k8', body: { answer }, requestId: 'r8', clientId: 'phone' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'readonly', outcome: 'rejected' });
  });

  it('plain text prompts are unchanged', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k9', body: { text: 'hello' }, requestId: 'r9', clientId: 'phone' });
    expect(rec.text).toBe('hello');
    expect(rec.answerBody).toBeUndefined();
    expect(state.writes.join('')).toContain('"text":"hello"');
  });
});

describe('createServices — Web Push (story push-notification-dispatch-1)', () => {
  const memFs = (): StoreFs => { let c: string | null = null; return { readFileIfExists: () => c, writeFileAtomic: (_p, t) => { c = t; } }; };
  const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPx', auth: 'aX' } };

  it('without MV_VAPID_*: config reports disabled + null key, and subscribePush rejects INVALID_INPUT (opt-in — no keys, no outbound calls, nothing stored)', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    const services = createServices(config, () => {}, { pushStore: store }); // `config` above has vapid: null
    expect(services.getPushConfig()).toEqual({ enabled: false, publicKey: null });
    expect(() => services.subscribePush(body)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(store.list()).toEqual([]);
  });

  it('with VAPID configured: config exposes the public key and subscribePush upserts into the store', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    const services = createServices({ ...config, vapid: { publicKey: 'BPUB', privateKey: 'PRIV' } }, () => {}, { pushStore: store });
    expect(services.getPushConfig()).toEqual({ enabled: true, publicKey: 'BPUB' });
    services.subscribePush(body);
    expect(store.list().map((s) => s.endpoint)).toEqual([body.endpoint]);
  });

  it('a successful subscribe is recorded through the audit sink with the endpoint HOST ONLY — the endpoint path is bearer-secret-like and must never be logged', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    const lines: string[] = [];
    const services = createServices({ ...config, vapid: { publicKey: 'BPUB', privateKey: 'PRIV' } }, (l) => lines.push(l), { pushStore: store });
    services.subscribePush(body);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'push.subscribe', outcome: 'accepted', host: 'fcm.googleapis.com' });
    expect(lines[0] ?? '').not.toContain('/fcm/send/abc'); // the path, i.e. the capability itself
    expect(lines[0] ?? '').toMatch(/\n$/);                 // audit.jsonl stays one JSON object per line
  });

  it('a REJECTED subscribe (no VAPID) is audited too (review finding C3) — a rejection is the only signal of someone probing T19(b) SSRF surface, and it used to leave no trace at all', () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l), { pushStore: new PushSubscriptionStore('/x/subs.json', memFs()) });
    expect(() => services.subscribePush(body)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'push.subscribe', outcome: 'rejected', host: 'fcm.googleapis.com' });
    expect(lines[0] ?? '').not.toContain('/fcm/send/abc');
    expect(lines[0] ?? '').toMatch(/\n$/);
  });

  it('recordPushRejection logs the HOST ONLY, exactly like the accepted record — the endpoint path is the capability itself', () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l), { pushStore: new PushSubscriptionStore('/x/subs.json', memFs()) });
    services.recordPushRejection('https://127.0.0.1:8730/api/sessions?secret=abc');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'push.subscribe', outcome: 'rejected', host: '127.0.0.1:8730' });
    expect(lines[0] ?? '').not.toContain('/api/sessions');
    expect(lines[0] ?? '').not.toContain('secret=abc');
  });

  it('recordPushRejection OMITS host when the value does not parse as a URL — a rejected body may carry anything, and an unparseable blob must never be pasted into the audit file', () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l), { pushStore: new PushSubscriptionStore('/x/subs.json', memFs()) });
    services.recordPushRejection('not a url at all');
    services.recordPushRejection(undefined);
    services.recordPushRejection({ nested: 'object' });
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(JSON.parse(l)).toEqual({ event: 'push.subscribe', outcome: 'rejected', at: expect.any(String) });
      expect(l).not.toContain('not a url');
      expect(l).not.toContain('nested');
    }
  });

  it('with VAPID configured but no store injected (tests / legacy callers): disabled, and subscribePush rejects rather than pretending', () => {
    const services = createServices({ ...config, vapid: { publicKey: 'BPUB', privateKey: 'PRIV' } }, () => {});
    expect(services.getPushConfig().enabled).toBe(false);
    expect(() => services.subscribePush(body)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
