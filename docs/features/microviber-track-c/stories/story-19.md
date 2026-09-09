---
id: microviber-track-c-19
title: Start a real Claude session in a PTY, and correlate it back to its session id
status: todo
project: microviber
depends_on: [microviber-track-c-10, microviber-track-c-13]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/65
---

## User Story
As a **developer away from my laptop**, I want **the daemon to start a real Claude session in a folder I choose**, so that **I can begin new work from my phone instead of only continuing sessions I already started at the desk**.

## Acceptance Criteria
1. `POST /api/sessions/new` with `{ cwd }` creates a PTY in that folder running Claude, and returns `{ terminalId, cwd }`.
2. The `cwd` is gated by `listKnownFolders()` (story 12) before any spawn, and returns `403` outside it — the same gate and the same single source as `POST /api/terminals`.
3. The session cap applies: this shares `MV_TERMINAL_MAX_SESSIONS` with plain terminals, since both are PTYs in one registry.
4. **Argv is built server-side**, never accepted from the client, and it is built **wherever story 10 decided Claude's argv lives**. If story 10 chose *widen*, `lib/terminal/` asks the adapter for the invocation rather than assembling `claudeBin` and its flags itself.
5. New sessions start with `--dangerously-skip-permissions`, matching the takeover path and the mode `docs/functional-spec.md` §4 says the user already runs their own sessions under.
6. `GET /api/terminals` resolves `claudeSessionId` from `null` to the real id once Claude has written its session file. The PTY's direct child *is* `claude`, so the pty pid is the pid Claude Code writes into `~/.claude/sessions/<pid>.json`; the daemon matches its registry pid against the discovery result.
7. **That correlation is read through the adapter.** `lib/terminal/` asks `services` for the discovered set and never touches a `~/.claude` path itself — FENCE 2 would flag a literal path there and should (`spec.md` §3.3).
8. **`SessionSummary` gains no field.** Exposing the pid on the wire would be the easier correlation, but T9 makes `SessionSummary` an explicit allowlist. `claudeSessionId` on the terminal record is the narrower surface.
9. If the id never resolves — Claude failed to start, or the folder was not a valid working directory — `claudeSessionId` stays `null` indefinitely and nothing throws. The user sees why in the terminal's own output.
10. An audit-log entry is appended on session creation, carrying the `cwd`, as story 13 does for plain terminals.
11. A test covers the correlation with a fake discovery result: pid matches → id resolves; pid absent → stays `null`.
12. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/api/app.ts` — `POST /api/sessions/new`.
- `daemon/src/schemas/api.ts` — request/response shapes.
- `daemon/src/services/services.ts` — the create path, and the pid→sessionId correlation against the discovered set.
- `daemon/src/lib/terminal/terminal-registry.ts` — carry `claudeSessionId` on the record.
- `daemon/src/lib/claude-adapter/session-manager.ts` — **only if story 10 chose *widen***: export the Claude invocation builder.
- `daemon/test/app.test.ts` — auth, envelope, the 403, the cap.
- `daemon/test/services.test.ts` — correlation resolves and stays null.

## Technical Notes
**Why a real PTY and not the existing headless core.** The daemon already has a spawn-and-own-stdin core (`lib/claude-adapter/session-manager.ts`) that takeover uses, and it would have been the obvious place. It is the wrong mechanism, for a reason the architecture spec already records: finding **F18(2)** — `AskUserQuestion` is hard-disabled in `-p` mode, in subagents too, and no headless variant exposes it, so *"a daemon-owned process can never produce a pending question."* A phone-created headless session could never ask its user anything, making it permanently second-class. A real interactive `claude` in a PTY is an ordinary session, indistinguishable from one started at the laptop.

**The naming problem dissolves — for this path only.** The MVP wanted a `-n <name>` flag so a daemon-created session stayed findable (`docs/features/microviber/findings.md:136`, checkpoint 13.7). A real interactive session earns an `ai-title` from its own transcript exactly like a laptop session, so `discovery.ts`'s existing title resolution handles it and no flag is needed. This closes that item for session creation. It does **not** close it for takeover children, which stay unnamed — out of scope (`spec.md` §8).

**Discovery needs no change at all.** A real `claude` writes its own session file like any other, so `discovery.ts` finds it and `classify.ts` labels it `terminal`.

**A safer alternative was offered and declined.** Because this is a real PTY, permission prompts would for the first time be answerable from the phone, so starting *without* `--dangerously-skip-permissions` would have been strictly safer at no usability cost. Consistency with every other write path won. Recorded in `spec.md` §3.5 and §7 — do not silently revisit it here, and do not silently implement the safer version either.

**Rollout:** additive endpoint. Nothing calls it until story 20. Depends on story 13 for the registry and gate, and on story 10 because AC4 cannot be implemented before that decision exists.

## Manual Test Checklist
- [ ] `story-19-check.sh`: runs the gate, then `POST /api/sessions/new` with a real bearer in a valid folder, polls `GET /api/terminals` until `claudeSessionId` resolves, and prints it alongside `GET /api/sessions` to show the same id appears there. Then the negatives: a `cwd` outside the allowlist (403), and a deliberately invalid `cwd` to show `claudeSessionId` stays `null` without anything throwing. PASS/FAIL per check, and it kills every session it started.
- [ ] No UI in this story — the button is story 20. Nothing to look at in the app.
