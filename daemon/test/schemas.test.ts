import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionJsonSchema, ToolResultBlock, AskUserQuestionInputSchema, TranscriptLineSchema } from '../src/lib/claude-adapter/schemas.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');

describe('SessionJsonSchema', () => {
  it('parses a real VS Code session', () => {
    const p = SessionJsonSchema.parse(JSON.parse(fx('session-vscode.json')));
    expect(p.entrypoint).toBe('claude-vscode');
    expect(p.peerFeatures).toContain('notify_idle');
    expect(p.messagingSocketPath).toMatch(/cc-socks/);
  });

  it('parses a real terminal session with no peerFeatures', () => {
    const p = SessionJsonSchema.parse(JSON.parse(fx('session-cli.json')));
    expect(p.entrypoint).toBe('cli');
    expect(p.peerFeatures ?? []).toEqual([]);
  });

  it('rejects a session missing messagingSocketPath', () => {
    expect(() => SessionJsonSchema.parse(JSON.parse(fx('session-no-socket.json')))).toThrow();
  });

  it('rejects a malformed peerProtocol', () => {
    const bad = { ...JSON.parse(fx('session-vscode.json')), peerProtocol: 'one' };
    expect(() => SessionJsonSchema.parse(bad)).toThrow();
  });
});

describe('ToolResultBlock', () => {
  it('parses a tool_result content block', () => {
    const r = ToolResultBlock.safeParse({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'yes' });
    expect(r.success).toBe(true);
  });

  it('rejects a block missing tool_use_id', () => {
    const r = ToolResultBlock.safeParse({ type: 'tool_result', content: 'yes' });
    expect(r.success).toBe(false);
  });
});

describe('AskUserQuestionInputSchema', () => {
  it("parses the tool's documented input shape", () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a shape missing required fields', () => {
    expect(AskUserQuestionInputSchema.safeParse({ questions: [{ question: 'x' }] }).success).toBe(false);
  });
});

describe('TranscriptLineSchema user.isMeta', () => {
  it('parses isMeta when present and leaves it undefined when absent', () => {
    const withMeta = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', content: 'x' }, isMeta: true });
    const without = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', content: 'x' } });
    expect(withMeta.type === 'user' && withMeta.isMeta).toBe(true);
    expect(without.type === 'user' && without.isMeta).toBeUndefined();
  });
});
