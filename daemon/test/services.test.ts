import { describe, it, expect, vi, beforeEach } from 'vitest';
import { excludeSelfPort, createServices } from '../src/services/services.js';
import type { Config } from '../src/config.js';

// ── Task 7 answer-path wiring (spec §6): sendPrompt's toolUseId branch and
// getTranscript's observeAnswer call live inside createServices()'s closure
// over a private OwnershipRegistry/PromptLifecycle — there is no seam to
// inject a fake owned handle directly. createServices' own discovery and
// spawn adapters are hardcoded to the real filesystem (~/.claude/*) and the
// real `claude` binary (node-sources.js / node-spawner.js), so exercising
// the REAL takeover -> sendPrompt -> getTranscript path (rather than
// reimplementing services.ts's logic in the test) requires faking those two
// adapter modules at the module boundary — the same DiscoveryDeps/Spawner
// seam the adapters already use internally, just applied via vi.mock since
// createServices doesn't expose them as constructor params.
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

describe('createServices — answer-path wiring (Task 7, spec §6)', () => {
  beforeEach(() => {
    state.transcriptText = '';
    state.writes = [];
  });

  it('sendPrompt with a toolUseId routes through submitAnswer / sendAnswer, not the plain-text path', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k1', text: 'Yes', toolUseId: 'toolu_1', requestId: 'r1', clientId: 'phone' });
    expect(rec.toolUseId).toBe('toolu_1');
    expect(rec.state).toBe('queued');
    // sendAnswer (via the mocked child's stdinWrite) wrote a tool_result frame, not a plain text frame.
    expect(state.writes.join('')).toContain('"type":"tool_result"');
    expect(state.writes.join('')).toContain('"tool_use_id":"toolu_1"');
    expect(state.writes.join('')).not.toContain('"type":"text"');
  });

  it('sendPrompt with no toolUseId still routes through the plain-text submit()/send() path (no regression)', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k2', text: 'hello', requestId: 'r2', clientId: 'phone' });
    expect(rec.toolUseId).toBeUndefined();
    expect(rec.state).toBe('queued');
    expect(state.writes.join('')).toContain('"type":"text"');
    expect(state.writes.join('')).not.toContain('tool_result');
  });

  it('getTranscript observes a newly-resolved askUserQuestion and marks the matching queued answer accepted', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k3', text: 'Yes', toolUseId: 'toolu_2', requestId: 'r3', clientId: 'phone' });
    expect(rec.state).toBe('queued');

    // Seed a transcript whose tail.ts-parsed events include a resolved
    // askUserQuestion for toolu_2 (a pending AskUserQuestion tool_use
    // followed by a matching tool_result).
    state.transcriptText =
      JSON.stringify({
        type: 'assistant', timestamp: '2026-08-23T12:00:00Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion',
            input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }] }] },
          }],
        },
      }) + '\n' +
      JSON.stringify({
        type: 'user', timestamp: '2026-08-23T12:00:01Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Yes' }] },
      }) + '\n';

    // `rec` is the actual PromptRecord object PromptLifecycle stores — a
    // mutation inside services.ts's getTranscript (via lifecycle.observeAnswer)
    // is visible on this same reference, so no extra lifecycle-inspection API
    // is needed to observe the transition.
    services.getTranscript('sess-1', undefined);
    expect(rec.state).toBe('accepted');
  });
});
