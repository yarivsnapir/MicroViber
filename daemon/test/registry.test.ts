import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/domain/registry.js';

const base = {
  id: 's1', title: 'T', folder: 'my-project', cwd: '/x/my-project', host: 'vscode' as const,
  peerProtocol: 1, socketPath: '/tmp/cc-socks/1.sock',
  lastPrompt: 'do the thing', lastPromptAt: '2026-08-23T11:00:00Z', lastActivityAt: '2026-08-23T11:59:50Z',
  turnOpen: false,
};
const now = Date.parse('2026-08-23T12:00:00.000Z');

describe('buildSummary', () => {
  it('mode is readonly and takenOver is false when the session is not in the owned map', () => {
    const s = buildSummary(base, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s).toMatchObject({ id: 's1', writable: true, state: 'working', mode: 'readonly', takenOver: false });
    expect(s).not.toHaveProperty('socketPath');
    expect(s).not.toHaveProperty('peerProtocol');
  });
  it('mode is owned and takenOver is true when the session is in the owned map', () => {
    const s = buildSummary(base, { isOwned: true, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s.mode).toBe('owned');
    expect(s.takenOver).toBe(true);
  });
  it('unsupported protocol => writable:false, state still derived (not stale)', () => {
    const s = buildSummary({ ...base, peerProtocol: 2 }, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: now });
    expect(s.writable).toBe(false);
    expect(s.state).toBe('working'); // NOT stale — it still mirrors
  });
});
