import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionJsonSchema } from '../src/lib/claude-adapter/schemas.js';

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
