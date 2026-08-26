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
    ...overrides,
  };
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
    expect(out[0]?.title).toBe('SynKounter studio issue #747');
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
