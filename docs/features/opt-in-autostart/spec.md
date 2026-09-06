# Opt-in Auto-start — Design Spec

> Status: design approved 2026-09-06 (plain-English walkthrough accepted by the user) · Branch: `feature/opt-in-autostart` (cut from `origin/main` at `8042c5e`, the squash-merge of takeover-race-hardening-1, #46)
> Scope: let a user make the daemon start at login and restart after a crash with one command, and undo it with one command — on macOS (launchd) and Linux (systemd user service). The default stays **off**. Amends `docs/architecture-spec.md` §5 (new row T18), `docs/functional-spec.md` §5, `README.md`, `INSTALL.md`, `CLAUDE.md`, and `bin/microviberd` as listed in §9–§10.

---

## 1. Problem

Today the daemon is started by hand (`./bin/microviberd start`) and dies with the laptop: after a reboot nothing brings it back, so the phone shows a dead app until the user remembers to open a terminal. The spec made this deliberate — "not a launch agent, does not run at boot" (architecture-spec §5) — so the exposure window would be minutes-to-hours of chosen use.

Users who keep the daemon running all day anyway gain nothing from that posture and lose the daemon at every reboot. The author's own laptop needed a hand-written launchd agent on 2026-09-06 to get it back. Two things were learned building that agent, and both shape this design:

1. **A service manager does not load the user's shell environment.** The daemon hands its own environment to every `claude` child it spawns on takeover (`lib/claude-adapter/node-spawner.ts`, `env: { ...process.env }`). On the author's machine Claude Code runs via Vertex, configured by variables exported in `~/.zshrc`, and `node` comes from nvm. A service started with a bare environment mirrors sessions fine but breaks takeover. The service therefore has to start the daemon *through the user's login shell*.
2. **The pairing URL in the startup log carries the bearer token** (T8). A persistent log file written by the service manager must be created readable by the owner only, before the manager first opens it.

## 2. Design in one paragraph

`bin/microviberd` gains a foreground `run` verb and an `autostart on|off|status` verb group. `autostart on` renders a service definition from a template in the repo (a launchd plist on macOS, a systemd user unit on Linux), fills in the clone path, the user's login shell and home, installs it in the user's own service directory, and loads it — starting the daemon now, at every login, and after any crash. The service's only command is `<login shell> -il -c 'exec <repo>/bin/microviberd run'`, so the daemon and its `claude` children see the same environment as a terminal. The existing `start|stop|restart|status` verbs detect the installed service and drive the manager instead of the pid file, so a user never has to learn `launchctl` or `systemctl`. `autostart off` removes the service and stops the daemon. Nothing installs the service implicitly — not the build, not the install runbook, not `start` — and the command that installs it prints the exposure trade-off every time.

## 3. User-facing surface

### 3.1 Commands

| Command | Effect |
|---|---|
| `./bin/microviberd autostart on` | Install + load the service; start the daemon now. Idempotent: re-renders and reloads if already on. Prints the T18 exposure statement (§9.2), then status. |
| `./bin/microviberd autostart off` | Stop the daemon, unload and delete the service. Idempotent: a no-op with a clear message when already off. |
| `./bin/microviberd autostart status` | `● auto-start ON (launchd, pid 1234)` / `● auto-start ON (launchd, not running — last exit code 1, see log)` / `○ auto-start OFF`. |
| `./bin/microviberd autostart print [--platform darwin\|linux]` | Render the service file to stdout **with no side effects**. Exists for tests and for reading what `on` would install. `--platform` defaults to the current OS. |
| `./bin/microviberd run` | Foreground: `cd` to the repo root, source `.env`, check the build, `exec node daemon/dist/index.js`. No pid file, no backgrounding, no log redirection — the caller (a service manager, or a human in a terminal) owns stdout/stderr. |
| `./bin/microviberd start\|stop\|restart\|status` | Unchanged when auto-start is off. When on, see §3.2. |

### 3.2 Behaviour of the existing verbs when auto-start is on

"Auto-start is on" means the service file exists at its install path (§4). The verbs then map to the manager:

| Verb | macOS (launchd) | Linux (systemd --user) | Message |
|---|---|---|---|
| `start` | `launchctl bootstrap` if not loaded, else `launchctl kickstart` | `systemctl --user start microviber.service` | `● MicroViber LISTENING (pid …, auto-start on)` |
| `stop` | `launchctl bootout gui/<uid>/com.microviber.daemon` | `systemctl --user stop microviber.service` | `○ MicroViber stopped. Auto-start is still on — it starts again at your next login. To turn that off: ./bin/microviberd autostart off` |
| `restart` | `launchctl kickstart -k` (bootstrap first if unloaded) | `systemctl --user restart microviber.service` | as `start` |
| `status` | `launchctl print gui/<uid>/com.microviber.daemon` → `pid =` / `last exit code =` | `systemctl --user show -p MainPID,ExecMainStatus,NRestarts` | `● LISTENING (pid …, auto-start on)` / `○ not running (auto-start on — starts at next login)` / `⚠ not running — crashed with exit code N, N restarts; see <log hint>` |

`stop` means "not now"; `autostart off` means "not anymore". This was the user's chosen semantics (walkthrough, 2026-09-06): two orthogonal controls, each printing what it did not do.

### 3.3 What `autostart on` prints

```
MicroViber auto-start: ON (launchd)
  Service : ~/Library/LaunchAgents/com.microviber.daemon.plist
  Runs    : /bin/zsh -il -c 'exec /Users/me/MicroViber/bin/microviberd run'
  Log     : ~/.microviber/logs/daemon.log  (owner-only; contains the pairing URL)

⚠ The daemon now runs whenever you are logged in, not only when you start it.
  Anyone holding BOTH your tailnet access AND the bearer token can drive idle
  sessions at any time. Turn this off with: ./bin/microviberd autostart off

● MicroViber LISTENING (pid 25707)
```

The Linux variant names the unit path and `journalctl --user -u microviber` as the log hint.

## 4. Service definitions

Two templates live in the repo at `bin/autostart/`. The runner substitutes three placeholders with bash parameter expansion (not `sed`, so paths containing `|`, `&`, or spaces survive): `__REPO__` (absolute clone root, resolved from the runner's own location), `__SHELL__` (§6), `__HOME__` (`$HOME`). After substitution the runner asserts no `__[A-Z]+__` token remains and aborts otherwise.

### 4.1 macOS — `bin/autostart/com.microviber.daemon.plist.tmpl`

Installed at `~/Library/LaunchAgents/com.microviber.daemon.plist`, loaded into the `gui/<uid>` domain. Never `/Library/LaunchDaemons`, never root.

| Key | Value | Why |
|---|---|---|
| `Label` | `com.microviber.daemon` | Fixed; `status`/`stop` address the job by it. |
| `ProgramArguments` | `__SHELL__`, `-il`, `-c`, `exec __REPO__/bin/microviberd run` | Login + interactive shell sources the user's rc files, then replaces itself with the runner (§6). |
| `RunAtLoad` | true | Start at login (and immediately on `bootstrap`). |
| `KeepAlive` | true | Restart after a crash or a stray `kill`. |
| `ThrottleInterval` | 10 | launchd's floor between restarts; bounds a crash loop to one attempt per 10 s. |
| `WorkingDirectory` | `__REPO__` | Cosmetic; `run` `cd`s itself. |
| `StandardOutPath` / `StandardErrorPath` | `__HOME__/.microviber/logs/daemon.log` (both) | One file, owner-only (§7). |

The plist contains paths only — no secrets — so its own mode is the default `0644`.

### 4.2 Linux — `bin/autostart/microviber.service.tmpl`

Installed at `~/.config/systemd/user/microviber.service`, enabled for `default.target`. Never a system unit.

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

No `After=network-online.target`: the daemon binds loopback (INSTALL.md Stage 3) and `tailscale serve` fronts it, so there is no network dependency at bind time; user units cannot order against system targets anyway. `loginctl enable-linger` is deliberately **not** recommended — there are no Claude Code sessions before login, so a daemon running before login has nothing to mirror. stdout/stderr go to the user journal (`journalctl --user -u microviber`).

## 5. Runner changes (`bin/microviberd`)

Single bash file, `set -euo pipefail`, no new dependencies. Structure:

- **Platform detection** — `uname -s`: `Darwin` → launchd; `Linux` → systemd, but only if `systemctl --user show-environment` succeeds (otherwise "systemd user session not available — WSL1 or a container?"). Anything else → "auto-start is not supported on this OS".
- **Managed-mode probe** — `is_managed()` is true when the service file exists at the platform's install path. Every legacy verb checks it first.
- **`run`** — `cd "$ROOT"`; `set -a; . ./.env; set +a` (same sourcing the current `start` does; `.env` may carry the `.env.example` trailing comments, which bash tolerates); require `daemon/dist/index.js` and `pwa/dist/index.html` (else `build first: npm run build`, exit 1); `exec node daemon/dist/index.js`.
- **`autostart on`** — (1) refuse without a build or `.env`, with the same messages as `run`; (2) render (§4) to a temp file, install atomically with `mv`; (3) create `~/.microviber/logs/` mode `700` and `daemon.log` mode `600` if absent (macOS only — journald on Linux); (4) if a legacy pid-file daemon is alive, `kill` it and remove the pid file so the port is free; (5) load: macOS `launchctl bootout … 2>/dev/null; launchctl bootstrap gui/<uid> <plist>`; Linux `systemctl --user daemon-reload && systemctl --user enable --now microviber.service`; (6) wait up to 5 s for a pid, then print §3.3.
- **`autostart off`** — unload (`launchctl bootout` / `systemctl --user disable --now`), delete the service file, `systemctl --user daemon-reload` on Linux, print `○ auto-start OFF — daemon stopped. Start by hand with: ./bin/microviberd start`.
- **`autostart status`** / managed `status` — as §3.2, including the crash-loop line derived from `last exit code` (launchd) or `ExecMainStatus`/`NRestarts` (systemd).
- **Test hooks** — `autostart print --platform <os>` renders another platform's file; `MICROVIBERD_ROOT` overrides the resolved repo root; `MV_AUTOSTART_SHELL` overrides the shell (§6). All three are documented in the runner header as test/escape hatches, not user-facing settings.

The runner stays one file: its verbs share the platform probe, the `.env` sourcing, and the status rendering, and a single executable is what INSTALL.md tells users to run. The templates are separate files because they are read as data, are reviewable as the artefact they install, and let the test render them without executing a service manager.

## 6. Environment fidelity — why the login shell

`node-spawner.ts` passes `process.env` through to `claude`. Whatever makes `claude` work in the user's terminal — provider selection (`CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`, Bedrock equivalents), proxies, an nvm-managed `node`, `~/.local/bin` on `PATH` — typically lives in shell rc files, not in `.env`. Verified 2026-09-06 on macOS: `zsh -lc` (login only) exposed none of those variables and resolved `node` to the system binary; `zsh -ilc` (interactive + login) exposed all of them and resolved node via nvm, with no prompt output and a 1.3 s startup, even with stdin at `/dev/null`.

**Shell selection at `autostart on` time:** `$SHELL` if its basename is `zsh` or `bash`; otherwise fall back to `/bin/bash` and print `⚠ $SHELL is <x>; using /bin/bash -il — set MV_AUTOSTART_SHELL=/path/to/shell to override`. The choice is baked into the rendered service file, so changing shells later means re-running `autostart on`.

**Documented caveat (INSTALL Stage 4.5):** the rc files must not wait for input or require a TTY. A user can pre-flight exactly what the service will do with `$SHELL -il -c 'exec ./bin/microviberd run' </dev/null` in a terminal; if that hangs or fails, the service will too.

## 7. Logs and the token (T8)

The daemon prints `Pair (open on your phone): https://<host>/#token=…` at every start. Under `./bin/microviberd start` this already lands in `$TMPDIR/microviberd.log`; under launchd it lands in a persistent file. `autostart on` therefore creates `~/.microviber/logs/` (`700`) and `daemon.log` (`600`) **before** loading the job, so launchd appends to a file that is already owner-only. On Linux the journal is the user's own. No rotation: the daemon runs Fastify with `logger: false`, so the file holds startup lines and errors only. A crash loop appends one error per 10 s, which `status` surfaces as `⚠ crashed with exit code N` so it is noticed, not discovered by disk usage.

## 8. Failure modes

| Situation | Behaviour |
|---|---|
| `autostart on` without a build or `.env` | Refuse before touching the service directory; same message as `run`. |
| Unsupported OS, or Linux without a systemd user session | Refuse with a one-line reason; nothing written. |
| Service already installed (including a hand-made plist with the same label) | `on` overwrites the file and reloads (bootout → bootstrap / daemon-reload → restart). This is how the author's 2026-09-06 hand-made agent gets superseded. |
| A pid-file daemon from legacy `start` is running | `on` kills it first so the service does not hit `EADDRINUSE`. |
| Daemon exits non-zero (bad `.env`, port taken) | Manager restarts every 10 s; `status` reports the exit code and log hint; `autostart off` or fixing `.env` ends the loop. |
| User runs `kill <pid>` | Manager respawns it within 10 s — `status` explains; `stop` is the way to stop. |
| Rc file blocks or prints under `-il` | Daemon never starts; log/journal shows the shell's output; INSTALL caveat (§6) gives the pre-flight command. |
| `autostart off` when already off | `○ auto-start is already OFF`, exit 0. |
| `stop` / `restart` when the plist exists but the job is unloaded (user ran `stop` earlier) | `stop` → already stopped, exit 0; `restart`/`start` → bootstrap. |

## 9. Architecture & Spec Alignment

### 9.1 Where this sits

No daemon code changes. The feature lives entirely in `bin/microviberd`, two templates under `bin/autostart/`, one test file, and docs. It touches no transport, auth, or adapter code — the two-factor posture (§5 of the architecture spec), the bind whitelist, Host/Origin checks, and bearer auth are unchanged. What changes is the **timing** assumption the threat model made: "the exposure window is minutes-to-hours of chosen use" stops being universally true, so it must be stated as a default with an opt-out, and the opt-out must be a modelled threat.

### 9.2 Architecture-spec changes

**§5, paragraph "Bind-address whitelist, off by default"** — replace the last two sentences with:

> It is not started by the build or the install runbook and does not run at boot **by default**: it is started deliberately and stopped when not needed, so the exposure window is minutes-to-hours of chosen use. A user may opt in to auto-start (`./bin/microviberd autostart on`, T18), which widens that window to the whole logged-in session — an informed trade the command prints every time it is made, reversed by one command.

**New threat-model row T18:**

| # | Threat | Mitigation |
|---|---|---|
| **T18** | **Auto-start (opt-in) makes the daemon an always-on-while-logged-in service.** The window is no longer chosen use: anyone holding both factors — tailnet membership and the bearer token — can take over idle sessions whenever the laptop is logged in, with no human having just started the daemon; the daemon also comes back unattended after a crash; and its startup output, which includes the pairing URL (T8), now lands in a persistent log. | Default stays **off**: the service is installed only by an explicit `microviberd autostart on` — never by build, install, or `start` — and that command prints this trade-off on every run. Auto-start changes *when* the daemon runs, not *who* can reach it: same bind whitelist, same Host/Origin/bearer gates, same token-rotation kill switch (T6). `status` and `autostart status` always show the auto-start state; `stop` closes the window at once until next login; `autostart off` removes the service. The service runs as the user, never as root or system-wide. The log directory is created `700` and the log `600` by the runner before the manager first opens it; on Linux the journal is user-scoped. (opt-in-autostart, 2026-09-06) |

Also update the §5 heading `(threat model T1–T17)` → `T1–T18`, and README's "threat model (T1–T12)" link text → `T1–T18`.

### 9.3 Functional-spec change (§5 Install & distribution summary)

Add after the Tailscale paragraph:

> **Auto-start is optional and off by default.** `./bin/microviberd autostart on` makes the daemon start at login and restart after a crash (launchd on macOS, a systemd user service on Linux); `autostart off` reverts it. The daemon is started through the user's login shell so takeover's `claude` children inherit the same environment as a terminal. The trade-off — the daemon is reachable whenever the laptop is logged in — is printed by the command and modelled as T18.

### 9.4 Engineering standards

Nothing in §6 of the architecture spec applies to a bash runner directly; the relevant ones are honoured anyway: **fail closed** (refuse to install without build/`.env`/supported manager; abort on an unsubstituted placeholder), **one place for config** (`run` sources the same `.env` the daemon's `config.ts` validates; the runner adds no config of its own beyond the two test/escape-hatch variables), **testing gate** (the render path is covered by vitest and runs in CI, §11).

## 10. Documentation changes

| File | Change |
|---|---|
| `README.md` | Security disclaimer: "The daemon is **off by default**…" gains "auto-start is a separate, explicit opt-in (`./bin/microviberd autostart on`)". Development table row for `bin/microviberd`: `off-by-default start/stop/status runner; opt-in autostart on/off`. Threat-model link text `T1–T18`. |
| `INSTALL.md` | Step 4.1: replace "it is not a launch agent and must not run at boot (spec §9.4)" with "it is off by default; Stage 4.5 (optional) makes it start at login". New **Stage 4.5 — Optional: auto-start at login** after Step 4.4: 4.5.1 pre-flight `$SHELL -il -c 'exec ./bin/microviberd run' </dev/null` (Verify: prints the two startup lines, then Ctrl-C); 4.5.2 `./bin/microviberd autostart on` (Verify: `MicroViber auto-start: ON` and `● MicroViber LISTENING`); 4.5.3 `./bin/microviberd autostart status`; a note on what `stop` vs `autostart off` mean; Linux note that the path is best-effort until verified live. Stage 6.1/6.3: prepend `./bin/microviberd autostart off` (no-op if off). |
| `CLAUDE.md` (repo) | Security rule "off-by-default startup" → "off-by-default startup (auto-start exists but is strictly opt-in via `microviberd autostart on` — never enable it implicitly, never install it system-wide/as root)". Commands section: mention `autostart on|off|status`. |
| `bin/microviberd` header | "OFF BY DEFAULT (spec §9.4). Never a launch agent." → "OFF BY DEFAULT. Auto-start is an explicit opt-in (`autostart on`, spec T18); nothing here installs it implicitly." |
| `docs/architecture-spec.md`, `docs/functional-spec.md` | As §9.2–9.3. |

## 11. Testing

### 11.1 Automated — `daemon/test/microviberd-autostart.test.ts` (vitest, runs in CI on ubuntu)

Spawns `bash <repo>/bin/microviberd …` with a controlled environment (`HOME` → a temp dir, `SHELL`, `MICROVIBERD_ROOT`, optional `MV_AUTOSTART_SHELL`) and asserts on stdout/stderr/exit code. No test installs a service or needs launchd/systemd.

1. `autostart print --platform darwin` with `SHELL=/bin/zsh` → contains `<string>com.microviber.daemon</string>`, `RunAtLoad`/`KeepAlive` true, `ThrottleInterval` 10, the four `ProgramArguments` strings in order (`/bin/zsh`, `-il`, `-c`, `exec <ROOT>/bin/microviberd run`), both log paths equal to `<HOME>/.microviber/logs/daemon.log`, no `__…__` placeholder, no `0.0.0.0`.
2. `autostart print --platform linux` with `SHELL=/bin/bash` → `ExecStart=/bin/bash -il -c 'exec <ROOT>/bin/microviberd run'`, `Restart=always`, `RestartSec=10`, `WantedBy=default.target`, `WorkingDirectory=<ROOT>`, no placeholder.
3. Shell selection: `SHELL=/usr/bin/fish` → falls back to `/bin/bash` and prints the ⚠ line on stderr; `MV_AUTOSTART_SHELL=/opt/zsh` wins over `$SHELL`.
4. `print` has no side effects: the temp `HOME` contains no `Library/` or `.config/` afterwards.
5. A template containing a token the runner does not know (`MICROVIBERD_ROOT` pointing at a temp copy of the repo whose template carries an extra `__UNKNOWN__`) → non-zero exit and `unsubstituted placeholder` on stderr.
6. macOS only (`process.platform === 'darwin'`, else `it.skip`): the rendered plist passes `plutil -lint -`.
7. `run` with a temp root lacking `.env` → exit 1, message names `.env`; lacking `daemon/dist/index.js` → exit 1, message says `npm run build`.

### 11.2 Manual — macOS, live (the story's checklist)

1. From a clean state (`autostart status` → OFF, `status` → not running): `autostart on` → prints §3.3; `status` shows a pid; `curl -H "Host: $TS_NAME" http://127.0.0.1:8730/api/health` → 200.
2. `ls -la ~/.microviber/logs` → dir `700`, `daemon.log` `600`; log contains the two startup lines.
3. `kill <pid>` → within ~10 s `status` shows a new pid (KeepAlive).
4. `stop` → message about next login; `status` → `○ not running (auto-start on…)`; `start` → running again.
5. Simulate login: `launchctl bootout gui/$UID/com.microviber.daemon; launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.microviber.daemon.plist` → running.
6. Takeover from the phone works (proves the `-il` env inheritance: `ps -E -o command= -p <pid>` lists the Vertex variable names).
7. `autostart on` again → idempotent, still one pid, still listening.
8. `autostart off` → plist gone, `launchctl print` fails, nothing on 8730; legacy `start`/`stop`/`status` behave as before the feature.
9. INSTALL Stage 4.5 executed literally by a fresh Claude session passes every Verify.

### 11.3 Linux — best-effort

The rendered unit is CI-tested (11.1 #2). Live `systemctl --user enable --now` has not been exercised on real hardware; INSTALL says so and asks the first Linux user to report. Not a blocker for this feature.

## 12. Out of scope

- Log rotation (see §7). Start-before-login on Linux (`enable-linger`). Windows/WSL1. A GUI or menu-bar toggle.
- Changing how the daemon itself reads config: it still reads `process.env`, validated once in `config.ts`.
- Any daemon/PWA behaviour change. This is a runner + docs feature.

## 13. Story carving hint (for spec-to-stories)

Two natural stories: **(1)** runner `run` + `autostart` verbs + macOS template + tests 11.1 #1/#3–#7 + all docs changes incl. T18 — verified live per §11.2; **(2)** Linux systemd template + platform probe + test 11.1 #2 + INSTALL Linux notes — best-effort. Story 2 depends on story 1's runner structure. A single story is acceptable if the implementer prefers; the split exists so the verified path can ship first.
