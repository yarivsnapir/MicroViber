import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discoverSessions, type DiscoveryDeps } from '../src/lib/claude-adapter/discovery.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');

function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    listSessionFiles: () => ['/s/29905.json', '/s/39154.json'],
    readFile: (p) => (p.includes('29905') ? fx('session-vscode.json') : fx('session-cli.json')),
    isAlive: () => true,
    readTranscript: () => fx('transcript-sample.jsonl'),
    mtimeMs: () => 0,
    ...overrides,
  };
}

function sessionJson(pid: number, sessionId: string): string {
  return JSON.stringify({
    pid, sessionId, cwd: '/x/my-project', version: '2.1.0', peerProtocol: 1,
    entrypoint: 'cli', messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
  });
}

describe('discoverSessions', () => {
  it('returns live sessions with host classification', () => {
    const out = discoverSessions(deps());
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id.startsWith('d86e1bc8'))?.host).toBe('vscode');
    expect(out.find((s) => s.id.startsWith('50c43485'))?.host).toBe('terminal');
  });

  it('drops sessions whose pid is not alive', () => {
    const out = discoverSessions(deps({ isAlive: (pid) => pid === 29905 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.host).toBe('vscode');
  });

  it('resolves title from ai-title', () => {
    const out = discoverSessions(deps());
    expect(out[0]?.title).toBe('Example project issue #747');
  });

  it('falls back to truncated last-prompt, then "(untitled)"', () => {
    const noTitle = '{"type":"last-prompt","lastPrompt":"do the thing"}\n';
    const empty = '';
    let n = 0;
    const out = discoverSessions(deps({
      listSessionFiles: () => ['/s/29905.json', '/s/39154.json'],
      readTranscript: () => (n++ === 0 ? noTitle : empty),
    }));
    expect(out[0]?.title).toBe('do the thing');
    expect(out[1]?.title).toBe('(untitled)');
  });

  it('derives lastPromptAt from the newest user turn, not any activity', () => {
    const out = discoverSessions(deps());
    // newest user turn in the fixture is the wrapped peer prompt at 11:01:00
    expect(out[0]?.lastPromptAt).toBe('2026-08-23T11:01:00.000Z');
  });

  it('never exposes a peerToken field', () => {
    const out = discoverSessions(deps());
    for (const s of out) {
      expect(JSON.stringify(s)).not.toContain('peerToken');
      expect((s as unknown as Record<string, unknown>).peerToken).toBeUndefined();
    }
  });

  it('folder is the cwd basename', () => {
    const out = discoverSessions(deps());
    expect(out[0]?.folder).toBe('my-project');
  });
});

// Claude Code writes one sessions/<pid>.json per PROCESS, and several live
// processes can reference the same sessionId (a VSCode tab re-resuming a
// session, a lingering pre-reload extension process, MicroViber's own
// takeover child). One logical session must render as one row.
describe('discoverSessions dedup by sessionId', () => {
  const files = ['/s/100.json', '/s/200.json'];
  const sameSid = (p: string) =>
    p.includes('100') ? sessionJson(100, 'aaaa-same-sid') : sessionJson(200, 'aaaa-same-sid');

  it('several live session files sharing a sessionId yield ONE session', () => {
    const out = discoverSessions(deps({ listSessionFiles: () => files, readFile: sameSid }));
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('aaaa-same-sid');
  });

  it('the most recently written session file wins (the process most recently attached)', () => {
    const out = discoverSessions(deps({
      listSessionFiles: () => files,
      readFile: sameSid,
      mtimeMs: (p) => (p.includes('200') ? 2000 : 1000),
    }));
    expect(out[0]?.pid).toBe(200);
    expect(out[0]?.socketPath).toBe('/tmp/cc-socks/200.sock');
  });

  it('reads the shared transcript once, not once per duplicate file', () => {
    let reads = 0;
    discoverSessions(deps({
      listSessionFiles: () => files,
      readFile: sameSid,
      readTranscript: () => { reads++; return ''; },
    }));
    expect(reads).toBe(1);
  });

  it('a duplicate whose pid is dead never outranks a live one, whatever its mtime', () => {
    const out = discoverSessions(deps({
      listSessionFiles: () => files,
      readFile: sameSid,
      isAlive: (pid) => pid === 100,
      mtimeMs: (p) => (p.includes('200') ? 2000 : 1000),
    }));
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(100);
  });

  it('distinct sessionIds are untouched by dedup', () => {
    const out = discoverSessions(deps());
    expect(out).toHaveLength(2);
  });
});
