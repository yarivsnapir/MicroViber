import { type PromptSender, type SendOutcome, userFrame } from './prompt-sender.js';
export { userFrame } from './prompt-sender.js';

/** Injected process abstraction so the manager is unit-testable without spawning claude. */
export interface SpawnedChild {
  readonly pid: number;
  stdinWrite(data: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export type Spawner = (argv: string[], cwd: string) => SpawnedChild;

export interface OwnedSessionHandle extends PromptSender {
  readonly mode: 'owned';
  readonly pid: number;
  readonly sessionId: string;
  readonly alive: boolean;
  kill(): void;
  /** Registers a listener for process exit — used by domain/ownership.ts to reap unexpectedly-dead handles. */
  onExit(cb: () => void): void;
}

interface SpawnCoreOpts {
  spawner: Spawner;
  cwd: string;
  argv: string[];
  /** Test hook: resolve the sessionId synchronously instead of waiting on stdout. */
  _resolveImmediately?: string | undefined;
  /** ms to wait for the session_id to appear on stdout before failing. */
  initTimeoutMs?: number | undefined;
}

/**
 * Shared spawn + own-stdin + init-parse core for both owned-mode (fresh
 * session, Task 7) and takeover (resume, Task 6) handles — only argv differs
 * between the two callers below. Both write GENUINE user turns over the
 * documented SDK stream-json stdin transport (findings F11).
 */
function spawnHandle(opts: SpawnCoreOpts): Promise<OwnedSessionHandle> {
  const child = opts.spawner(opts.argv, opts.cwd);

  let alive = true;
  const exitListeners: Array<() => void> = [];
  child.onExit(() => {
    alive = false;
    for (const cb of exitListeners) cb();
  });

  const makeHandle = (sessionId: string): OwnedSessionHandle => ({
    mode: 'owned',
    pid: child.pid,
    sessionId,
    get alive() { return alive; },
    kill: () => child.kill(),
    onExit: (cb) => { if (!alive) { cb(); return; } exitListeners.push(cb); },
    async send(prompt: string, signal?: AbortSignal): Promise<SendOutcome> {
      if (!alive) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'session has exited', retryable: true };
      }
      if (signal?.aborted) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'aborted', retryable: true };
      }
      try {
        child.stdinWrite(userFrame(prompt) + '\n');
        return { ok: true };
      } catch (err) {
        return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: String(err), retryable: true };
      }
    },
  });

  if (opts._resolveImmediately) {
    return Promise.resolve(makeHandle(opts._resolveImmediately));
  }

  return new Promise<OwnedSessionHandle>((resolve, reject) => {
    const timeoutMs = opts.initTimeoutMs ?? 15000;
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('session did not report a session_id in time'));
    }, timeoutMs);

    child.onStdout((chunk) => {
      if (settled) return;
      buf += chunk;
      const nl = buf.lastIndexOf('\n');
      if (nl === -1) return;
      for (const line of buf.slice(0, nl).split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; is_error?: boolean };
          if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string' && o.session_id) {
            settled = true;
            clearTimeout(timer);
            resolve(makeHandle(o.session_id));
            return;
          }
          if (o.type === 'result' && o.is_error) {
            settled = true;
            clearTimeout(timer);
            child.kill();
            reject(new Error(`claude process reported an error during execution: ${line}`));
            return;
          }
        } catch { /* partial/other line */ }
      }
      buf = buf.slice(nl + 1);
    });
  });
}

export interface StartOwnedOpts {
  spawner: Spawner;
  claudeBin: string;
  cwd: string;
  name: string;
  _resolveImmediately?: string;
  initTimeoutMs?: number;
}

/**
 * Owned mode: MicroViber launches a FRESH session over the documented SDK
 * stream-json transport and owns its stdin (findings F11). Phase-2 only
 * (fresh-session creation from the phone) — the MVP write path is takeover,
 * below.
 */
export function startOwnedSession(opts: StartOwnedOpts): Promise<OwnedSessionHandle> {
  const argv = [
    opts.claudeBin,
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '-n', opts.name,
  ];
  return spawnHandle({ spawner: opts.spawner, cwd: opts.cwd, argv, _resolveImmediately: opts._resolveImmediately, initTimeoutMs: opts.initTimeoutMs });
}

export interface StartTakeoverOpts {
  spawner: Spawner;
  claudeBin: string;
  cwd: string;
  sessionId: string;
  _resolveImmediately?: string;
  initTimeoutMs?: number;
}

/**
 * Takeover: resumes a live IDLE session's history into a daemon-owned
 * process via `claude --resume <sessionId>`. `--resume` continues the SAME
 * transcript file (findings F13) and works against a still-alive idle
 * session (F14) — MicroViber takes a turn writing to shared history, it
 * never forks it. The idle gate itself lives in domain/ownership.ts
 * (§16.1 — this adapter function has no opinion on session state).
 */
export async function startTakeoverSession(opts: StartTakeoverOpts): Promise<OwnedSessionHandle> {
  const argv = [
    opts.claudeBin,
    '--resume', opts.sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];
  const handle = await spawnHandle({
    spawner: opts.spawner, cwd: opts.cwd, argv,
    _resolveImmediately: opts._resolveImmediately, initTimeoutMs: opts.initTimeoutMs,
  });
  if (handle.sessionId !== opts.sessionId) {
    handle.kill();
    throw new Error(`takeover resumed a different session than requested (expected ${opts.sessionId}, got ${handle.sessionId})`);
  }
  return handle;
}
