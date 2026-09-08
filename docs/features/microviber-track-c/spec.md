# MicroViber Track C — Design Spec

> **Date:** 2026-09-06
> **Status:** design approved, pending story breakdown
> **Predecessors:** `docs/features/microviber/spec.md` (MVP), `docs/features/microviber-track-b/spec.md` (Track B), `docs/features/askuserquestion-answer-mechanism/spec.md`
> **Judged against:** `docs/architecture-spec.md` (threat model T1–T16, engineering standards §6) and `docs/functional-spec.md` (§3 UX flows doubles as the UI/UX reference — the registry `UIUX_SPEC` entry for this project is `none`).

---

## 1. Overview

Three capabilities, requested together, bundled into one track because two of
them share a single new mechanism and the third is independent but small enough
not to warrant its own track.

| # | Feature | Depends on |
|---|---|---|
| **A** | **Terminal pane** — a real interactive PTY on the laptop, driven from the phone. | Nothing (introduces the mechanism) |
| **B** | **New Claude session** — one tap picks a folder and starts a genuine `claude` session in it. | Feature A's PTY |
| **C** | **Transcript parity** — make the phone's transcript actually look like the Claude Code VS Code extension, as `docs/functional-spec.md` §3 already claims it does. | Nothing |

Features A and B are genuinely coupled: B is a thin affordance over A's PTY and
is close to free once A exists. Feature C shares no code with either and can
ship in any order.

**Guidance for story breakdown.** Treat this as two independent clusters, not
one sequence. A then B is a hard ordering — B cannot start before A's PTY and
`GET /api/folders` exist. C is a separate cluster with its own internal ordering
(the daemon normalizer in §4.1 before the renderer in §4.2, because the renderer
consumes data the normalizer does not yet send) and no dependency on A or B in
either direction. The two clusters can be worked in parallel or in either order.

### What changed the shape of this work

Feature C was requested as a formatting complaint. Investigation found it is not
a styling job. The daemon's transcript normalizer
(`daemon/src/lib/claude-adapter/tail.ts`) discards data before it reaches the
phone, and several of the user-visible symptoms trace directly to that. §4
enumerates each defect with its observable symptom. Any renderer work done
without first widening the wire would be cosmetic and would not fix the reported
problems.

### Thesis check — an honest scope note

`docs/functional-spec.md` §1 states a non-goal: *"Not a Claude Code replacement
or a general mobile IDE. No file tree, no diff review, no git UI."* Feature A
puts a shell on the phone and Feature C renders diffs. Both brush against that
sentence.

The position this spec takes, deliberately and with the tradeoff stated rather
than glossed:

- **The terminal is a genuine scope expansion.** MicroViber's stated thesis is
  micro-moments — glance, prompt, put the phone away. A shell is not that. It is
  accepted as a deliberate widening of the product's character, chosen by the
  user with the alternatives on the table, not an accident of feature creep.
  §7's decision table records it.
- **Diff rendering is not a diff *review* UI.** It displays what the agent
  already did, inside the transcript, the same way the extension does. There is
  no staging, no accept/reject, no navigation between files. The non-goal stands.

`docs/functional-spec.md` §1's non-goal list is amended by this track to reflect
the terminal, so the spec stops asserting something that is no longer true.

---

## 2. Feature A — Terminal pane

A real PTY. Not a one-shot command runner and not a pipe-backed shell: ANSI
colors, `Ctrl-C`, arrow keys, `vim`, and interactive prompts all work, because
anything less is a terminal that fails at the moment you need it.

### 2.1 Daemon — a new `lib/terminal/` module

A sibling of `lib/webpane/`, not a member of `lib/claude-adapter/`. A shell is
not a Claude Code internal, so the adapter quarantine does not cover it and
FENCE 2 (the `~/.claude` path lint rule) does not apply. This mirrors exactly
the precedent `lib/webpane/` set in microviber-track-b-2.

| File | Responsibility |
|---|---|
| `pty-session.ts` | `PtySession` — one live PTY. Owns its ring buffer, exposes `write`, `resize`, `kill`, `onData`, `onExit`. No I/O library import; takes an injected spawner. |
| `terminal-registry.ts` | `TerminalRegistry` — `Map<terminalId, PtySession>`, create/get/list/close, the idle reaper, and the session cap. In-memory, matching `domain/ownership.ts`'s deliberate fail-safe. |
| `node-pty-spawner.ts` | The real `PtySpawner` over `node-pty`. **The only file in the repo that imports `node-pty`**, mirroring how `node-spawner.ts` is the only file that imports `node:child_process` for the adapter. Everything else tests against a fake. |

**Ring buffer, bounded by bytes not lines.** A PTY stream is ANSI escape
sequences interleaved with text, so "lines" are not a meaningful unit and a
line cap would not bound memory. The buffer is a fixed byte cap (256 KiB per
terminal). On reattach the buffer is replayed verbatim, which is what restores
the visible screen — xterm.js reconstructs state from the escape sequences
themselves.

**Lifecycle — survives disconnects, dies with the daemon.**

| Event | What happens |
|---|---|
| Phone locks, app backgrounds, tunnel drops | PTY keeps running. Output accumulates in the ring buffer. Reopening the pane reattaches and replays. |
| User taps Close | PTY is killed, registry entry removed. |
| No client attached for `MV_TERMINAL_IDLE_MINUTES` (default 30) | Reaper kills it. Prevents abandoned shells accumulating. |
| Daemon restarts | Terminals die with it. |

The last row is a deliberate choice, and it is why the PTY is spawned **without**
`detached: true` — the opposite of `node-spawner.ts`, on purpose. `TerminalRegistry`
is in-memory, so a detached survivor would be an orphan shell nobody can reach
or kill, which is strictly worse than no shell. The daemon already has this
exact unresolved problem for takeover children (`node-spawner.ts` sets
`detached: true` with no `unref()` and no reattach path; `docs/features/microviber/findings.md:136`
still carries it as open). This track does not repeat that mistake for terminals
and does not attempt to fix it for takeover either — see §8.

**Concurrency cap.** `MV_TERMINAL_MAX_SESSIONS`, default 4. A create request
beyond the cap is rejected `FORBIDDEN`, not silently queued.

**One attached client per terminal.** A terminal accepts a single live socket at
a time. A second attach to the same id displaces the first, which is closed with
a WebSocket close frame carrying an explicit reason string — the protocol's own
close mechanism, not a fifth kind in the JSON frame table below — rather than
dropped silently. MicroViber is a
single-user tool (`docs/functional-spec.md` §5), so multiplexing two views onto
one PTY would add reconciliation complexity for a case that does not arise. The
attached client owns the PTY's dimensions: its `resize` frames set the size, and
on displacement the new client's dimensions win.

### 2.2 Transport — the control-plane WebSocket finally lands

A PTY needs a live bidirectional stream. Today the control plane has none:
`app.ts:568` refuses every main-origin upgrade, `pwa/src/lib/api.ts`'s
`openStream` is defined and never called, and `daemon/package.json` has no
WebSocket dependency at all. The two building blocks written for this —
`api/ws/authorize.ts`'s `authorizeUpgrade` and `api/ws/hub.ts`'s `Hub` — are
imported only by a test.

Feature A registers a real `/ws` upgrade handler on the control plane and wires
`authorizeUpgrade` to it. That function was written for threat T5 and has never
been exercised in production; this is what it was for.

**The upgrade gate**, in order, before any PTY is attached:

1. Host allowlist (T3) → refuse `421`.
2. Host port **is** the control port. The content-plane splice at `app.ts:557`
   keeps its own path and is untouched; the two handlers must not overlap.
3. `Origin` equals the control origin (T5). CORS never covers sockets, and
   browsers always send `Origin` on a WS handshake, so strict equality is safe
   here — the same reasoning the content-plane splice already relies on.
4. Bearer token, carried in `Sec-WebSocket-Protocol` as `pwa/src/lib/api.ts`
   already does → refuse `401`.
5. `?terminal=<id>` resolves to a live registry entry → refuse `404`.

**The refusal at `app.ts:568` narrows rather than disappears.** It currently
rejects all main-origin upgrades wholesale. It becomes: reject unless the path
is `/ws` and the gate above passes. Every other main-origin upgrade stays
refused.

**Frame protocol.** JSON, zod-validated at the boundary like every other input
in this repo, because resize has to be multiplexed onto the same socket and a
raw byte pipe cannot carry it.

| Direction | Frame |
|---|---|
| client → daemon | `{ t: 'in', d: string }` — keystrokes |
| client → daemon | `{ t: 'resize', cols: number, rows: number }` |
| daemon → client | `{ t: 'out', d: string }` — PTY output |
| daemon → client | `{ t: 'exit', code: number \| null }` |

Inbound frames are capped at 64 KiB, the same discipline as the content plane's
10 MB request-body cap. An oversized or schema-invalid frame closes the socket
rather than being ignored, per the fail-closed standard.

### 2.3 Routes

All bearer-authenticated on the control plane, all using the existing error
envelope.

| Route | Method | Purpose |
|---|---|---|
| `/api/terminals` | POST | Create a PTY. Body `{ cwd }`. **No client-supplied argv** — the daemon always runs the user's login shell. Returns `{ id, cwd, createdAt }`. `403` if `cwd` is outside the known-folder allowlist or the session cap is reached. |
| `/api/terminals` | GET | List open terminals: `{ id, cwd, alive, createdAt, claudeSessionId }[]`. |
| `/api/terminals/:id` | DELETE | Kill and deregister. Idempotent, returning `200` on an already-closed id — matching `handback`'s established shape. |
| `/api/folders` | GET | The known-folder set the two pickers render: `{ path, name, hasSession }[]`. See §2.4. |
| `/api/sessions/new` | POST | Feature B. See §3. |
| `/ws?terminal=<id>` | GET (upgrade) | Attach. |

**No client-supplied argv, anywhere.** A client that can type into a shell can
already run anything, so accepting an argv would grant no new capability — but
it would move "which binary runs" from a daemon decision to a client decision,
which makes the audit trail weaker and the route harder to reason about. Both
create paths build their argv server-side from `config`.

### 2.4 Folder allowlist

A terminal's **starting** directory must be one the daemon already knows: every
live session's `cwd`, plus the immediate child directories `lib/webpane/port-resolver.ts`
already scans for dev servers. No new configuration and no filesystem reach
beyond what the Web pane already has.

This is deliberately modelled on T14's `listResolvedDevServerPorts()` gate: a
new `listKnownFolders(): string[]` on the services layer, re-derived per request
rather than cached, and checked before any spawn.

**The same set is what the pickers render, and that is not incidental.** Both
Feature A's terminal dropdown and Feature B's session-creation picker need
folders that have **no** existing session — a child directory like `studio/`
under a workspace-root session is the common case, and it is exactly what the
port resolver's one-level child scan already finds. `GET /api/sessions` cannot
supply that: `SessionPicker.tsx`'s existing "Browse by folder" view groups
session `cwd` values client-side and by construction can only show folders that
already have a session. `SessionSummary.devServerPorts` is no better, since it
lists only folders that resolved a port.

`GET /api/folders` therefore returns `{ path, name, hasSession }[]` derived from
`listKnownFolders()` — **the same function the spawn gate calls**, so the UI can
never offer a folder the gate would then reject. Divergence between the two
would produce a picker whose rows fail with `403`, which is why they share one
source rather than two.

**What this does and does not bound, stated plainly.** It bounds where a shell
*starts*. It does not bound where it can *go* — the first thing anyone can type
is `cd /`. The allowlist is a guard against a malformed or hostile `cwd` value
reaching `spawn`, not a containment boundary. Claiming otherwise would be
security theatre. See T18.

### 2.5 PWA

**The pane switch goes from two tabs to three:** Claude, Terminal, Web.
`App.tsx`'s `pane` state widens from `'claude' | 'web'` to include `'terminal'`.

`components/TerminalPane.tsx` holds an `@xterm/xterm` instance with
`@xterm/addon-fit`, plus the WebSocket client. Its chrome deliberately reuses
the Web pane's established idiom rather than inventing a new one: a persistent
header showing the current terminal's folder, with the same `CaretButton` used
by both the Web pane's address bar and the session picker. The dropdown's
default view lists the open terminals plus a single "New terminal" row; tapping
that row swaps the same panel in place to the known-folder list, with a back
row. This is the two-level in-place swap the session picker already uses for
"Browse by folder", not a second sheet.

**Accessory key row.** A phone keyboard cannot produce `Ctrl`, `Esc`, `Tab`, or
arrow keys, and a PTY without them is unusable. A single row above the keyboard
supplies `Esc`, `Tab`, a sticky `Ctrl` modifier, the four arrows, and a
dedicated `Ctrl-C` because it is the one people reach for most. This is new UI
with no precedent in the app; §6 records it as a deliberate deviation from the
minimalism rule.

**Reattach on mount.** The last-attached terminal id is remembered in
`localStorage` under `mv_terminal_last`, mirroring the Web pane's existing
`mv_webpane_last`. Reopening the pane reattaches to it if it is still alive, and
falls back to the folder picker if it is not.

**Highlighting and CSP.** xterm.js is pure JavaScript with no `eval` and no
WebAssembly, so the PWA's existing `script-src 'self'` needs no change.
`connect-src` already permits `ws:` and `wss:`. No CSP modification is required
by this feature, which is a hard requirement given T7.

---

## 3. Feature B — New Claude session from the phone

The MVP spec deferred this as Phase 2 item 7
(`docs/features/microviber/spec.md:125`), naming three blockers: where the
process is parented, how it is named so it stays findable, and what happens when
the phone disconnects. Feature A's PTY answers all three, which is why this
feature is now thin.

### 3.1 Flow

1. The Claude pane's session picker gains a **New session** row.
2. Tapping it shows the same known-folder list Feature A uses.
3. Picking a folder calls `POST /api/sessions/new` with `{ cwd }`.
4. The daemon creates a PTY in that folder running
   `<config.claudeBin> --dangerously-skip-permissions`, and returns
   `{ terminalId, cwd }`.
5. The PWA switches to the Terminal pane, so the user watches Claude boot.
6. The PWA polls `GET /api/terminals` on its existing session-poll cadence until
   that terminal's `claudeSessionId` resolves from `null`. It then offers a
   one-tap jump in the terminal header to the Claude pane, focused on the new
   session. No new polling loop is introduced. If the id never resolves — Claude
   failed to start, the folder was not a valid working directory — the header
   simply never offers the jump, and the user sees why in the terminal itself.

### 3.2 Why a real PTY and not the existing headless core

The daemon already has a spawn-and-own-stdin core
(`daemon/src/lib/claude-adapter/session-manager.ts`) that takeover uses. It
would have been the obvious place to build this. It is the wrong mechanism here,
for a reason recorded in the architecture spec itself.

Finding **F18(2)** (`docs/architecture-spec.md:72`): `AskUserQuestion` is
hard-disabled in `-p` mode, in subagents as well, and no headless variant exposes
it. *"a daemon-owned process can never produce a pending question."* A
phone-created headless session could therefore never ask its user anything —
permanently a second-class session.

A real interactive `claude` inside a PTY has none of that. It is an ordinary
terminal-hosted session, indistinguishable from one started at the laptop.

### 3.3 Discovery and correlation

A real `claude` writes its own `~/.claude/sessions/<pid>.json` like any other
session, so `discovery.ts` finds it with no special handling and `classify.ts`
labels it `terminal`. Nothing about the discovery path changes.

**Correlating the PTY to its Claude session id.** The PTY's direct child *is*
`claude`, so the pty pid is the pid Claude Code writes into its own session
file. The daemon matches its `TerminalRegistry` pid against the discovery
result and surfaces the resolved id as `claudeSessionId` on
`GET /api/terminals`.

That correlation must be read **through the adapter**, not by touching
`~/.claude` from `lib/terminal/`. FENCE 2 would flag a literal path there and
should — `lib/terminal/` asks `services` for the discovered set, exactly as
`lib/webpane/` does today.

**`SessionSummary` gains no field.** Exposing the pid on the wire would be the
easier correlation, but T9 makes `SessionSummary` an explicit allowlist and the
correlation can be done daemon-side instead. `claudeSessionId` on the terminal
record is the narrower surface.

### 3.4 The naming problem dissolves

The MVP's open item wanted a `-n <name>` flag so a daemon-created session would
stay findable in discovery (`docs/features/microviber/findings.md:136`,
checkpoint 13.7). A real interactive session earns an `ai-title` from its own
transcript exactly like a laptop session, so `discovery.ts`'s existing title
resolution handles it and no naming flag is needed. This closes that item for
the session-creation path. It does **not** close it for takeover children, which
remain unnamed — out of scope, see §8.

### 3.5 Permission mode

New sessions start with `--dangerously-skip-permissions`, matching the takeover
path and matching the mode `docs/functional-spec.md` §4 says the user already
runs their own sessions under.

An alternative was available and was considered: because this is a real PTY,
permission prompts would for the first time be answerable from the phone, so
starting *without* the skip flag would have been strictly safer at no usability
cost. It was offered and declined in favour of consistency with every other
write path. Recorded in §7.

---

## 4. Feature C — Transcript parity

`docs/functional-spec.md` §3 already asserts the transcript *"Matches the Claude
Code VS Code extension's own rendering, deliberately."* It does not. This
feature closes the gap between that claim and the code.

### 4.1 The daemon is losing data — fix this layer first

Every defect below is in `daemon/src/lib/claude-adapter/tail.ts`, and each has a
symptom the user can already see.

| Defect | Cause | Symptom on the phone |
|---|---|---|
| `tool_result` is not modelled | `normalizeContent` recognises only `text` and `tool_use` blocks, so a `tool_result` line yields `text: ''` | **Every** non-`AskUserQuestion` tool result renders as an empty grey bordered box |
| `thinking` blocks match no branch | Same cause — a thinking block is neither `text` nor `tool_use` | An empty gutter row: a bullet with nothing beside it |
| Prose plus a tool call in one message | `if (blocks.tool) return { kind: 'tool', ... }` returns before the prose is used | The assistant's explanation vanishes; only the tool line survives |
| Several tool calls in one message | `blocks.tool` is reassigned in the loop | Only the last tool call is shown; the rest are silently dropped |
| Tool input reduced to one 120-char scalar | `summarizeToolInput` returns the first matching key and discards the rest | An `Edit` shows only its file path. Diffs cannot be rendered because the payload never crosses the wire |
| `injected` hardcoded `false` | `tail.ts` sets the literal | The amber "From phone" treatment is unreachable dead code, and `functional-spec` §3's "phone-injected prompts stay visually distinct" is false |

**The `thinking` and `error` event kinds are declared in both type definitions
and never constructed by anything.** They are unreachable branches today. They
are resolved in opposite directions: `thinking` becomes real, because thinking
blocks genuinely arrive and are currently being dropped. `error` is **removed**
from the union, because nothing produces it and nothing is planned to — leaving
a declared-but-dead branch that the type system vouches for is the kind of
thing the adapter quarantine exists to prevent.

**Changes:**

- `normalizeLine` returns `TranscriptEvent[]` rather than a single event or
  `null`. A message carrying prose and two tool calls becomes three events. This
  single change fixes both the dropped-prose and only-last-tool defects.
- New kind `{ kind: 'toolResult'; at; toolUseId; ok: boolean; text: string; truncated: boolean }`.
- `thinking` carries its text and is actually emitted.
- `tool` carries `id` and the full `input` object, size-capped.
- `injected` is computed by correlating against `domain/prompt-lifecycle.ts`,
  which already records every prompt the daemon sends and observes it landing.
  This is precisely what `docs/architecture-spec.md` §4 says the flag is for and
  what has never been implemented.

**Size caps.** A tool input or result over 32 KiB is truncated with
`truncated: true`. Without this, one large file read balloons the whole
transcript response. The existing 500-event cap is unchanged.

**This work belongs inside `lib/claude-adapter/`.** The transcript entry
vocabulary is a Claude Code internal, so the quarantine is respected rather than
worked around. `pwa/src/lib/types.ts` is a hand-maintained mirror of the daemon
union and must be updated in lockstep — FENCE 1 forbids importing across.

### 4.2 The renderer

`Transcript.tsx` is 76 lines with the whole per-kind switch inline. It splits
into `pwa/src/components/transcript/` with one component per kind, following how
`AskUserQuestionCard` is already isolated. It is small today and will not stay
small once tool calls expand and diffs render.

| Component | What it fixes |
|---|---|
| `UserTurn.tsx` | `whitespace-pre-wrap`, so multi-line prompts keep their line breaks. Makes the amber "From phone" treatment live. |
| `CodeBlock.tsx` | Background, padding, border, rounding, a language label, and its own `overflow-x` container. Highlighting via `highlight.js`. |
| `ToolCall.tsx` | Collapsed one-line summary, tap to expand into the full input and its matching result. |
| `DiffView.tsx` | Red/green line diff for `Edit`, `MultiEdit`, and `Write`, now that the payload crosses the wire. |
| `Thinking.tsx` | A collapsed marker that expands to the reasoning text. |
| `ToolResult.tsx` | Replaces the empty grey boxes with the actual result, paired to its call. |

**Syntax highlighting: `highlight.js`, and the CSP is why.** The PWA ships
`script-src 'self'` with no `unsafe-eval` and no `wasm-unsafe-eval`. Shiki would
give exact parity, because it uses the same TextMate grammars and the same
VS Code themes as the extension — but it needs WebAssembly, which means
loosening the very directive threat **T7** rests on. `highlight.js` is pure
JavaScript, needs no CSP change, and ships around 30 KB gzipped with a curated
language set. Colors are close rather than identical. That tradeoff was put to
the user explicitly and this is the chosen side.

The language set is registered explicitly rather than pulling the full bundle,
covering what this workspace's sessions actually produce: TypeScript,
JavaScript, TSX, JSON, Bash, CSS, Markdown, YAML, SQL, Python, and diff. An
unrecognised language tag falls back to unhighlighted text inside the same
styled block, never to an unstyled one.

**Markdown.** `remark-gfm` is added, so tables, task lists, strikethrough, and
bare autolinks render. Their absence is CommonMark-strict behaviour and is a
second contributor to text landing differently than in the extension.

**Scroll behaviour.** `Transcript.tsx` scrolls to the bottom exactly once per
newly-selected session and never again, so events arriving during a live turn do
not follow. It changes to: follow the bottom when already pinned to the bottom,
never yank the view when the user has scrolled up.

**Clean-as-you-touch.** `clsx` is declared in `pwa/package.json` and referenced
nowhere in `pwa/src` or `pwa/test`. It is removed while this feature is in that
file.

---

## 5. Architecture & Spec Alignment

### `docs/architecture-spec.md`

- **§2, verified mechanics.** **F1** (session files are per-process, discovery
  dedups by `sessionId`) is what makes Feature B's correlation sound. **F18(2)**
  (`AskUserQuestion` hard-disabled in `-p`) is the reason Feature B uses a PTY
  rather than the existing headless spawn core — see §3.2. No new empirical
  mechanic is claimed by this track; nothing here depends on undocumented
  Claude Code behaviour.
- **§3, component architecture.** The adapter quarantine boundary is unchanged.
  `lib/terminal/` is a new daemon-side module outside it, mirroring
  `lib/webpane/` — a shell is not a Claude Code internal, so FENCE 2 does not
  apply and no `~/.claude` path appears there. Feature C's normalizer work is
  inside `lib/claude-adapter/`, where the transcript vocabulary belongs. FENCE 1
  is respected: `pwa/src/lib/types.ts` stays a hand-maintained mirror.
- **§3, a stale claim this track corrects.** §4 currently states the spawn core
  *"supports both owned-mode creation and resume-based takeover from a single
  code path (only `argv` differs)."* Investigation found no owned-mode path
  exists: `startTakeoverSession` is the only exported entry point and the only
  caller of the private `spawnHandle`, and roughly 48 lines of stdout-init-parse
  logic in `session-manager.ts` are unreachable in production and untested,
  because `_resolveImmediately` is always set. A doc comment there still
  describes "two callers below" when there is one. Feature B does **not** revive
  that path — it uses a PTY. Under clean-as-you-touch, this track corrects the
  §4 sentence and deletes the unreachable branch rather than leaving dead code
  the spec vouches for.
- **§4, API surface.** Four new control-plane routes plus one WebSocket upgrade
  (§2.3). New transcript event kinds and widened existing ones (§4.1).
  `SessionSummary` gains **no** field — see §3.3 for why the pid stays off the
  wire under T9.
- **§5, threat model.** Four new rows, §5.1 below. **T5 is exercised for the
  first time** — `authorizeUpgrade` has existed since Track A and has never had
  a production caller. **T11 extends** from transcript content to terminal
  output. **T9 is respected**, not extended.
- **§6, engineering standards.** All apply unchanged: `npm run typecheck && npm run lint && npm test`
  green before commit; TS strictness including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; the `schemas/ → domain/ → services/ → api/`
  layering fence; one `config.ts` zod-parsed at startup, which is where the two
  new terminal env vars go; fail closed on every new gate. The audit standard
  gets a carve-out that needs stating rather than assuming — see §5.2.

### `docs/functional-spec.md`

- **§1 non-goals** are amended for the terminal, per §1 of this spec. The "no
  diff review" non-goal stands; diff *rendering* is not a review UI.
- **§2 modes** gains the phone-initiated session-creation path alongside mirror
  and takeover.
- **§3 UX flows** gains a Terminal pane section. Its transcript-view section
  stops being aspirational once Feature C lands, and its "tool calls collapse to
  one line each, expandable on tap" line (currently unimplemented — there is no
  `onClick`, no `useState`, and no `<details>` anywhere in `Transcript.tsx`)
  becomes true.
- **§4** is unchanged. The new session's permission mode matches what §4 already
  describes.

### 5.1 New threat rows

> **Numbering starts at T18, not T17.** `origin/main` currently tops out at
> **T16**. Concurrently with this design, story `takeover-race-hardening-1`
> claimed **T17** on its own branch for a concurrent-takeover double-spawn race,
> and that work is implemented and ahead of this track. These rows are numbered
> on the assumption it merges first. If it does not, they shift down by one.
> Whoever writes the plan should re-check the highest allocated ID against
> `origin/main` before implementing, rather than trusting these numbers blind.

| # | Threat | Mitigation |
|---|---|---|
| **T18** | The terminal makes arbitrary command execution on the laptop reachable from the phone **without the idle gate that takeover imposes** — a more direct route to the same capability. | The capability itself is not new: `docs/functional-spec.md` §4 already states takeover runs the session under `--dangerously-skip-permissions`, which *"grants no privilege the user did not already grant themselves on their own laptop."* A shell reaches the same place by a shorter path. What is genuinely new is the removal of two frictions — the idle gate and the coupling to an existing session — so the mitigation set is the unchanged two-factor posture (T1/T2 tunnel membership plus the bearer token, neither sufficient alone), the daemon staying off by default so the exposure window remains a deliberate choice, the known-folder allowlist on the **starting** directory (§2.4), the concurrency cap, and the idle reaper. **Accepted residual risk, stated plainly:** the allowlist bounds where a shell starts, not where it can go — `cd /` is the first thing anyone can type. It is a guard against a malformed `cwd` reaching `spawn`, not a containment boundary, and it is not represented as one. |
| **T19** | The control-plane WebSocket is a new authenticated surface, and CORS does not cover sockets. | `authorizeUpgrade` (written for T5, previously unexercised) runs before any PTY is attached: Host allowlist → control-port match → strict `Origin` equality → bearer in `Sec-WebSocket-Protocol` → live terminal id. The blanket main-origin upgrade refusal at `app.ts:568` narrows to "refuse unless `/ws` and the gate passes" rather than disappearing; every other main-origin upgrade stays refused. The content-plane splice is a separate handler and is untouched. `sec-websocket-protocol` is already in `buildUpgradeRequestHead`'s drop set, so the bearer can never leak into a proxied dev server. Frames are zod-validated and capped at 64 KiB; an invalid frame closes the socket rather than being ignored. |
| **T20** | `node-pty` is a **native** dependency running inside the trusted daemon process — a new supply-chain and build surface for a public repo. | Pinned to an exact version. Imported from exactly one file (`node-pty-spawner.ts`) behind an injected `PtySpawner` seam, mirroring how `node-spawner.ts` isolates `node:child_process` for the adapter — so it is swappable, and the whole terminal module unit-tests against a fake without the native module present. `INSTALL.md` gains a build-prerequisite step with its own verify command, per that document's stated discipline. |
| **T21** | Terminal output is untrusted bytes rendered into the PWA. A hostile program can emit ANSI escape sequences, including OSC sequences that set titles, write the clipboard, or inject hyperlinks. | This is T11's "MicroViber never executes, auto-sends, or acts on content — it only displays it" extended from transcript content to terminal output. xterm.js interprets escape sequences as terminal state, never as code, and the PWA's CSP already forbids inline script and `eval`. OSC 8 hyperlink handling and clipboard-write handling are disabled explicitly rather than left at their defaults. Output is rendered into xterm's own canvas, never into `innerHTML`. |

**One new disclosure, tied to its existing bound rather than left loose.**
`GET /api/folders` (§2.4) makes folder *names* client-visible for the first
time. Today a bearer-token holder sees session `cwd` values via
`SessionSummary.cwd`, but not the names of sibling or child directories that
have no session. This is **not** a T9 matter: T9 is scoped to `~/.claude`-sourced
secrets, chiefly `peerToken` values, and `/api/folders` never reads that source.
It derives from `lib/webpane/port-resolver.ts`'s on-disk directory scan, which
is the mechanism **T13 and T14 already bound** — text-only reads, non-regular
files rejected, symlinked children excluded rather than followed, and at most 25
children statted per folder. The disclosure inherits those bounds and adds no
new scan surface. It is also not an escalation in this threat model: the same
token already permits reading arbitrary files with no folder restriction (T16)
and full command execution (T18). Recorded here so the route is not the one new
capability in this track with no threat-model paper trail.

### 5.2 Audit logging — a deliberate reduction, not an oversight

`docs/architecture-spec.md` §6 requires auditing *every write attempt, not only
successes*, and `services/audit-log.ts` implements it by hashing prompt text so
content never reaches disk.

A PTY does not have "write attempts". It has a keystroke stream. Capturing it
would put passwords, tokens, and pasted secrets on disk in plaintext — the exact
thing the prompt path's hashing exists to prevent.

**The rule for terminals:** audit the **lifecycle**, never the stream. Recorded
events are terminal opened (id, cwd, clientId, requestId), closed (id, reason),
and exited (id, exit code). Rejected creates are audited too, matching the
existing read-only-rejection precedent that exists so a stolen-token holder
probing the API leaves a forensic trace.

**The honest consequence:** for terminals the audit log tells you that a shell
was opened and where, not what was run. That is a real reduction in forensic
coverage compared with the prompt path, accepted deliberately because the
alternative is worse. It is recorded here so a future reader does not mistake
the gap for a bug.

---

## 6. UI/UX Guidelines Alignment

(`docs/functional-spec.md` §3 is the UI/UX reference — the registry `UIUX_SPEC`
entry for this project is `none`.)

- **Minimalism, the hard requirement.** §3 names three persistent controls:
  session picker, composer, pane switch. This track adds **zero** new persistent
  controls. The pane switch grows a third tab, which is an extension of an
  existing control rather than a new one, and the Terminal pane's own chrome
  reuses the Web pane's established header-plus-`CaretButton` idiom rather than
  inventing a second navigation language.
- **Deliberate deviation: the accessory key row.** New UI with no precedent in
  the app. Justified because a phone soft keyboard cannot produce `Ctrl`, `Esc`,
  `Tab`, or arrows, and a PTY without them is not a terminal. This is the one
  place Feature A adds visible chrome that minimalism would otherwise reject.
- **"Matches the Claude Code VS Code extension's own rendering, deliberately."**
  Feature C is the fulfilment of this rule, not a deviation from it. One bounded
  shortfall is accepted: `highlight.js` colors are close to, not identical to,
  the extension's TextMate output. §4.2 states why.
- **"Phone-injected prompts stay visually distinct."** This is currently a false
  claim — `injected` is hardcoded `false`, so the amber treatment never renders.
  Feature C makes it true.
- **"Tool calls collapse to one line each, expandable on tap."** Also currently
  false — tap-to-expand does not exist. Feature C implements it.
- **Flowing document, not a chat.** Unaffected. The per-kind component split is
  internal structure; the single-column layout with a left gutter marker stays.

---

## 7. Decisions taken during design

| Decision | Chosen | Alternatives offered | Why |
|---|---|---|---|
| Terminal fidelity | Full interactive PTY | One-shot command runner; persistent pipe-backed shell | A crippled terminal fails exactly when it matters — no `Ctrl-C`, no interactive prompts, no `vim`. The PTY also unlocks Feature B's full-fidelity session. |
| New-session spawn model | Real interactive `claude` in a PTY | Headless owned process; no button at all, just type `claude` | F18(2) permanently disables `AskUserQuestion` in headless mode. A PTY session is an ordinary session; a headless one is second-class forever. |
| Working-directory scope | Folders already discovered | Free-text unrestricted path; a configured allowlist | No new configuration and no filesystem reach beyond what the Web pane's port resolver already has. |
| Syntax highlighting | `highlight.js`, CSP untouched | Shiki with `wasm-unsafe-eval`; no highlighting at all | Exact parity was not worth weakening the `script-src` directive that T7 rests on. |
| Terminal lifetime | Survive disconnects, reattach with a replayed buffer | Kill on disconnect; survive only while the daemon lives | Locking the phone mid-build must not kill the build. Daemon restart still kills terminals, deliberately, to avoid orphan shells. |
| New-session permission mode | `--dangerously-skip-permissions` | Plain `claude` with prompts answerable in the PTY; ask on every tap | Consistency with the takeover path, which already runs this way. The safer alternative was offered and declined. |
| Track shape | One track, three features | Split Feature C into its own track; drop Feature B | Matches the Track B precedent of bundling related features into one spec, then decomposing into stories. |
| Terminal audit scope | Lifecycle events only, never the stream | Full keystroke and output capture | Capturing a PTY stream would write secrets to disk, defeating the reason the prompt path hashes its content. See §5.2. |

---

## 8. Out of scope

- **Live transcript streaming over the new `/ws`.** The socket lands for the
  terminal only. The transcript keeps its 2.5-second poll. Migrating it would be
  a natural follow-up and is deliberately not bundled here.
- **Transcript pagination.** `getTranscript` accepts a `cursor` and ignores it,
  always returning `nextCursor: null` and silently truncating to the last 500
  events with no marker. Pre-existing; unchanged by this track.
- **Terminal survival across a daemon restart.** Explicitly chosen against in
  §2.1.
- **Reattaching orphaned takeover children after a daemon restart.**
  `node-spawner.ts` sets `detached: true` with no `unref()` and no reattach path,
  so a restart orphans any survivor. Pre-existing, still open at
  `docs/features/microviber/findings.md:136`, and not fixed here. Feature A
  avoids repeating the pattern for terminals but does not repair it for takeover.
- **Naming takeover children** so they stay findable in discovery. Feature B
  closes this for created sessions only (§3.4).
- **Shiki or TextMate-exact syntax colors.**
- **Resuming stale sessions from the phone.** Still deferred, as in the MVP spec.
- **Push notifications for terminal events.** `MV_VAPID_*` is parsed into config
  and consumed by nothing; `domain/notify-policy.ts` computes intents no service
  sends. Pre-existing and untouched.
- **iOS.** Unchanged from Track B: Android/Chrome only, by explicit decision.
- **A file tree, git UI, or diff review UI.** The non-goal stands (§1).
- **Multiple simultaneous terminals beyond `MV_TERMINAL_MAX_SESSIONS`.**
