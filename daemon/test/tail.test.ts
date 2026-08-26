import { describe, it, expect } from 'vitest';
import { normalizeLine, parseChunk, type TranscriptEvent } from '../src/lib/claude-adapter/tail.js';

const userLine = (text: string, ts = '2026-08-23T11:00:00.000Z') =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });

describe('normalizeLine', () => {
  it('normalizes a plain user turn (not injected)', () => {
    const e = normalizeLine(userLine('run the tests'));
    expect(e).toEqual({ kind: 'user', at: '2026-08-23T11:00:00.000Z', text: 'run the tests', injected: false });
  });

  it('does NOT unwrap a cross-session-message wrapper anymore — attach mode is gone, so it is just literal text', () => {
    const wrapped = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/29905.sock" from-name="my-project-f9" from-mode="bypass">\ncommit it and open the PR\n</cross-session-message>\n\nThis came from another Claude session.';
    const e = normalizeLine(userLine(wrapped)) as Extract<TranscriptEvent, { kind: 'user' }>;
    expect(e.kind).toBe('user');
    expect(e.text).toBe(wrapped);
    expect(e.injected).toBe(false);
  });

  it('normalizes an assistant text turn', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-08-23T11:00:05.000Z' });
    expect(normalizeLine(line)).toEqual({ kind: 'assistant', at: '2026-08-23T11:00:05.000Z', text: 'done' });
  });

  it('collapses a tool_use to a one-line tool event with a summary', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }, timestamp: '2026-08-23T11:00:06.000Z' });
    const e = normalizeLine(line) as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
    expect(e.summary).toContain('npm test');
  });

  it('returns null for unrenderable / unknown lines', () => {
    expect(normalizeLine('{"type":"queue-operation"}')).toBeNull();
    expect(normalizeLine('not json')).toBeNull();
  });
});

describe('parseChunk (incremental, append-only)', () => {
  it('emits complete lines and holds a partial trailing line', () => {
    const a = parseChunk(userLine('one') + '\n' + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"tw');
    expect(a.events).toHaveLength(1);
    expect((a.events[0] as Extract<TranscriptEvent,{kind:'user'}>).text).toBe('one');
    // feed the remainder + rest of the second line
    const b = parseChunk(a.remainder + 'o"}]}}\n');
    expect(b.events).toHaveLength(1);
    expect((b.events[0] as Extract<TranscriptEvent,{kind:'user'}>).text).toBe('two');
    expect(b.remainder).toBe('');
  });

  it('does not throw on a partial trailing line', () => {
    expect(() => parseChunk('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x')).not.toThrow();
  });
});
