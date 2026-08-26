import { describe, it, expect } from 'vitest';
import { nodeSpawner } from '../src/lib/claude-adapter/node-spawner.js';

/**
 * Direct coverage over the real node:child_process.spawn() wrapper — not the
 * fakeChild double used elsewhere. This is the fix for a real daemon-crashing
 * bug: an unhandled 'error' event on a ChildProcess is treated by Node as an
 * uncaught exception, killing the whole process. Without a test that spawns
 * something real, a regression here (e.g. someone drops the 'error' listener
 * during a refactor) would sail through the rest of the suite undetected.
 */
describe('nodeSpawner', () => {
  it('a nonexistent binary does not crash the test process, and onExit fires with the real error', async () => {
    const child = nodeSpawner(['this-binary-does-not-exist-anywhere', '--foo'], '/tmp');

    const result = await new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.onExit((code, err) => resolve({ code, err }));
    });

    expect(result.code).toBeNull();
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toMatch(/ENOENT/);
  });

  it('a nonexistent cwd does not crash the test process either', async () => {
    const child = nodeSpawner(['this-binary-does-not-exist-anywhere'], '/no/such/directory/at/all');

    const result = await new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.onExit((code, err) => resolve({ code, err }));
    });

    expect(result.code).toBeNull();
    expect(result.err).toBeInstanceOf(Error);
  });

  it('a real process that exits cleanly reports its exit code with no error', async () => {
    // `node -e` is guaranteed present in this test environment.
    const child = nodeSpawner([process.execPath, '-e', 'process.exit(0)'], process.cwd());

    const result = await new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.onExit((code, err) => resolve({ code, err }));
    });

    expect(result.code).toBe(0);
    expect(result.err).toBeUndefined();
  });
});
