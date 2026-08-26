import { describe, it, expect, vi } from 'vitest';
import { startTakeoverSession, userFrame, type Spawner, type SpawnedChild } from '../src/lib/claude-adapter/session-manager.js';

function fakeChild(): SpawnedChild & { _stdout: (s: string) => void; _exit: (c: number | null) => void; writes: string[] } {
  let outCb: (s: string) => void = () => {};
  const exitCbs: Array<(c: number | null) => void> = [];
  const writes: string[] = [];
  return {
    pid: 4242,
    stdinWrite: (d) => writes.push(d),
    onStdout: (cb) => { outCb = cb; },
    onExit: (cb) => { exitCbs.push(cb); },
    kill: vi.fn(),
    writes,
    _stdout: (s) => outCb(s),
    _exit: (c) => { for (const cb of exitCbs) cb(c); },
  };
}

describe('userFrame', () => {
  it('produces a plain stream-json user turn (no wrapper)', () => {
    const f = JSON.parse(userFrame('hello'));
    expect(f).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    expect(userFrame('x')).not.toContain('cross-session-message');
  });
});

describe('startTakeoverSession', () => {
  it('spawns claude --resume <sessionId> with the same stream-json flags, resolving without waiting on stdout', async () => {
    const child = fakeChild();
    const spawner: Spawner = vi.fn(() => child);
    // No _stdout line fed in — the real CLI never emits one before a first
    // send (see comment on startTakeoverSession), so resolution must not
    // depend on it.
    const h = await startTakeoverSession({ spawner, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    expect(h.sessionId).toBe('sess-42');
    expect(h.mode).toBe('owned');
    const argv = (spawner as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string[];
    expect(argv).toContain('--resume');
    expect(argv).toContain('sess-42');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('stream-json');
    // --output-format=stream-json requires --print + --verbose (claude CLI
    // hard-errors and exits 1 without them).
    expect(argv).toContain('-p');
    expect(argv).toContain('--verbose');
    expect(argv).not.toContain('-n');
  });

  it('send() writes a plain user frame (no wrapper), same transport as owned mode', async () => {
    const child = fakeChild();
    const h = await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42', _resolveImmediately: 'sess-42' });
    const r = await h.send('answer the question');
    expect(r.ok).toBe(true);
    expect(child.writes.join('')).toContain('"text":"answer the question"');
    expect(child.writes.join('')).not.toContain('cross-session-message');
  });

  it('process exit/crash surfaces a retryable EXTERNAL_SERVICE_ERROR', async () => {
    const child = fakeChild();
    const h = await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42', _resolveImmediately: 'sess-42' });
    child._exit(1);
    const r = await h.send('too late');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('EXTERNAL_SERVICE_ERROR'); expect(r.retryable).toBe(true); }
  });

  it('kills the handle if output later reveals a resume into a different sessionId than requested (F13/F14 guard)', async () => {
    const child = fakeChild();
    await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    expect(child.kill).not.toHaveBeenCalled();
    // Real output only ever arrives after a first send() — see the comment
    // on startTakeoverSession — so this fires post-resolve, not before it.
    child._stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-DIFFERENT' }) + '\n');
    expect(child.kill).toHaveBeenCalled();
  });

  it('kills the handle on a failed-resume error-result line, even after resolving', async () => {
    const child = fakeChild();
    await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    child._stdout(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-42', errors: ['no conversation found'],
    }) + '\n');
    expect(child.kill).toHaveBeenCalled();
  });

  it('does NOT kill the handle when output later confirms the same sessionId (happy path)', async () => {
    const child = fakeChild();
    await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-42' });
    child._stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-42' }) + '\n');
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('OwnedSessionHandle.onExit', () => {
  it('fires registered listeners when the child exits, and alive flips false', async () => {
    const child = fakeChild();
    const h = await startTakeoverSession({ spawner: () => child, claudeBin: 'claude', cwd: '/tmp/x', sessionId: 'sess-1', _resolveImmediately: 'sess-1' });
    let fired = false;
    h.onExit(() => { fired = true; });
    child._exit(0);
    expect(fired).toBe(true);
    expect(h.alive).toBe(false);
  });
});
