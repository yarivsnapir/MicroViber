import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Covers bin/microviberd's autostart surface (spec §11.1). Every case spawns
 * the real runner as a subprocess with a controlled HOME/SHELL/MICROVIBERD_ROOT.
 * NOTHING here installs a service or needs launchd/systemd — the `on`/`off`
 * paths are exercised only where they refuse before touching anything, so the
 * suite is safe to run on a developer's own macOS machine.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(REPO, 'bin', 'microviberd');

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'mv-home-')); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function runner(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [RUNNER, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      SHELL: '/bin/bash',
      TMPDIR: home,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A throwaway repo root: real templates, optional .env, optional fake build. */
function fakeRoot(opts: { env?: boolean; build?: boolean; dir?: string } = {}): string {
  const root = opts.dir ?? mkdtempSync(join(tmpdir(), 'mv-root-'));
  mkdirSync(join(root, 'bin', 'autostart'), { recursive: true });
  // Task 1 runs before bin/autostart/ exists; from Task 2 on it must be copied
  // so a fake root can render (and corrupt) its own templates.
  if (existsSync(join(REPO, 'bin', 'autostart'))) {
    cpSync(join(REPO, 'bin', 'autostart'), join(root, 'bin', 'autostart'), { recursive: true });
  }
  if (opts.env) writeFileSync(join(root, '.env'), 'MV_BIND_ADDRESS=127.0.0.1\nMV_PORT=8730\n');
  if (opts.build) {
    mkdirSync(join(root, 'daemon', 'dist'), { recursive: true });
    writeFileSync(join(root, 'daemon', 'dist', 'index.js'), '');
    mkdirSync(join(root, 'pwa', 'dist'), { recursive: true });
    writeFileSync(join(root, 'pwa', 'dist', 'index.html'), '');
  }
  return root;
}

describe('microviberd run', () => {
  it('refuses without .env, naming it', () => {
    const root = fakeRoot({ build: true });
    const r = runner(['run'], { MICROVIBERD_ROOT: root });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('missing .env');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses without a build, naming npm run build', () => {
    const root = fakeRoot({ env: true });
    const r = runner(['run'], { MICROVIBERD_ROOT: root });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('npm run build');
    rmSync(root, { recursive: true, force: true });
  });
});
