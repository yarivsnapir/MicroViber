import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readFileSync } from 'node:fs';
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

describe('autostart print — macOS plist', () => {
  it('renders a complete, placeholder-free launchd job', () => {
    const r = runner(['autostart', 'print', '--platform', 'darwin'], { SHELL: '/bin/zsh' });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain('<string>com.microviber.daemon</string>');
    // ProgramArguments, in order.
    const args = [...out.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const i = args.indexOf('/bin/zsh');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args.slice(i, i + 4)).toEqual([
      '/bin/zsh', '-il', '-c', `exec ${REPO}/bin/microviberd run`,
    ]);
    expect(out).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(out).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(out).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    const log = `${home}/.microviber/logs/daemon.log`;
    expect(out.match(new RegExp(log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(out).not.toMatch(/__[A-Z]+__/);
    expect(out).not.toContain('0.0.0.0');
  });

  it('falls back to /bin/bash and warns for an unsupported login shell', () => {
    const r = runner(['autostart', 'print', '--platform', 'darwin'], { SHELL: '/usr/bin/fish' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('<string>/bin/bash</string>');
    expect(r.stderr).toContain('MV_AUTOSTART_SHELL');
  });

  it('MV_AUTOSTART_SHELL is used verbatim, bypasses the allowlist, and warns not at all', () => {
    const r = runner(['autostart', 'print', '--platform', 'darwin'], {
      SHELL: '/bin/zsh', MV_AUTOSTART_SHELL: '/usr/local/bin/fish',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('<string>/usr/local/bin/fish</string>');
    expect(r.stderr).not.toContain('MV_AUTOSTART_SHELL');
  });

  it('print writes nothing anywhere', () => {
    runner(['autostart', 'print', '--platform', 'darwin']);
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.microviber'))).toBe(false);
  });

  it('aborts on a placeholder it does not know', () => {
    const root = fakeRoot();
    const tmpl = join(root, 'bin', 'autostart', 'com.microviber.daemon.plist.tmpl');
    writeFileSync(tmpl, `${readFileSync(tmpl, 'utf8')}\n<!-- __UNKNOWN__ -->\n`);
    const r = runner(['autostart', 'print', '--platform', 'darwin'], { MICROVIBERD_ROOT: root });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unsubstituted placeholder');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a clone path containing a space, rendering nothing', () => {
    const root = fakeRoot({ dir: mkdtempSync(join(tmpdir(), 'mv root ')) });
    const r = runner(['autostart', 'print', '--platform', 'darwin'], { MICROVIBERD_ROOT: root });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without spaces or the characters &<>'\"");
    expect(r.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'darwin')('renders a plist plutil accepts', () => {
    const r = runner(['autostart', 'print', '--platform', 'darwin']);
    const f = join(home, 'rendered.plist');
    writeFileSync(f, r.stdout);
    const lint = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });
});
