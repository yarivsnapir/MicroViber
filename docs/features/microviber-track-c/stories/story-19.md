---
id: microviber-track-c-19
title: New Claude session from the phone — create it in a PTY, then jump to it
status: todo
project: microviber
depends_on: [microviber-track-c-15]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/65
---

## User Story
As a **developer away from my laptop**, I want **to start a new Claude session in a folder I choose and land in it once it is ready**, so that **I can begin new work from my phone instead of only continuing sessions I already started at the desk**.

## Consolidated
This story is the merge of what were originally stories 19 and 20 (issue [#66](https://github.com/yarivsnapir/MicroViber/issues/66), now closed into this one).

**Why these two merged.** This is the whole of Feature B, and it is a single user-facing action: tap **New session**, pick a folder, watch Claude boot, jump into it. Split, the backend half is an endpoint nothing calls and the frontend half cannot exist without it — there is no rollout benefit to shipping them apart, since the daemon and PWA go out in one PR. Keeping them together also means the vertical slice is manually testable in the running app, which the backend half alone is not.

## Acceptance Criteria

### Creating the session
1. `POST /api/sessions/new` with `{ cwd }` creates a PTY in that folder running Claude, and returns `{ terminalId, cwd }`.
2. The `cwd` is gated by `listKnownFolders()` (story 10) before any spawn, returning `403` outside it — the same gate and the same single source as `POST /api/terminals`.
3. The session cap applies: this shares `MV_TERMINAL_MAX_SESSIONS` with plain terminals, since both are PTYs in one registry.
4. **Argv is built server-side**, never accepted from the client, and it is built **where story 10's fence decision put it** — under the expected *widen* outcome, `lib/terminal/` asks the adapter for the invocation rather than assembling `claudeBin` and its flags itself.
5. New sessions start with `--dangerously-skip-permissions`, matching the takeover path and the mode `docs/functional-spec.md` §4 says the user already runs their own sessions under.
6. An audit-log entry is appended on creation, carrying the `cwd`, as story 10 does for plain terminals.

### Correlating it back
7. `GET /api/terminals` resolves `claudeSessionId` from `null` to the real id once Claude has written its session file. The PTY's direct child *is* `claude`, so the pty pid is the pid Claude Code writes into `~/.claude/sessions/<pid>.json`; the daemon matches its registry pid against the discovery result.
8. **That correlation is read through the adapter.** `lib/terminal/` asks `services` for the discovered set and never touches a `~/.claude` path itself — FENCE 2 would flag a literal path there and should (`spec.md` §3.3).
9. **`SessionSummary` gains no field.** Exposing the pid on the wire would be the easier correlation, but T9 makes `SessionSummary` an explicit allowlist. `claudeSessionId` on the terminal record is the narrower surface.
10. If the id never resolves — Claude failed to start, or the folder was not a valid working directory — it stays `null` indefinitely and nothing throws.
11. A test covers the correlation against a fake discovery result: pid matches → id resolves; pid absent → stays `null`.

### The flow on the phone
12. The Claude pane's session picker gains a **New session** row.
13. Tapping it shows the **same known-folder list** story 15's terminal dropdown uses — the same `GET /api/folders` data and the same in-place two-level swap, not a parallel picker.
14. Picking a folder calls `POST /api/sessions/new`, then the PWA **switches to the Terminal pane**, so the user watches Claude boot rather than staring at a spinner.
15. The PWA polls `GET /api/terminals` **on its existing session-poll cadence** until `claudeSessionId` resolves. **No new polling loop is introduced** — reuse the loop already running.
16. Once resolved, the terminal header offers a **one-tap jump** to the Claude pane, focused on **that** session specifically — not merely the pane's last selection.
17. If the id never resolves, the header **simply never offers the jump**. No error toast, no retry prompt — the user sees why in the terminal itself, in Claude's own output, which is more informative than anything the PWA could synthesise.
18. Hitting the session cap surfaces the `403` as a readable message.
19. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/api/app.ts` — `POST /api/sessions/new`.
- `daemon/src/schemas/api.ts` — request/response shapes.
- `daemon/src/services/services.ts` — the create path, and the pid→sessionId correlation against the discovered set.
- `daemon/src/lib/terminal/terminal-registry.ts` — carry `claudeSessionId` on the record.
- `daemon/src/lib/claude-adapter/session-manager.ts` — export the Claude invocation builder (under story 10's *widen* outcome).
- `daemon/test/app.test.ts` — auth, envelope, the 403, the cap.
- `daemon/test/services.test.ts` — correlation resolves and stays null.
- `pwa/src/components/SessionPicker.tsx` — the **New session** row and the folder view.
- `pwa/src/components/TerminalPane.tsx` — the conditional jump affordance in the header.
- `pwa/src/App.tsx` — the pane switch on create, the session focus on jump, threading `claudeSessionId` off the existing poll.
- `pwa/src/lib/api.ts` — `createSession`.
- `pwa/test/session-picker.test.tsx` — the new row, the folder view.
- `pwa/test/terminal-pane.test.tsx` — jump appears on resolve, stays absent when it never resolves.

## Technical Notes
**Why a real PTY and not the existing headless core.** The daemon already has a spawn-and-own-stdin core (`lib/claude-adapter/session-manager.ts`) that takeover uses, and it would have been the obvious place. It is the wrong mechanism, for a reason the architecture spec already records: finding **F18(2)** — `AskUserQuestion` is hard-disabled in `-p` mode, in subagents too, and no headless variant exposes it, so *"a daemon-owned process can never produce a pending question."* A phone-created headless session could never ask its user anything, making it permanently second-class. A real interactive `claude` in a PTY is an ordinary session, indistinguishable from one started at the laptop.

**The naming problem dissolves — for this path only.** The MVP wanted a `-n <name>` flag so a daemon-created session stayed findable (`docs/features/microviber/findings.md:136`, checkpoint 13.7). A real interactive session earns an `ai-title` from its own transcript exactly like a laptop session, so `discovery.ts`'s existing title resolution handles it and no flag is needed. This closes that item for session creation. It does **not** close it for takeover children, which stay unnamed — out of scope (`spec.md` §8).

**Discovery needs no change at all.** A real `claude` writes its own session file like any other, so `discovery.ts` finds it and `classify.ts` labels it `terminal`.

**A safer alternative was offered and declined.** Because this is a real PTY, permission prompts would for the first time be answerable from the phone, so starting *without* `--dangerously-skip-permissions` would have been strictly safer at no usability cost. Consistency with every other write path won. Recorded in `spec.md` §3.5 and §7 — do not silently revisit it, and do not silently implement the safer version either.

**Reuse the existing poll — AC15 is a requirement, not an optimisation.** `App.tsx` already polls sessions on a cadence and `GET /api/terminals` is cheap. Issue [#48](https://github.com/yarivsnapir/MicroViber/issues/48) already tracks the notify loop and the PWA poll each running their own full scan; do not add a fourth thing to that pile for one transition.

**The picker's folder view is shared with story 15's dropdown, not copied.** Both need "the known-folder list, in place, with a back row". If story 15's implementation is not reusable as-is, factor it out here rather than writing a second one — two folder pickers that can drift is exactly the divergence story 10's shared-source rule prevents, one layer up.

**Silence is the designed failure mode (AC17).** Claude failing to start is visible in the PTY output, in Claude's own words. A PWA-level error message would be a worse, second-hand account of something the user is already looking at.

**Rollout:** last story in the track. `depends_on` is story 15 rather than story 10 directly, because 15 already depends on 14 which depends on 10 — and this story needs 15's Terminal pane to land on and its folder view to reuse.

## Manual Test Checklist
- [ ] `story-19-check.sh`: runs the gate with PASS/FAIL, then exercises the backend — `POST /api/sessions/new` in a valid folder with a real bearer (from the token file, never printed), polling `GET /api/terminals` until `claudeSessionId` resolves and printing it beside `GET /api/sessions` to show the same id appears there. Plus the negatives: a `cwd` outside the allowlist (403), the cap (403), and a deliberately invalid `cwd` showing `claudeSessionId` stays `null` without anything throwing. It kills every session it started. Then it starts the daemon and prints the phone URL.
- [ ] On the phone: open the session picker, tap **New session**, pick a folder with no existing session. Confirm you land on the Terminal pane and can watch Claude start up.
- [ ] Wait. Confirm the header offers a jump once Claude is ready, and that tapping it lands you in the Claude pane **on that new session** — check the folder and title, not just that the pane changed.
- [ ] Send it a prompt from the composer and confirm it behaves like any other session, **including that an `AskUserQuestion` card can appear**. That is the entire reason this is a PTY and not a headless process (F18(2) above), so it is the check that matters most.
- [ ] Pick a folder where Claude cannot start, and confirm the jump never appears and nothing errors — you just see why in the terminal.
