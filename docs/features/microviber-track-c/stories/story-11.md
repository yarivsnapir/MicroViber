---
id: microviber-track-c-11
title: A PTY session and registry in lib/terminal, with a bounded ring buffer
status: todo
project: microviber
depends_on: [microviber-track-c-10]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/57
---

## User Story
As a **developer**, I want **the daemon to be able to own a live PTY with bounded memory, a session cap and an idle reaper**, so that **later stories can expose a real terminal over HTTP and a WebSocket without the shell layer being the thing that leaks or misbehaves**.

## Acceptance Criteria
1. `PtySession` represents one live PTY and exposes `write`, `resize`, `kill`, `onData`, `onExit`.
2. It takes an **injected spawner** and imports no PTY library itself, so every test runs against a fake.
3. `node-pty-spawner.ts` is the real `PtySpawner` and is the **only** file in the repo importing `node-pty` — mirroring how `node-spawner.ts` is the only `child_process` importer.
4. The PTY is spawned **without** `detached: true`. Terminals die with the daemon, deliberately: `TerminalRegistry` is in-memory, so a detached survivor would be an unreachable orphan shell — strictly worse than no shell.
5. Output accumulates in a **byte-bounded** ring buffer, 256 KiB per terminal. Not line-bounded: a PTY stream is ANSI escapes interleaved with text, so lines are not a meaningful unit and a line cap would not bound memory.
6. The buffer replays **verbatim** on demand, so a client can reconstruct the visible screen from the escape sequences themselves.
7. A test proves the buffer is bounded: feeding well over 256 KiB leaves the retained size at or under the cap, and the retained bytes are the most recent ones.
8. `TerminalRegistry` is a `Map<terminalId, PtySession>` with create / get / list / close, in-memory, matching `domain/ownership.ts`'s deliberate fail-safe posture.
9. A create beyond `MV_TERMINAL_MAX_SESSIONS` (default 4) is **rejected**, not queued. The rejection surfaces as the domain error later mapped to `FORBIDDEN`.
10. An idle reaper kills a terminal with no client attached for `MV_TERMINAL_IDLE_MINUTES` (default 30). Covered by a test with injected time — no real waiting.
11. Both env vars are parsed and validated in `config.ts` alongside the existing ones, with their defaults.
12. `close` and the reaper are idempotent: killing an already-dead terminal is not an error.
13. Attach bookkeeping supports **one attached client per terminal** — the registry can report whether a terminal has a live client, so story 14 can displace an existing one.
14. Nothing in `lib/terminal/` reads `~/.claude`, references the messaging socket, or constructs Claude's argv. Per story 10's decision, this module owns shells; Claude session creation is story 19's concern and goes wherever story 10 put it.
15. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/lib/terminal/pty-session.ts` — **new.** One live PTY, its ring buffer, injected spawner.
- `daemon/src/lib/terminal/terminal-registry.ts` — **new.** The map, the cap, the reaper, attach bookkeeping.
- `daemon/src/lib/terminal/node-pty-spawner.ts` — **new.** The only `node-pty` importer.
- `daemon/src/config.ts` — `MV_TERMINAL_MAX_SESSIONS`, `MV_TERMINAL_IDLE_MINUTES`.
- `daemon/package.json` — adds `node-pty`.
- `daemon/test/pty-session.test.ts` — **new.** Ring-buffer bounds, replay, exit.
- `daemon/test/terminal-registry.test.ts` — **new.** Cap, reaper with injected time, idempotent close, attach bookkeeping.

## Technical Notes
**Backend-only story with no UI and no routes.** Nothing imports `lib/terminal/` when this ships — it is deliberately dead code until story 13. That is what makes it safe to merge on its own: no live code path changes.

**`node-pty` is a native module.** It compiles against the local Node ABI, so it is the first dependency in this repo that can fail to install rather than just fail to import. Confirm `npm ci` still works from clean, and that the CI `quality` job (which runs `npm ci`) stays green — a prebuilt binary may or may not exist for the runner's platform. If it does not, that is a finding for this story, not a later surprise.

**Deliberately NOT fixing the takeover orphan.** `lib/claude-adapter/node-spawner.ts` sets `detached: true` with no `unref()` and no reattach path, so a daemon restart orphans takeover children (`docs/features/microviber/findings.md:136`, still open). AC4 avoids repeating that for terminals; it does not repair it for takeover. `spec.md` §8 records this.

**Ring buffer sizing.** 256 KiB is per terminal, and `MV_TERMINAL_MAX_SESSIONS` is 4, so the worst case is ~1 MiB of retained output. Record that product next to the constant — architecture-spec.md §6 asks for the measured ceiling beside a cap, not just the cap.

## Manual Test Checklist
- [ ] Package this as `story-11-check.sh` in the shape story-1 established: it runs the gate itself, prints PASS/FAIL per check, and drives a real PTY (`echo hello`, a `resize`, a `kill`, and a >256 KiB flood to show the buffer holding its bound) with the output labelled. There is no UI in this story, so there is nothing to look at in the app — do not hand over a list of commands to type.
- [ ] The script must also prove the native dependency installs from clean, since that is the one thing a unit test cannot: `rm -rf node_modules && npm ci` succeeds.
