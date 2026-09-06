# Opt-in Auto-start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a user one command that makes the MicroViber daemon start at login and restart after a crash, and one command that undoes it — off by default, on macOS (launchd) and Linux (systemd user service).

**Architecture:** No daemon or PWA code changes. `bin/microviberd` gains a foreground `run` verb and an `autostart on|off|status|print` verb group; two text templates under `bin/autostart/` are rendered with three substitutions and installed into the user's own service directory. The service's only command is `<login shell> -il -c 'exec <repo>/bin/microviberd run'`, so the daemon — and the `claude` children it spawns on takeover — inherit the same environment as a terminal. The existing `start|stop|restart|status` verbs detect an installed service and drive the manager instead of the pid file.

**Tech Stack:** Bash (the runner and templates), Node 22 + TypeScript + vitest (the test that renders and asserts, spawning the runner as a subprocess), launchd (macOS), systemd --user (Linux).

**Spec:** `docs/features/opt-in-autostart/spec.md` — every `§` below refers to it. **Judge:** `docs/architecture-spec.md` §5 threat model (this feature adds row **T18**; it touches no transport, auth, or claude-adapter code) + §6 engineering standards.

## Global Constraints

- **Testing gate** (architecture-spec §6): `cd microviber && npm run typecheck && npm run lint && npm test` must be green before every commit. Faster loop while iterating: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`.
- **No daemon/PWA behaviour change** (§12). Nothing under `daemon/src/` or `pwa/src/` is modified by this feature. The only new source file is a test.
- **Off by default is non-negotiable** (T18, repo `CLAUDE.md` security rules): nothing installs the service implicitly — not `npm run build`, not `INSTALL.md`'s main path, not `start`. Only an explicit `autostart on` writes a service file.
- **User scope only:** `~/Library/LaunchAgents` and `gui/<uid>` on macOS; `~/.config/systemd/user` on Linux. Never `/Library/LaunchDaemons`, never a system unit, never `sudo`.
- **Fail closed** (§9.4): refuse before writing anything when the build, `.env`, the platform, the service manager, or the clone path is unusable; abort on an unsubstituted `__PLACEHOLDER__`.
- **Bash discipline:** the runner keeps `set -euo pipefail`. Substitution uses bash parameter expansion, never `sed` (§4). No new runtime dependency — the runner may use only `uname`, `id`, `mkdir`, `chmod`, `mv`, `rm`, `launchctl`, `systemctl`.
- **Test hooks, exactly three** (§5), documented in the runner header as test/escape hatches, not user settings: `autostart print --platform <os>`, `MICROVIBERD_ROOT`, `MV_AUTOSTART_SHELL`. Do not add a fourth.
- **Copy (verbatim, asserted by tests):** clone-path refusal `clone MicroViber into a path without spaces or the characters &<>'"`; placeholder abort contains `unsubstituted placeholder`; missing env `missing .env — see INSTALL.md Stage 3`; missing build `build first: npm run build`; shell fallback `⚠ $SHELL is <x>; using /bin/bash -il — set MV_AUTOSTART_SHELL=/path/to/shell to override`; `stop` under auto-start `○ MicroViber stopped. Auto-start is still on — it starts again at your next login. To turn that off: ./bin/microviberd autostart off`; `autostart off` when off `○ auto-start is already OFF`.
- **Fixed identifiers:** launchd label `com.microviber.daemon`; systemd unit `microviber.service`; log `~/.microviber/logs/daemon.log` (dir `700`, file `600`).
- **Commit style:** conventional, scoped — `feat(autostart): …`, `test(autostart): …`, `docs(autostart): …`. Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Branch:** `feature/opt-in-autostart` in the microviber repo (already cut from `origin/main` at `8042c5e`; the spec is committed on it). Other sessions share this checkout — run `git log origin/main..HEAD` before committing and leave commits you did not write alone.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `bin/microviberd` | Modify | The whole feature's logic: `run`, `autostart on\|off\|status\|print`, platform + managed probes, manager-driven `start\|stop\|restart\|status`. Stays one file (§5). |
| `bin/autostart/com.microviber.daemon.plist.tmpl` | Create | launchd job as data: label, `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval`, log paths. Three `__PLACEHOLDER__`s. |
| `bin/autostart/microviber.service.tmpl` | Create | systemd user unit as data: `ExecStart`, `Restart=always`, `RestartSec=10`, `WantedBy=default.target`. Same placeholders. |
| `daemon/test/microviberd-autostart.test.ts` | Create | Spawns the runner as a subprocess with a controlled `HOME`/`SHELL`/`MICROVIBERD_ROOT`; asserts rendered output, refusals, and absence of side effects. Installs nothing. |
| `docs/architecture-spec.md` | Modify | §5 heading `T1–T17`→`T1–T18`; the "off by default" paragraph's final sentence; new row T18. |
| `docs/functional-spec.md` | Modify | §5: the auto-start paragraph. |
| `README.md` | Modify | Security disclaimer; `bin/microviberd` table row; threat-model link text. |
| `INSTALL.md` | Modify | Step 4.1 wording; new Stage 4.5; Stage 6.1/6.3 prepend `autostart off`. |
| `CLAUDE.md` | Modify | Security rule, commands list, context-docs `T1–T18`. |
| `docs/features/opt-in-autostart/live-test.sh` | Create | The §11.2 macOS checklist as one self-checking script: redacted log, no token on a command line, restores the machine's intended end state. |

**Why a separate template file rather than a heredoc in the runner** (§5): the installed artefact is reviewable as itself, and the test can render it without a service manager present.

---

### Task 1: Test harness + the `run` verb

The foreground verb a service manager calls. Nothing else works without it.

**Files:**
- Create: `daemon/test/microviberd-autostart.test.ts`
- Modify: `bin/microviberd` (header comment, `ROOT` resolution, new `run` verb, usage line)

**Interfaces:**
- Produces: `bin/microviberd run` — foreground, `exec`s node, never returns. `ROOT` honours `MICROVIBERD_ROOT`. Test helper `runner(args, env)` used by every later task's tests.

- [ ] **Step 1: Write the failing test**

Create `daemon/test/microviberd-autostart.test.ts`:

```ts
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
  cpSync(join(REPO, 'bin', 'autostart'), join(root, 'bin', 'autostart'), { recursive: true });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: FAIL — the runner exits 1 with `usage: … {start|stop|restart|status}` because `run` is not a verb yet, so neither `missing .env` nor `npm run build` appears.

- [ ] **Step 3: Add `ROOT` override + the `run` verb**

In `bin/microviberd`, replace the header (lines 1–8) with:

```bash
#!/usr/bin/env bash
# MicroViber daemon runner — OFF BY DEFAULT. Auto-start is an explicit opt-in
# (`autostart on`, spec T18); nothing here installs it implicitly.
# Start it deliberately when you want remote access; stop it when you don't.
#
# Test / escape hatches (not user-facing settings):
#   MICROVIBERD_ROOT     override the resolved repo root
#   MV_AUTOSTART_SHELL   override the login shell baked into the service file
#   autostart print --platform darwin|linux   render without installing
set -euo pipefail

ROOT="${MICROVIBERD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PIDFILE="${TMPDIR:-/tmp}/microviberd.pid"
ENTRY="$ROOT/daemon/dist/index.js"
PWA_ENTRY="$ROOT/pwa/dist/index.html"
```

Add the `run` function after `start()`:

```bash
# Foreground: what a service manager (or a human) invokes. No pidfile, no
# backgrounding, no log redirection — the caller owns stdout/stderr.
run() {
  cd "$ROOT"
  # Unlike legacy start(), run() REQUIRES .env: the daemon cannot start without
  # MV_BIND_ADDRESS, and a service manager would otherwise crash-loop silently.
  [ -f "$ROOT/.env" ] || { echo "missing .env — see INSTALL.md Stage 3" >&2; exit 1; }
  set -a; . "$ROOT/.env"; set +a
  [ -f "$ENTRY" ] && [ -f "$PWA_ENTRY" ] || { echo "build first: npm run build" >&2; exit 1; }
  exec node "$ENTRY"
}
```

Extend the dispatcher:

```bash
case "${1:-status}" in
  start) start ;; stop) stop ;; restart) stop; sleep 1; start ;; status) status ;;
  run) run ;;
  *) echo "usage: $0 {start|stop|restart|status|run}"; exit 1 ;;
esac
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate, then commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add bin/microviberd daemon/test/microviberd-autostart.test.ts
git commit -m "feat(autostart): foreground run verb + MICROVIBERD_ROOT test hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: macOS template + `autostart print` (render core)

The rendering engine and its two guards. `print` is a pure renderer: no platform detection, no manager probe, no writes (§3.1).

**Files:**
- Create: `bin/autostart/com.microviber.daemon.plist.tmpl`
- Modify: `bin/microviberd` (`pick_shell`, `assert_clean_root`, `render_template`, `autostart print`)
- Modify: `daemon/test/microviberd-autostart.test.ts`

**Interfaces:**
- Consumes: `ROOT`, `runner()`, `fakeRoot()` from Task 1.
- Produces: `pick_shell` → shell path on stdout, warning on stderr; `render_template <path>` → rendered text on stdout; `autostart print [--platform darwin|linux]`; template dir `$ROOT/bin/autostart/`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/microviberd-autostart.test.ts`:

```ts
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
```

Add `readFileSync` to the `node:fs` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: FAIL — 7 new failures, all because `autostart` is not a verb (exit 1, usage line).

- [ ] **Step 3: Create the plist template**

Create `bin/autostart/com.microviber.daemon.plist.tmpl`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.microviber.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>__SHELL__</string>
        <string>-il</string>
        <string>-c</string>
        <string>exec __REPO__/bin/microviberd run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>WorkingDirectory</key>
    <string>__REPO__</string>
    <key>StandardOutPath</key>
    <string>__HOME__/.microviber/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME__/.microviber/logs/daemon.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Add the render core to `bin/microviberd`**

Insert after the `ROOT`/`PIDFILE` block:

```bash
TMPL_DIR="$ROOT/bin/autostart"
LOG_DIR="$HOME/.microviber/logs"
LOG_FILE="$LOG_DIR/daemon.log"
LAUNCHD_LABEL="com.microviber.daemon"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
SYSTEMD_UNIT="microviber.service"
SYSTEMD_PATH="$HOME/.config/systemd/user/$SYSTEMD_UNIT"

# The rendered files embed $ROOT inside plist XML and inside a single-quoted
# shell word; a path with whitespace or &<>'" would produce a service that
# fails at load time, so refuse before rendering (spec §4).
assert_clean_root() {
  case "$ROOT" in
    *[[:space:]]*|*'&'*|*'<'*|*'>'*|*"'"*|*'"'*)
      echo "clone MicroViber into a path without spaces or the characters &<>'\"" >&2
      echo "  current path: $ROOT" >&2
      exit 1 ;;
  esac
}

# Echoes the shell to bake into the service file; warns on stderr when it had
# to fall back. MV_AUTOSTART_SHELL is the documented escape hatch and is used
# verbatim — no allowlist check, no warning.
pick_shell() {
  if [ -n "${MV_AUTOSTART_SHELL:-}" ]; then printf '%s' "$MV_AUTOSTART_SHELL"; return; fi
  local sh="${SHELL:-/bin/bash}"
  case "$(basename "$sh")" in
    zsh|bash) printf '%s' "$sh" ;;
    *) printf '%s' "/bin/bash"
       echo "⚠ \$SHELL is $sh; using /bin/bash -il — set MV_AUTOSTART_SHELL=/path/to/shell to override" >&2 ;;
  esac
}

# render_template <template-path> -> rendered text on stdout.
# Bash parameter expansion, never sed: a $ROOT containing | or & cannot corrupt
# the substitution. Any surviving __TOKEN__ is a bug in the template.
render_template() {
  local tmpl="$1" out shell_bin
  [ -f "$tmpl" ] || { echo "missing template: $tmpl" >&2; exit 1; }
  shell_bin="$(pick_shell)"
  out="$(cat "$tmpl")"
  out="${out//__REPO__/$ROOT}"
  out="${out//__SHELL__/$shell_bin}"
  out="${out//__HOME__/$HOME}"
  case "$out" in
    *__[A-Z]*__*) echo "unsubstituted placeholder in $tmpl" >&2; exit 1 ;;
  esac
  printf '%s\n' "$out"
}

template_for() {
  case "$1" in
    darwin) printf '%s' "$TMPL_DIR/$LAUNCHD_LABEL.plist.tmpl" ;;
    linux)  printf '%s' "$TMPL_DIR/$SYSTEMD_UNIT.tmpl" ;;
    *) echo "unknown platform: $1" >&2; exit 1 ;;
  esac
}
```

Add the `autostart` dispatcher (the `on|off|status` arms land in Task 4 — for now they print a "not implemented yet" line so the dispatcher is complete and the test's `print` path is real):

```bash
autostart_print() {
  local plat=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --platform) plat="${2:-}"; shift 2 ;;
      *) echo "usage: $0 autostart print [--platform darwin|linux]" >&2; exit 1 ;;
    esac
  done
  # A pure renderer: no platform detection, no manager probe, no writes — so CI
  # on Linux can render the darwin plist (spec §3.1).
  [ -n "$plat" ] || plat="$(uname -s | tr '[:upper:]' '[:lower:]')"
  assert_clean_root
  render_template "$(template_for "$plat")"
}

autostart() {
  local sub="${1:-status}"; shift || true
  case "$sub" in
    print) autostart_print "$@" ;;
    *) echo "usage: $0 autostart {on|off|status|print}" >&2; exit 1 ;;
  esac
}
```

Extend the dispatcher: `autostart) shift; autostart "$@" ;;` and update the usage line to `{start|stop|restart|status|run|autostart}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: PASS (9 tests on Linux, 10 on macOS — the `plutil` case is skipped off-darwin).

- [ ] **Step 6: Full gate, then commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add bin/microviberd bin/autostart/com.microviber.daemon.plist.tmpl daemon/test/microviberd-autostart.test.ts
git commit -m "feat(autostart): launchd template + autostart print with clone-path and placeholder guards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Linux systemd unit template

**Files:**
- Create: `bin/autostart/microviber.service.tmpl`
- Modify: `daemon/test/microviberd-autostart.test.ts`

**Interfaces:**
- Consumes: `render_template`, `template_for`, `autostart print` from Task 2. No runner change is required — `template_for linux` already points here.

- [ ] **Step 1: Write the failing test**

Append to `daemon/test/microviberd-autostart.test.ts`:

```ts
describe('autostart print — Linux unit', () => {
  it('renders a complete, placeholder-free systemd user unit', () => {
    const r = runner(['autostart', 'print', '--platform', 'linux'], { SHELL: '/bin/bash' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`ExecStart=/bin/bash -il -c 'exec ${REPO}/bin/microviberd run'`);
    expect(r.stdout).toContain(`WorkingDirectory=${REPO}`);
    expect(r.stdout).toContain('Restart=always');
    expect(r.stdout).toContain('RestartSec=10');
    expect(r.stdout).toContain('WantedBy=default.target');
    expect(r.stdout).not.toMatch(/__[A-Z]+__/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts -t 'systemd user unit'`
Expected: FAIL — `missing template: …/microviber.service.tmpl`, exit 1.

- [ ] **Step 3: Create the unit template**

Create `bin/autostart/microviber.service.tmpl`:

```ini
[Unit]
Description=MicroViber daemon (opt-in auto-start; off by default)

[Service]
ExecStart=__SHELL__ -il -c 'exec __REPO__/bin/microviberd run'
WorkingDirectory=__REPO__
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

No `After=network-online.target`: the daemon binds loopback and a user unit cannot order against a system target (§4.2).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: PASS (10 tests on Linux, 11 on macOS).

- [ ] **Step 5: Full gate, then commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add bin/autostart/microviber.service.tmpl daemon/test/microviberd-autostart.test.ts
git commit -m "feat(autostart): systemd --user unit template

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `autostart on|off|status` and manager-driven legacy verbs

The install/uninstall path and the redirect of `start|stop|restart|status`. Only the refuse-before-writing paths are unit-tested (§11.1's "no test installs a service"); the rest is covered by Task 6's live script.

**Files:**
- Modify: `bin/microviberd`
- Modify: `daemon/test/microviberd-autostart.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `platform_quiet` (echoes `darwin`/`linux`/empty, never exits), `require_platform`, `is_managed`, `service_pid`, `autostart_on`, `autostart_off`, `autostart_status`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/microviberd-autostart.test.ts`:

```ts
describe('autostart on — refuses before touching anything', () => {
  it('refuses a root with no build and writes no service file', () => {
    const root = fakeRoot({ env: true });
    const r = runner(['autostart', 'on'], { MICROVIBERD_ROOT: root });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('npm run build');
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
    expect(existsSync(join(home, '.config', 'systemd'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a root with no .env and writes no service file', () => {
    const root = fakeRoot({ build: true });
    const r = runner(['autostart', 'on'], { MICROVIBERD_ROOT: root });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('missing .env');
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('autostart dispatcher', () => {
  it('rejects an unknown subcommand with usage', () => {
    const r = runner(['autostart', 'wat']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('autostart {on|off|status|print}');
  });

  it('lists the new verbs in the top-level usage', () => {
    const r = runner(['bogus']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('autostart');
    expect(r.stdout + r.stderr).toContain('run');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: FAIL — the two `autostart on` cases exit 1 with the *usage* line, not the build/env message.

- [ ] **Step 3: Implement platform detection, install, and status**

Add to `bin/microviberd` after `template_for`:

```bash
# Echoes darwin|linux|"" and never exits — for callers (the legacy verbs) that
# must keep working on a platform with no supported service manager.
platform_quiet() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) systemctl --user show-environment >/dev/null 2>&1 && printf 'linux' || printf '' ;;
    *) printf '' ;;
  esac
}

# Same, but explains and exits for the verbs that need a manager (spec §5:
# applies to on/off/status — never to print).
require_platform() {
  local p; p="$(platform_quiet)"
  if [ -z "$p" ]; then
    case "$(uname -s)" in
      Linux) echo "systemd user session not available — WSL1 or a container?" >&2 ;;
      *) echo "auto-start is not supported on this OS ($(uname -s))" >&2 ;;
    esac
    exit 1
  fi
  printf '%s' "$p"
}

service_path() { case "$1" in darwin) printf '%s' "$LAUNCHD_PLIST" ;; linux) printf '%s' "$SYSTEMD_PATH" ;; esac; }

# "Auto-start is on" == the service file exists at the platform's install path.
is_managed() {
  local p; p="$(platform_quiet)"
  [ -n "$p" ] && [ -f "$(service_path "$p")" ]
}

# Echoes the running service's pid, or nothing.
service_pid() {
  case "$1" in
    darwin) launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null \
              | awk -F' = ' '/^\tpid = /{print $2; exit}' ;;
    linux)  local p; p="$(systemctl --user show -p MainPID --value "$SYSTEMD_UNIT" 2>/dev/null || true)"
            [ "${p:-0}" != "0" ] && printf '%s' "$p" || true ;;
  esac
}

service_exit_info() {
  case "$1" in
    darwin) launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null \
              | awk -F' = ' '/^\tlast exit code = /{print $2; exit}' ;;
    linux)  systemctl --user show -p ExecMainStatus --value "$SYSTEMD_UNIT" 2>/dev/null || true ;;
  esac
}

log_hint() {
  case "$1" in darwin) printf '%s' "$LOG_FILE" ;; linux) printf '%s' "journalctl --user -u microviber" ;; esac
}

autostart_on() {
  local plat; plat="$(require_platform)"
  assert_clean_root
  # (1) refuse before touching the service directory — same checks as run().
  [ -f "$ROOT/.env" ] || { echo "missing .env — see INSTALL.md Stage 3" >&2; exit 1; }
  [ -f "$ENTRY" ] && [ -f "$PWA_ENTRY" ] || { echo "build first: npm run build" >&2; exit 1; }

  # (2) render, then install atomically.
  local dest tmp; dest="$(service_path "$plat")"; tmp="$dest.tmp.$$"
  mkdir -p "$(dirname "$dest")"
  render_template "$(template_for "$plat")" > "$tmp"
  mv -f "$tmp" "$dest"

  # (3) macOS only: the manager appends the daemon's startup output — which
  # includes the pairing URL (T8) — to this file, so make it owner-only BEFORE
  # loading the job. Modes are set unconditionally so a log left readable by an
  # earlier hand-made agent is repaired, not inherited. Linux uses the journal.
  if [ "$plat" = darwin ]; then
    mkdir -p "$LOG_DIR"; : >> "$LOG_FILE"
    chmod 700 "$LOG_DIR"; chmod 600 "$LOG_FILE"
  fi

  # (4) free the port if a legacy pidfile daemon holds it.
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"
    echo "  (stopped the hand-started daemon so the service can take the port)"
  fi

  # (5) load.
  case "$plat" in
    darwin) launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
            launchctl bootstrap "gui/$(id -u)" "$dest" ;;
    linux)  systemctl --user daemon-reload
            systemctl --user enable --now "$SYSTEMD_UNIT" ;;
  esac

  # (6) wait up to 5s for a pid, then report.
  local pid="" i=0
  while [ $i -lt 10 ]; do pid="$(service_pid "$plat")"; [ -n "$pid" ] && break; sleep 0.5; i=$((i + 1)); done

  local mgr; [ "$plat" = darwin ] && mgr=launchd || mgr="systemd --user"
  echo "MicroViber auto-start: ON ($mgr)"
  echo "  Service : $dest"
  echo "  Runs    : $(pick_shell) -il -c 'exec $ROOT/bin/microviberd run'"
  echo "  Log     : $(log_hint "$plat")  (owner-only; contains the pairing URL)"
  echo ""
  echo "⚠ The daemon now runs whenever you are logged in, not only when you start it."
  echo "  Anyone holding BOTH your tailnet access AND the bearer token can drive idle"
  echo "  sessions at any time. Turn this off with: ./bin/microviberd autostart off"
  echo ""
  if [ -n "$pid" ]; then echo "● MicroViber LISTENING (pid $pid)"
  else echo "⚠ service loaded but no pid yet — check $(log_hint "$plat")"; fi
}

autostart_off() {
  local plat; plat="$(require_platform)"
  local dest; dest="$(service_path "$plat")"
  if [ ! -f "$dest" ]; then echo "○ auto-start is already OFF"; exit 0; fi
  case "$plat" in
    darwin) launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true ;;
    linux)  systemctl --user disable --now "$SYSTEMD_UNIT" >/dev/null 2>&1 || true ;;
  esac
  rm -f "$dest"
  [ "$plat" = linux ] && systemctl --user daemon-reload || true
  echo "○ auto-start OFF — daemon stopped. Start by hand with: ./bin/microviberd start"
}

autostart_status() {
  local plat; plat="$(require_platform)"
  local mgr; [ "$plat" = darwin ] && mgr=launchd || mgr="systemd --user"
  if [ ! -f "$(service_path "$plat")" ]; then echo "○ auto-start OFF"; return; fi
  local pid; pid="$(service_pid "$plat")"
  if [ -n "$pid" ]; then echo "● auto-start ON ($mgr, pid $pid)"
  else echo "● auto-start ON ($mgr, not running — last exit code $(service_exit_info "$plat"), see $(log_hint "$plat"))"; fi
}
```

Replace the `autostart()` dispatcher's `*)` arm so the three verbs route:

```bash
autostart() {
  local sub="${1:-status}"; shift || true
  case "$sub" in
    on) autostart_on ;;
    off) autostart_off ;;
    status) autostart_status ;;
    print) autostart_print "$@" ;;
    *) echo "usage: $0 autostart {on|off|status|print}" >&2; exit 1 ;;
  esac
}
```

- [ ] **Step 4: Redirect the legacy verbs when a service is installed**

Add before the dispatcher:

```bash
managed_start() {
  local plat; plat="$(platform_quiet)"
  case "$plat" in
    darwin) launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 \
              && launchctl kickstart "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null \
              || launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" ;;
    linux)  systemctl --user start "$SYSTEMD_UNIT" ;;
  esac
  sleep 1
  echo "● MicroViber LISTENING (pid $(service_pid "$plat"), auto-start on)"
}

managed_stop() {
  local plat; plat="$(platform_quiet)"
  case "$plat" in
    darwin) launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true ;;
    linux)  systemctl --user stop "$SYSTEMD_UNIT" ;;
  esac
  echo "○ MicroViber stopped. Auto-start is still on — it starts again at your next login. To turn that off: ./bin/microviberd autostart off"
}

managed_status() {
  local plat pid; plat="$(platform_quiet)"; pid="$(service_pid "$plat")"
  if [ -n "$pid" ]; then echo "● LISTENING (pid $pid, auto-start on)"; return; fi
  local code; code="$(service_exit_info "$plat")"
  if [ -n "$code" ] && [ "$code" != "0" ]; then
    echo "⚠ not running — crashed with exit code $code; see $(log_hint "$plat")"
  else
    echo "○ not running (auto-start on — starts at next login)"
  fi
}
```

Rewrite the dispatcher:

```bash
case "${1:-status}" in
  start)   if is_managed; then managed_start; else start; fi ;;
  stop)    if is_managed; then managed_stop;  else stop;  fi ;;
  restart) if is_managed; then managed_stop; sleep 1; managed_start; else stop; sleep 1; start; fi ;;
  status)  if is_managed; then managed_status; else status; fi ;;
  run) run ;;
  autostart) shift; autostart "$@" ;;
  *) echo "usage: $0 {start|stop|restart|status|run|autostart {on|off|status|print}}"; exit 1 ;;
esac
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd microviber/daemon && npx vitest run test/microviberd-autostart.test.ts`
Expected: PASS (14 on Linux, 15 on macOS).

- [ ] **Step 6: Verify by hand that nothing was installed**

Run: `ls ~/Library/LaunchAgents/com.microviber.daemon.plist 2>&1; ./bin/microviberd autostart status`
Expected: on a machine that has never run `autostart on`, the `ls` fails and status prints `○ auto-start OFF`. (On the author's laptop the hand-made agent from 2026-09-06 is still present — that is expected and Task 6 supersedes it.)

- [ ] **Step 7: Full gate, then commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add bin/microviberd daemon/test/microviberd-autostart.test.ts
git commit -m "feat(autostart): autostart on/off/status and manager-driven start/stop/restart/status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Documentation and the threat model (T18)

**Files:**
- Modify: `docs/architecture-spec.md`, `docs/functional-spec.md`, `README.md`, `INSTALL.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the command surface from Tasks 1–4. Every command named in the docs must already exist.

- [ ] **Step 1: Architecture spec — §5 heading, the posture sentence, and row T18**

In `docs/architecture-spec.md`:

1. Heading: `## 5. Transport & security (threat model T1–T17)` → `T1–T18`.
2. In the "**Bind-address whitelist, off by default.**" paragraph, keep the bind sentence ending `never 0.0.0.0.` and replace only the final sentence (`It is not a launch agent … chosen use.`) with the §9.2 text.
3. Append row T18 to the threat table, verbatim from spec §9.2.

- [ ] **Step 2: Functional spec, README, CLAUDE.md**

- `docs/functional-spec.md` §5: add the auto-start paragraph from spec §9.3 after the Tailscale paragraph.
- `README.md`: security disclaimer gains the opt-in sentence; the `bin/microviberd` table row becomes `off-by-default start/stop/status runner; opt-in autostart on/off`; the docs link text `threat model (T1–T12)` → `threat model (T1–T18)`.
- `CLAUDE.md`: the security rule gains `(auto-start exists but is strictly opt-in via microviberd autostart on — never enable it implicitly, never install it system-wide/as root)`; the commands section lists `autostart on|off|status`; the context-docs line `threat model T1–T17` → `T1–T18`.

- [ ] **Step 3: INSTALL.md — Step 4.1, new Stage 4.5, Stage 6**

Step 4.1: replace `it is not a launch agent and must not run at boot (spec §9.4)` with `it is off by default; Stage 4.5 (optional) makes it start at login instead`.

Insert after Step 4.4:

````markdown
## Stage 4.5 — Optional: auto-start at login

**Skip this stage** to keep the default posture: the daemon runs only when you
start it. This stage widens the exposure window to your whole logged-in
session — a deliberate, reversible trade (spec T18).

### Step 4.5.1 — Pre-flight the login shell

The service starts the daemon through your login shell so takeover's `claude`
children inherit your terminal's environment. Your rc files must therefore not
block on input or require a TTY. Check exactly what the service will do:

```bash
$SHELL -il -c 'exec ./bin/microviberd run' </dev/null
```

**Verify:** prints `MicroViber daemon listening on …` and `Pair (open on your
phone): …` within a few seconds. Press Ctrl-C. If it hangs or errors, fix the
rc file first — the service will fail the same way.

### Step 4.5.2 — Turn auto-start on

```bash
./bin/microviberd autostart on
```

**Verify:** prints `MicroViber auto-start: ON`, the ⚠ exposure note, and
`● MicroViber LISTENING (pid …)`.

### Step 4.5.3 — Confirm

```bash
./bin/microviberd autostart status
```

**Verify:** `● auto-start ON (launchd, pid …)`.

**Two controls, not one:** `./bin/microviberd stop` stops the daemon now, and
it comes back at your next login. `./bin/microviberd autostart off` removes the
service so it does not.

**Linux note:** the systemd user unit is rendered and CI-tested, but the live
`systemctl --user enable --now` path has not yet been exercised on real
hardware. If you are the first to run it, please report what happened.
````

Stage 6.1 and 6.3: prepend `./bin/microviberd autostart off` (a no-op when off) before the existing `stop`.

- [ ] **Step 4: Verify the docs against the shipped commands**

```bash
cd microviber
grep -n "T1–T18" docs/architecture-spec.md README.md CLAUDE.md
grep -c "autostart" INSTALL.md README.md CLAUDE.md docs/functional-spec.md
./bin/microviberd autostart print --platform darwin >/dev/null && echo "print ok"
```
Expected: the `T1–T18` string in all three files, a non-zero `autostart` count in each doc, and `print ok`.

- [ ] **Step 5: Commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add docs/architecture-spec.md docs/functional-spec.md README.md INSTALL.md CLAUDE.md
git commit -m "docs(autostart): T18, off-by-default posture reworded, INSTALL Stage 4.5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Live macOS verification script

The §11.2 checklist as one self-checking script the user runs; it writes a redacted log the implementer reads. It installs the real service on the author's machine — which is the outcome the user asked for — and leaves auto-start **on** at the end.

**Files:**
- Create: `docs/features/opt-in-autostart/live-test.sh`

**Interfaces:**
- Consumes: every verb from Tasks 1–4.
- Produces: `docs/features/opt-in-autostart/live-test.log` (git-ignored via `*.log`), redacted.

- [ ] **Step 1: Write the script**

Create `docs/features/opt-in-autostart/live-test.sh`, following `docs/features/takeover-race-hardening/stories/story-1-manual-test.sh`'s conventions: `set -u`, a `say`/`pass`/`fail`/`hr` helper set, a `FAILS` counter, a redacted `tee` log, the bearer token read into a header file under `umask 077` and never printed, and a trap that cleans temp files.

Checks, in order (spec §11.2):

1. **Preflight — env parity.** The service's `run` sources the repo-root `.env`, but this machine's hand-made agent used `daemon/.env`. Fail loudly if any `MV_*` key present in `daemon/.env` is missing from `.env`, listing the key names only (never values) — the daemon would otherwise start with a different config than before.
2. **Preflight — login shell.** `"$SHELL" -il -c 'echo MV_SHELL_OK' </dev/null` must print `MV_SHELL_OK` within 20 s.
3. **Baseline.** Record whether a service file already exists and whether anything answers on the port.
4. `autostart on` → stdout contains `auto-start: ON`, the ⚠ line, and `LISTENING`; `autostart status` shows a pid.
5. **Health.** `curl -H "Host: $HOSTHDR" http://127.0.0.1:$MV_PORT/api/health` → 200.
6. **Log modes.** `stat -f '%Lp'` → `700` for `~/.microviber/logs`, `600` for `daemon.log`; the log's tail contains `listening` and `Pair` (assert the *presence* of the pairing line without printing it).
7. **KeepAlive.** `kill <pid>` → a *different* pid appears within 15 s.
8. **stop / start.** `stop` prints the "still on … at your next login" sentence and the port goes quiet; `status` prints `auto-start on`; `start` brings it back.
9. **Login simulation.** `launchctl bootout gui/$UID/com.microviber.daemon; launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.microviber.daemon.plist` → a pid and a 200 health check.
10. **Env inheritance.** `ps -E -o command= -p <pid>` lists `CLAUDE_CODE_USE_VERTEX` and `ANTHROPIC_VERTEX_PROJECT_ID` *names* (grep for the names; never echo the line, which contains the whole environment).
11. **Idempotency.** `autostart on` again → still exactly one pid, still 200.
12. **off.** `autostart off` → plist gone, `launchctl print` fails, port quiet, `autostart status` prints `○ auto-start OFF`.
13. **Restore.** `autostart on` one final time, so the machine ends in the state the user asked for; print the final `autostart status`.

The script must never print the bearer token, the pairing URL, or a full environment line. Redact with `sed -E 's/#token=[^ ]+/#token=<redacted>/'` on anything sourced from the daemon log.

- [ ] **Step 2: Ask the user to run it**

> Run `bash docs/features/opt-in-autostart/live-test.sh` from the microviber repo root and tell me when it finishes. It writes a redacted log I will read; it installs the real launchd agent (superseding the hand-made one from 2026-09-06) and leaves auto-start on.

- [ ] **Step 3: Read the log and fix any failure**

Read `docs/features/opt-in-autostart/live-test.log`. Every `❌` is a defect in Tasks 1–4 — fix it, re-run the gate, and ask for a re-run. Do not proceed with failures outstanding.

- [ ] **Step 4: Commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add docs/features/opt-in-autostart/live-test.sh
git commit -m "test(autostart): live macOS verification script for the §11.2 checklist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the plan

Hand off to `syncounter-code-review` (whole-branch review against `docs/architecture-spec.md` §5/§6 + the new T18), then `create-qa-pr`, which targets `main` for microviber and opens **no** companion Harness PR — this project's docs live entirely in its own repo.

Before any PR, run `git log origin/main..HEAD` and confirm every commit on the branch is this feature's: the checkout is shared with other sessions.

## Self-review

**Spec coverage.** §3.1 commands → Tasks 1, 2, 4. §3.2 managed verbs → Task 4 step 4. §3.3 output → Task 4 step 3. §4 templates + guards → Tasks 2, 3. §5 runner structure → Tasks 1–4. §6 shell selection → Task 2. §7 log modes → Task 4 step 3. §8 failure modes → Task 4 tests (build/env), Task 2 tests (clone path, placeholder), Task 6 (live). §9.2–9.3 spec amendments → Task 5. §10 docs → Task 5. §11.1 tests #1–#8 → Task 1 (#7), Task 2 (#1, #3, #4, #5, #6, #8), Task 3 (#2). §11.2 → Task 6. §12 out-of-scope respected: no daemon/PWA source is touched.

**Placeholders.** None: every step names exact files, exact commands, and exact expected output.

**Consistency.** Names used across tasks match: `assert_clean_root`, `pick_shell`, `render_template`, `template_for`, `platform_quiet`, `require_platform`, `service_path`, `service_pid`, `service_exit_info`, `log_hint`, `is_managed`, `managed_start|stop|status`, `autostart_on|off|status|print`. Test helpers `runner()` and `fakeRoot()` are defined in Task 1 and reused unchanged.

**Known deviation from a literal spec reading.** §11.1 lists eight numbered tests; this plan implements all eight plus four extra safety cases (two `autostart on` refusals, two dispatcher/usage cases) that the spec's §8 failure table requires but did not enumerate as tests.
