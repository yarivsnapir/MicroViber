---
id: microviber-track-c-10
title: Terminal foundation — the fence rule, a PTY registry, and the routes to drive it
status: todo
project: microviber
depends_on: []
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/56
---

## User Story
As a **developer**, I want **the daemon to own real PTYs and expose bearer-authenticated routes to create, list and kill them**, so that **the phone has something to attach to once the live stream lands**.

## Consolidated
This story is the merge of what were originally stories 10, 11, 12 and 13 (issues [#57](https://github.com/yarivsnapir/MicroViber/issues/57), [#58](https://github.com/yarivsnapir/MicroViber/issues/58), [#59](https://github.com/yarivsnapir/MicroViber/issues/59), now closed into this one).

**Why these four merged.** Stories 12, 13 and 19 all edited the *same five files* — `api/app.ts`, `schemas/api.ts`, `services/services.ts`, `test/app.test.ts`, `test/services.test.ts`. More telling than the file overlap: 12's `listKnownFolders()` existed **only** to be the gate 13 calls and the endpoint the pickers hit, so shipping it alone means merging a function with no caller and an endpoint no UI reads. Story 11's `lib/terminal/` files are disjoint, but 13 exists purely to wire them up — separately they are a registry nobody can reach and routes with nothing behind them. The fence decision (originally story 10) is a reconciliation rather than an open question, so it collapses into AC1–AC5 here.

## Acceptance Criteria

### The fence rule, first and on its own commit
1. `docs/architecture-spec.md` §6's adapter-quarantine clause states explicitly that **spawning the `claude` binary is inside the quarantine**. It currently enumerates `~/.claude` paths, the socket, `peerProtocol` and the transcript vocabulary, and omits spawning — that omission is the defect. `microviber/CLAUDE.md` lines 37–38 **already** state the rule ("Code outside that directory must not read `~/.claude/` or spawn `claude`"), so this is the spec catching up, not a new restriction. Record it dated, in the style of the section's existing amendments.
2. §6 states that `lib/terminal/` may spawn a plain login shell freely — a shell is genuinely not a Claude Code internal — but must ask the adapter for a Claude session. Name the single place Claude's argv is built.
3. `docs/features/microviber-track-c/spec.md` §2.1's "the adapter quarantine does not cover it and FENCE 2 … does not apply" sentence is **corrected to scope it to shells only**, and §3.1 step 4 is reworded so Feature B obtains its invocation from the adapter. Those two passages currently read as licence to build a second spawner.
4. Whether the FENCE 2 lint rule (`eslint.config.js`'s `no-restricted-syntax` selectors) can gain a selector for spawning is decided and recorded. The selectors match only string literals and the call is `spawn(config.claudeBin, …)`, so if a selector is impractical, say so and note that this half stays review-enforced — that gap is how a feature spec came to contradict the rule unnoticed.
5. **AC1–AC4 land as the branch's first commit, before any code.** The review objection was that a feature was exempting itself from a repo-wide rule *while implementing against it*; committing the decision first is what answers it. If a reviewer instead concludes the *narrow* reading is right, that is a change to `CLAUDE.md` as well as §6 — do not settle it in only one document.

### The PTY core
6. `PtySession` represents one live PTY and exposes `write`, `resize`, `kill`, `onData`, `onExit`.
7. It takes an **injected spawner** and imports no PTY library itself, so every test runs against a fake.
8. `node-pty-spawner.ts` is the real `PtySpawner` and the **only** file in the repo importing `node-pty` — mirroring how `node-spawner.ts` is the only `child_process` importer.
9. The PTY is spawned **without** `detached: true`. Terminals die with the daemon, deliberately: `TerminalRegistry` is in-memory, so a detached survivor would be an unreachable orphan shell — strictly worse than no shell.
10. Output accumulates in a **byte-bounded** ring buffer, 256 KiB per terminal. Not line-bounded: a PTY stream is ANSI escapes interleaved with text, so lines are not a meaningful unit and a line cap would not bound memory.
11. The buffer replays **verbatim** on demand, so a client can reconstruct the visible screen from the escape sequences themselves.
12. A test proves the bound: feeding well over 256 KiB leaves the retained size at or under the cap, and the retained bytes are the most recent ones.
13. `TerminalRegistry` is a `Map<terminalId, PtySession>` with create / get / list / close, in-memory, matching `domain/ownership.ts`'s deliberate fail-safe posture.
14. A create beyond `MV_TERMINAL_MAX_SESSIONS` (default 4) is **rejected**, not queued.
15. An idle reaper kills a terminal with no client attached for `MV_TERMINAL_IDLE_MINUTES` (default 30). Tested with injected time — no real waiting.
16. Both env vars are parsed and validated in `config.ts` alongside the existing ones, with their defaults.
17. `close` and the reaper are idempotent: killing an already-dead terminal is not an error.
18. Attach bookkeeping supports **one attached client per terminal** — the registry can report whether a terminal has a live client, so story 14 can displace one.

### The known-folder set
19. `listKnownFolders(): string[]` on the services layer returns every live session's `cwd` **plus** the immediate child directories `lib/webpane/port-resolver.ts` already scans for dev servers.
20. It is **re-derived per request, never cached** — modelled on T14's `listResolvedDevServerPorts()` gate. No new configuration, and no filesystem reach beyond what the Web pane already has: reuse the port resolver's one-level child scan rather than adding a second walker.
21. `GET /api/folders` returns `{ path, name, hasSession }[]` derived from it. `hasSession` is true when the folder is itself a live session's `cwd`, false for a child directory that merely exists.
22. **The route and the spawn gate call the same function**, asserted by a test, so a picker can never offer a folder the gate would reject. Divergence between the two is the defect this exists to prevent.
23. The reader follows T13/T14 discipline, since it walks directories the user's own projects control: `readdirSync` with `withFileTypes`, symlinked entries excluded rather than followed, and a bounded child count.

### The routes
24. `POST /api/terminals` with body `{ cwd }` creates a PTY and returns `{ id, cwd, createdAt }`.
25. **No client-supplied argv, anywhere.** The daemon always runs the user's login shell, built server-side from `config`. A body carrying argv is rejected by the schema, not ignored.
26. `POST` returns `403` when `cwd` is outside `listKnownFolders()`, checked **before** any spawn — assert the ordering in a test rather than trusting reading order.
27. `POST` returns `403` at the session cap.
28. `GET /api/terminals` lists `{ id, cwd, alive, createdAt, claudeSessionId }[]`. `claudeSessionId` is always `null` here; story 19 resolves it.
29. `DELETE /api/terminals/:id` kills and deregisters, and is **idempotent** — `200` on an already-closed id, matching `handback`'s established shape.
30. Every route is bearer-authenticated on the control plane, uses the existing error envelope, and zod-validates its body and response at the boundary.
31. An audit-log entry is appended on terminal creation, carrying the `cwd`. Creating a shell is a write action reachable from the phone.
32. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `docs/architecture-spec.md` — §6 quarantine clause; the T18 row (see notes).
- `docs/features/microviber-track-c/spec.md` — §2.1's fence sentence, §3.1 step 4.
- `eslint.config.js` — only if AC4 finds a workable selector.
- `CLAUDE.md` — only under AC5's narrow-reading branch.
- `daemon/src/lib/terminal/pty-session.ts` — **new.** One live PTY, its ring buffer, injected spawner.
- `daemon/src/lib/terminal/terminal-registry.ts` — **new.** The map, cap, reaper, attach bookkeeping.
- `daemon/src/lib/terminal/node-pty-spawner.ts` — **new.** The only `node-pty` importer.
- `daemon/src/config.ts` — `MV_TERMINAL_MAX_SESSIONS`, `MV_TERMINAL_IDLE_MINUTES`.
- `daemon/package.json` — adds `node-pty`.
- `daemon/src/services/services.ts` — `listKnownFolders()`, the create path, the gate.
- `daemon/src/api/app.ts` — `GET /api/folders` and the three terminal routes.
- `daemon/src/schemas/api.ts` — request/response shapes, including the no-argv rejection.
- `daemon/src/services/audit-log.ts` — the create entry, if the sink needs a new event kind.
- `daemon/test/pty-session.test.ts` — **new.** Ring-buffer bounds, replay, exit.
- `daemon/test/terminal-registry.test.ts` — **new.** Cap, reaper with injected time, idempotent close, attach bookkeeping.
- `daemon/test/services.test.ts` — shared-source assertion, `hasSession`, gate-before-spawn ordering.
- `daemon/test/app.test.ts` — auth, envelope, the 403s, idempotent delete.

## Technical Notes
**Suggested internal order:** the fence docs (AC1–AC5) as commit one, then the PTY core, then `listKnownFolders`, then the routes. Do not start with the routes — they need both the registry and the gate to exist.

**`node-pty` is a native module** and the first dependency here that can fail to *install* rather than just fail to import. Confirm `npm ci` works from clean and that CI's `quality` job stays green; a prebuilt binary may not exist for the runner's platform. If it does not, that is a finding for this story, not a later surprise.

**T18 lands with this story**, because the capability does. Once `POST /api/terminals` exists, arbitrary command execution on the laptop is reachable from the phone **without** the idle gate takeover imposes. `spec.md` §5.1's T18 row states the mitigation set (two-factor tunnel + bearer, daemon off by default, the starting-folder allowlist, the cap, the reaper) and its residual honestly. Add that row to `docs/architecture-spec.md` here.

**What the allowlist bounds, stated honestly.** Where a shell *starts*, not where it can *go* — `cd /` is the first thing anyone can type. A guard against a malformed or hostile `cwd` reaching `spawn`, not a containment boundary, and it must not be described as one in code or docs.

**Why no argv even though it grants nothing.** A client that can type into a shell can already run anything. Accepting argv would move "which binary runs" from a daemon decision to a client decision, weakening the audit trail (`spec.md` §2.3).

**Why `GET /api/folders` rather than reusing what exists.** Both pickers need folders with **no** existing session — a child directory like `studio/` under a workspace-root session is the common case. `GET /api/sessions` cannot supply it (`SessionPicker.tsx` groups session `cwd` values client-side, so by construction only folders that already have a session appear), and `SessionSummary.devServerPorts` lists only folders that resolved a port. `SessionSummary` gains no field — T9 makes it an explicit allowlist.

**Deliberately NOT fixing the takeover orphan.** `lib/claude-adapter/node-spawner.ts` sets `detached: true` with no `unref()` and no reattach path, so a restart orphans takeover children (`docs/features/microviber/findings.md:136`, open). AC9 avoids repeating that for terminals; it does not repair it for takeover (`spec.md` §8).

**Ring buffer ceiling.** 256 KiB per terminal × 4 terminals ≈ 1 MiB retained worst case. Record that product next to the constant — §6 asks for the measured ceiling beside a cap, not just the cap.

**No UI and no stream.** Nothing in the PWA calls any of this when it ships, and a created terminal cannot be typed into until story 14. Purely additive surface, safe to merge alone.

**If this proves unwieldy in review**, the natural cut is to lift the PTY core (AC6–AC18) back out — it is the one block with disjoint files (`lib/terminal/*`, `config.ts`, `package.json`) and no overlap with the route work.

## Manual Test Checklist
- [ ] `story-10-check.sh` in the shape story-1 established: it runs the gate itself and prints PASS/FAIL per check, then exercises everything below. There is **no UI in this story**, so nothing to look at in the app — do not hand over a list of commands to type.
- [ ] The script must cover: a real PTY (`echo hello`, a resize, a kill, a >256 KiB flood showing the buffer holding its bound); `GET /api/folders` printed as a table with `hasSession`, asserting a child directory with no session of its own appears (that row is the whole point of the endpoint); and the full route surface — create in a valid folder, create in `/etc` (403), create past the cap (403), create with argv in the body (schema rejection), list, delete, delete again (200), unauthenticated (401 envelope). It cleans up every terminal it made.
- [ ] It must also prove the native dependency installs from clean, which no unit test can: `rm -rf node_modules && npm ci` succeeds.
