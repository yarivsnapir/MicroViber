import { spawn } from 'node:child_process';
import type { Spawner, SpawnedChild } from './session-manager.js';

/**
 * Real Spawner over node:child_process for owned-mode sessions.
 * argv[0] is the configured claude binary (§16.8 — path comes from config,
 * never hardcoded); the rest are the stream-json flags the manager builds.
 * detached:true parents the process so it survives a daemon restart (spec Task 7).
 */
export const nodeSpawner: Spawner = (argv, cwd): SpawnedChild => {
  const [bin, ...args] = argv;
  const proc = spawn(bin ?? 'claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  });
  return {
    pid: proc.pid ?? -1,
    stdinWrite: (d) => { proc.stdin?.write(d); },
    onStdout: (cb) => { proc.stdout?.on('data', (b: Buffer) => cb(b.toString('utf8'))); },
    onExit: (cb) => { proc.on('exit', (code) => cb(code)); },
    kill: () => { try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); } },
  };
};
