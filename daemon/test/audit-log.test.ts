import { describe, it, expect } from 'vitest';
import { AuditLog } from '../src/services/audit-log.js';

describe('AuditLog', () => {
  it('records prompt HASH not text, with the required fields', () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => lines.push(l));
    log.record({ sessionId: 's1', mode: 'readonly', clientId: 'phone', prompt: 'secret prompt', outcome: 'queued', requestId: 'r1', at: '2026-08-23T12:00:00Z' });
    const e = JSON.parse(lines[0]!);
    expect(e).toMatchObject({ sessionId: 's1', mode: 'readonly', clientId: 'phone', outcome: 'queued', requestId: 'r1' });
    expect(e.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(e)).not.toContain('secret prompt');
  });
  it('records failures too (append-only, one line each)', () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => lines.push(l));
    log.record({ sessionId: 's', mode: 'owned', clientId: 'p', prompt: 'x', outcome: 'failed', requestId: 'r2', at: 't' });
    log.record({ sessionId: 's', mode: 'owned', clientId: 'p', prompt: 'y', outcome: 'queued', requestId: 'r3', at: 't' });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).outcome).toBe('failed');
  });
  it('same prompt text hashes stably; different text differs', () => {
    const a: string[] = []; const log = new AuditLog((l) => a.push(l));
    log.record({ sessionId: 's', mode: 'owned', clientId: 'p', prompt: 'same', outcome: 'queued', requestId: '1', at: 't' });
    log.record({ sessionId: 's', mode: 'owned', clientId: 'p', prompt: 'same', outcome: 'queued', requestId: '2', at: 't' });
    log.record({ sessionId: 's', mode: 'owned', clientId: 'p', prompt: 'diff', outcome: 'queued', requestId: '3', at: 't' });
    const h = a.map((l) => JSON.parse(l).promptHash);
    expect(h[0]).toBe(h[1]);
    expect(h[0]).not.toBe(h[2]);
  });
});
