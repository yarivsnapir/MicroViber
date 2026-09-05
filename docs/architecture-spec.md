# MicroViber — Architecture Spec

> Write model: **takeover-via-resume** (revised 2026-08-24). MicroViber has exactly one
> write mechanism — `claude --resume <id>` — and reading is always available for any
> session, live or stale. Two earlier approaches were explored and superseded — see
> [Superseded approaches](#superseded-approaches) for the peer-socket send path and the
> standalone-launch-only write path.
>
> This document is derived from the design spec in the Harness workspace
> (`features/microviber/spec.md`, `features/microviber/findings.md`) and corrected
> against the code actually committed to this repo.

---

## 1. System overview

MicroViber is two components, split across two machines:

- **`daemon`** (Node 22 + TypeScript, Fastify) — runs on the laptop, next to Claude Code.
  It discovers live sessions, tails their transcripts, and — only on a deliberate
  **Take over** action — spawns a `claude --resume <id>` child process to write into a
  session.
- **`pwa`** (Vite + React + Tailwind + shadcn/ui) — runs on the phone as an installed PWA,
  talking to the daemon over HTTPS/WSS across a private tunnel (Tailscale recommended;
  see `INSTALL.md`).

**One shared history file per session.** Every Claude Code session's transcript is a
single append-only `.jsonl` file on the laptop (`~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`).
MicroViber never forks or copies this file — it only tails it (for reading) or causes a
new process to append to it (for writing). This is what makes "phone and laptop take
turns on the same conversation" possible without a sync layer.

**Read-always / write-by-takeover** is the whole model:

| Capability | Availability | Mechanism |
|---|---|---|
| **Mirror** (read) | Always — working, idle, or stale sessions | Tail the session's `.jsonl`. Spawns no process, cannot conflict with the laptop. |
| **Take over** (write) | Only when the session is **idle**, by explicit tap | `claude --resume <id>` spawns a daemon-owned process on the *same* session id. It writes genuine user turns to that process's stdin, which append to the same `.jsonl`. |

Handback is manual and symmetric: the phone user releases ownership (or abandons it),
and the laptop user runs `/resume <id>` in their own Claude Code tab to reload the full
history — phone turns included — into a fresh in-memory view. The tab the phone typed
into on the laptop's behalf goes stale; MicroViber takes no action on it and does not
warn if someone keeps typing there (conflict rule: do nothing — see Threat/Risk R6 in
the source design spec).

---

## 2. Claude Code integration contract

Everything below is **empirically verified**, not inferred from documentation — Claude
Code exposes no public API for any of this (`claude --help` has no peer/message
subcommand). It was confirmed on Claude Code CLI `2.1.216`–`2.1.237` / VS Code extension
`2.1.237`, all reporting `peerProtocol: 1`.

> **Re-verify this table on every Claude Code version change.** The adapter that depends
> on it is quarantined in `daemon/src/lib/claude-adapter/`, behind a `peerProtocol`
> version gate (`version-gate.ts`) that degrades the whole daemon to read-only mirroring
> on any unrecognised build rather than guessing at a changed protocol.

| # | Verified mechanic | Detail |
|---|---|---|
| F1 | Sessions are discoverable with live metadata | `~/.claude/sessions/<pid>.json` → `{pid, sessionId, cwd, version, peerProtocol, peerFeatures, kind, entrypoint, messagingSocketPath, name}`; a paired `<pid>.<hash>.key` file holds a `peerToken`. **One file per PROCESS, not per session**: several live processes can reference the same `sessionId` (a VSCode tab re-resuming a session, a lingering pre-reload extension process, MicroViber's own takeover child), so discovery dedups by `sessionId`, keeping the newest-written file. |
| F2 | Transcripts are append-only and written live | `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` grows during an active turn; readers must tolerate partial trailing lines. |
| F3 | Real session titles exist | `ai-title` transcript entries carry a human title; `last-prompt` is the fallback. |
| F13 | `claude --resume <id>` appends to the **same** history file — no fork | A 16-line session resumed with a second prompt returned the same `session_id` and grew the same `.jsonl` to 34 lines. |
| F14 | Resume works **while the original process is still alive and idle** | A persistent idle process (an open laptop tab) stayed alive throughout a concurrent `claude --resume <id>` from a second process, which succeeded and grew the shared file. The original process is left with a stale in-memory view — this is *why* the laptop must `/resume` to catch up. |
| F15 | Resume carries full history across the process boundary | The resumed process recalled the entire prior transcript, not a blank context. |
| I6 | **A standalone daemon cannot write into a running session over the peer socket** | A controlled test: the *same* message delivered by a real Claude peer landed; the identical write from a standalone client was silently dropped. The peer socket accepts writes only from registered Claude sessions — this is why takeover-via-resume, not the superseded peer-socket send path, is the write path. |
| F16 | **PASS (transport only — see F17)** — a `tool_result` content block can be written into a `--resume`'d, daemon-owned session over the same stdin stream-json transport already verified for plain user turns (F11) | A real interactive session (`claude`, VS Code extension, cwd `/Users/yariv_s/Harness-2`) was driven to a pending `AskUserQuestion` tool_use (`id":"toolu_01PcTak2uxLBQJYH7gY5DJy6`, recorded in the transcript with `"stop_reason":"tool_use"`). A second process — `claude -p --verbose --resume <id> --input-format stream-json --output-format stream-json --dangerously-skip-permissions` — was fed one line on stdin: `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01PcTak2uxLBQJYH7gY5DJy6","content":"Yes"}]}}`. The transcript grew (17→33 lines) and the very next entry was `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01PcTak2uxLBQJYH7gY5DJy6","content":"Yes"}]},...}` — the write landed, correctly attributed to the pending tool_use. |
| F17 | **The write from F16 lands, but the model does not coherently continue from it** — `claude -p --resume` unconditionally injects its own synthetic `"Continue from where you left off."` handshake turn (`isMeta: true`) the moment the process starts, *before* processing anything on stdin, regardless of delay | Reproduced identically across four independent real sessions, including one where the `tool_result` was the literal first and only stdin content ever written (zero delay) and one where the daemon's actual `sendAnswer` write path (Task 7, story microviber-track-b-8) was exercised live end-to-end with no VS Code window ever reopened afterward. Pattern every time: `assistant tool_use AskUserQuestion` → (any delay, 2s to 54s) → `user text "Continue from where you left off."` (`isMeta:true`) → `assistant text "No response requested."` → *then* `user tool_result` (the real answer) → the model, now working from a context where its own most recent completed turn is the synthetic handshake rather than the tool_use, searches for an `AskUserQuestion` tool, doesn't find one (a `-p` invocation's tool list never includes it — already noted at F16), and re-presents the original question in plain text instead of incorporating the answer. Ordinary plain-text prompts sent after the same handshake are unaffected (the model picks them up normally) — the confusion is specific to a `tool_result` referencing a tool_use that is no longer the model's own most recent turn. **Practical effect on this story:** the daemon-side bookkeeping this story builds (`pendingQuestion` clearing, `awaiting-input` → `idle`) is genuinely correct and verified independently of this finding — F16's transport claim holds. But AC15's promise ("tapping an option... the session continues normally") does not hold up in practice this way; shipping it as an interactive control would mislead the user into thinking they successfully answered when the model did not act on it. The PWA therefore renders `AskUserQuestion` options as inert/read-only even when taken over (spec §6's own pre-planned FAIL-branch fallback), and the daemon-side `sendAnswer`/`submitAnswer`/`toolResultFrame` plumbing (Task 7) stays in the codebase, unused by the UI, for whenever a working mechanism is found — a return to brainstorming for the answer-submission mechanism specifically is the intended next step, not further UI wiring. **Resolved by the AskUserQuestion answer mechanism (F18, `docs/features/askuserquestion-answer-mechanism/spec.md`): answers go out as plain text and the daemon resolves the question from any later human turn; the tool_result write path was removed.** |
| F18 | **The F17 handshake is conditional, not intrinsic; `AskUserQuestion` is hard-disabled in `-p`; human turns carry `origin.kind: 'human'`, not an absent `origin` field** | (1) Resuming a session whose transcript ended with `stop_reason: end_turn` via `claude -p --verbose --resume <id> --input-format stream-json --output-format stream-json`, with stdin held open but idle for 12–20 s, produced **no** synthetic turn and no `system/init` line until the first stdin frame; the "Continue from where you left off." turn fires only when the resumed transcript ends on a dangling `tool_use` (the SDK's documented `origin: "auto-continuation"`). (2) `-p` with `--tools default,AskUserQuestion`: the model's call is answered by the CLI with `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>` — no headless variant exposes it, so a daemon-owned process can never produce a pending question. (3) A headless CLI killed mid-tool writes its own `tool_result` (`Exit code 137`) before exiting, so dangling tool_uses cannot be manufactured headlessly. Observed on CLI 2.1.259, stdout only, 2026-09-03. **Addendum (spike, 2026-09-04): FAIL.** On a real interactive-session transcript (`~/.claude/projects/-Users-yariv-s-Harness/*.jsonl`), a laptop-typed human turn (a slash-command invocation) carries `origin: {"kind": "human"}` — `origin` is present, not absent — while skill-injected material carries `isMeta: true` with `origin: null`. Observed lines (redacted): human → `{"isMeta": null, "origin": {"kind": "human"}, "text": "continue"}`; skill-injected → `{"isMeta": true, "origin": null, "text": "Base directory for this skill: ..."}`. Because (d) fails, the resolution rule in `docs/features/askuserquestion-answer-mechanism/spec.md` §4.1 is narrowed to an explicit denylist: a later user entry resolves a pending question when it has text, `isMeta !== true`, and `origin` is either absent or has `kind` outside the known-synthetic set (currently `{'task-notification'}`) — `origin.kind: 'human'` resolves, `origin.kind: 'task-notification'` does not. Re-verify on every Claude Code version change; extend the denylist if a new synthetic `origin.kind` is observed. |

Project-directory path encoding (`/`, `.`, *and* `_` all map to `-`) is a documented
adapter detail with its own unit test (`encode-path.ts`) — missing the `_` rule silently
breaks transcript lookup for any cwd containing an underscore.

---

## 3. Component architecture

Two components. All knowledge of Claude Code internals lives in exactly one module —
`daemon/src/lib/claude-adapter/` — nothing above it touches `~/.claude/*`, the messaging
socket, or the transcript entry vocabulary directly.

```
   Phone (PWA)                      Laptop
┌────────────────┐        ┌──────────────────────────────────┐
│ pwa/            │  WSS   │  daemon/                          │
│  SessionPicker  │◄──────►│  ┌────────────────────────────┐  │
│  Transcript     │        │  │ lib/claude-adapter/        │  │
│  Composer       │  HTTPS │  │  ← the only module that     │  │
│                 │◄──────►│  │    touches internals        │  │
└────────────────┘        │  └────────────────────────────┘  │
                            │  domain/ │ services/ │ api/       │
                            └──────────────────────────────────┘
```

### `daemon/src/` (matches the tree as committed)

| Directory | Responsibility |
|---|---|
| `lib/claude-adapter/` | **Quarantine.** Sole owner of `~/.claude/sessions/`, `~/.claude/projects/`, the messaging socket, `peerProtocol`, path encoding, and the transcript entry vocabulary. Everything above it sees only MicroViber's own normalized types. |
| `domain/` | Session registry, session-state derivation (working / idle / stale), prompt lifecycle, ownership bookkeeping, notification policy. No I/O, no HTTP. |
| `services/` | Cross-cutting service wiring (audit log, push, etc.), composed for `api/`. |
| `api/` | Fastify HTTP routes + WebSocket building blocks. Parse → authenticate → delegate → serialize. |
| `lib/webpane/` | The "Web pane" backend. Port resolution (`devports-config.ts`, `port-resolver.ts`) — a best-effort, explicit-first chain (`.env` → `devports.json` → static config-file text scan), never importing/executing a scanned file, applied to a session's cwd AND (microviber-track-b-3) each of cwd's immediate child directories (one level, no recursion, symlinks/`node_modules`/hidden dirs excluded, capped at 25 children) — a session's cwd is frequently a multi-project workspace root, not a single project. Feeds `SessionSummary.devServerPorts` (microviber-track-b-1, reshaped to a list in microviber-track-b-3). `webpane-auth.ts` — an in-memory, resource-scoped token store (`WebpaneTokenStore`) behind the `mv_webpane` cookie, the one narrow exception to "auth is a header, not a cookie" (T15). `proxy.ts` — `proxyToLoopback`, a pure reverse-proxy to a hardcoded `127.0.0.1:<port>` target (T14). `local-file.ts` — `readLocalFile`, reads and content-type-guesses an arbitrary local file with no folder restriction (T16, accepted risk); stats the target first and rejects non-regular files or anything over a size cap before reading, same non-blocking-read discipline as `port-resolver.ts`. (microviber-track-b-2) |
| `server/` | Non-API laptop-side concerns — currently the pairing-URL builder. |
| `schemas/` | zod schemas validated at every boundary. |
| `config.ts` | All env, zod-parsed at startup; a missing required var crashes immediately. |

**`lib/claude-adapter/` sub-modules, as committed:**

- `discovery.ts` — scans `~/.claude/sessions/*.json`, liveness-checks each `pid`,
  dedups by `sessionId` (newest file mtime wins — the F1 files are per-process, and
  several live processes can share one session), classifies VS Code vs terminal
  (`classify.ts`, keyed on `entrypoint`), reads the paired `peerToken`. Resolves
  `ai-title` / `last-prompt` from the transcript.
- `encode-path.ts` — the `/`, `.`, `_` → `-` cwd-encoding rule, unit-tested.
- `tail.ts` — watches the active transcript, parses incrementally from a byte offset,
  emits normalized events; tolerates partial trailing lines.
- `transcript-meta.ts` — derives titles/last-prompt/last-activity metadata from a
  transcript without a full parse, plus `turnOpen`: whether the newest conversational
  entry says a turn is still in flight (last assistant entry did not stop with
  `end_turn`, or a user prompt/tool_result is awaiting the model). An open turn keeps
  a session `working` past the 20s no-growth window (capped at 60min) — transcripts
  stall for minutes while a tool runs, which otherwise reads as a false idle.
- `ask-user-question.ts` — everything about `AskUserQuestion` in one place: tool_use
  detection (shared by `tail.ts` and `transcript-meta.ts`), the two-clause resolution rule
  (a matching `tool_result`, OR a later human turn — text present, `isMeta !== true`, no
  denylisted `origin.kind` — F18), and the daemon-composed answer text format with its
  parser.
- `session-manager.ts` — the shared spawn-and-own-stdin core used by **both** owned-mode
  session creation and takeover (resume). Wraps a `Spawner`-injected child process,
  writes plain user-turn frames to its stdin (`prompt-sender.ts`, `userFrame`), and
  exposes an `OwnedSessionHandle` (`pid`, `sessionId`, `alive`, `send`, `kill`, `onExit`)
  that the domain layer manages.
- `node-spawner.ts` — the real `Spawner` implementation over `node:child_process.spawn`,
  `detached: true` so the child survives a daemon restart.
- `version-gate.ts` — compares the observed `peerProtocol` (not raw `version`) against a
  supported range; an unrecognised protocol degrades the daemon to read-only mirroring.
- `schemas.ts` — zod shapes for the adapter's own parsed structures (session JSON,
  transcript entries).
- `node-sources.ts` — the real filesystem/liveness sources over `node:fs` and
  `process.kill(pid, 0)`: lists `~/.claude/sessions/*.json`, reads a session's
  transcript file, and checks whether a `pid` is alive. The only module that constructs
  the literal `~/.claude/sessions` / `~/.claude/projects` paths; `discovery.ts` and
  `services/services.ts` consume it through the injected `DiscoveryDeps` interface
  rather than touching the filesystem directly.

**`domain/` sub-modules, as committed:**

- `registry.ts` — the normalized `SessionSummary` list.
- `session-state.ts` — the `working` / `idle` / `stale` derivation (§4.1 below).
- `prompt-lifecycle.ts` — the per-prompt `PromptStatus` state machine.
- `ownership.ts` — `OwnershipRegistry`: bookkeeping for which session ids are currently
  owned by a daemon-spawned process. In-memory only — a daemon restart reverts every
  session to read-only, and it can be taken over again. Also defines
  `assertIdleForTakeover` / `ForbiddenTakeoverError`, the hard "idle-only" gate.
- `notify-policy.ts` — idle-notification policy (§5 of the functional spec).

No module outside `lib/claude-adapter/` imports Node's `child_process`, touches
`~/.claude/*` paths, or parses a transcript line directly — enforced by two lint rules in
`eslint.config.js`, not code review alone:

- **FENCE 1** (`no-restricted-imports`, scoped to `pwa/**/*.{ts,tsx}`) — blocks any
  import matching `**/daemon/**`, `../daemon/*`, or `../../daemon/*`. This is the
  cross-repo layering fence: the PWA must never import daemon internals, only cross the
  boundary over HTTP/WS.
- **FENCE 2** (`no-restricted-syntax`, scoped to `daemon/src/**/*.ts`, excluding
  `daemon/src/lib/claude-adapter/**`) — flags any string literal matching
  `/\.claude\/(sessions|projects)/` or `/cc-socks/` as an error, with the message "Only
  lib/claude-adapter may reference ~/.claude paths (§16.1 quarantine)" (and the
  equivalent for the peer-socket path). It is enforced on the **literal path strings
  themselves**, not on imports — since these are filesystem/socket paths, not module
  specifiers, a plain import-restriction rule can't catch them the way FENCE 1 does for
  the PWA↔daemon boundary.

### `pwa/src/`

Vite + React + Tailwind + shadcn/ui, deliberately not Next.js — this is a single-page
realtime WebSocket client with no SSR, no routing depth, and no SEO surface. Structure:
`components/` (`SessionPicker`, `Transcript`, `Composer`, `states`), `lib/` (`api.ts`,
`types.ts`, `text.ts`), `hooks/`. FENCE 1 (above) enforces the one layering fence that
crosses repos: the PWA must never import daemon internals — it crosses the boundary over
HTTP/WS only.

---

## 4. Event model & API surface

### Normalized types

The adapter translates Claude Code's internal transcript vocabulary into a small stable
shape, so an upstream format change is a one-file fix:

```ts
interface SessionSummary {
  id: string;
  title: string;            // ai-title, else truncated last-prompt, else "(untitled)"
  folder: string;            // basename of cwd
  cwd: string;
  host: 'vscode' | 'terminal';
  writable: boolean;         // live pid + supported protocol
  state: 'working' | 'idle' | 'stale';
  lastActivityAt: string;    // ISO — any transcript growth
  lastPromptAt: string;      // ISO — most recent *user* turn; the session list's sort key
  devServerPorts: { folder: string; port: number }[]; // resolved once per listSessions() call — see §3 lib/webpane/ (microviber-track-b-1, reshaped from a single nullable port to a list in microviber-track-b-3 once manual testing found that a session's cwd is often a multi-project workspace root — see port-resolver.ts's child-directory scan, one level deep)
}
```

A phone prompt sent via takeover lands in the transcript as a **plain `user` entry** —
no `<cross-session-message>` wrapper — because it travels over the owned process's
stdin, which is the documented SDK stream-json transport. The `injected` flag that
distinguishes a phone-sent turn from a laptop-typed one is therefore set by **daemon-side
correlation** (the daemon records each prompt it sends and matches it to the transcript
entry it later observes), not by unwrapping protocol boilerplate.

`PromptStatus` is per-prompt, not per-session (a prompt can be `queued` while its session
is independently `working`):

```ts
interface PromptStatus {
  id: string;                 // client-generated; doubles as the Idempotency-Key
  state: 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';
  sentAt: string;
  observedAt?: string;        // when the tailer saw it enter the transcript
}
```

`accepted` is asserted only once the tailer *observes* the prompt in the transcript —
never merely because the stdin write returned — and `expired` fires after 10 minutes
unobserved.

### API surface — as committed in `daemon/src/api/app.ts`

All payloads are zod-validated at the boundary. One error envelope everywhere:

```ts
{ success: false, error: { code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN'
  | 'NOT_FOUND' | 'INTERNAL_ERROR' | 'EXTERNAL_SERVICE_ERROR', message, details? } }
```

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | public (liveness) | Daemon status. |
| `/api/sessions` | GET | bearer | List `SessionSummary[]`. |
| `/api/sessions/:id/transcript` | GET | bearer | Cursor-paginated backfill page of transcript events. |
| `/api/sessions/:id/prompt` | POST | bearer | Send a user turn. **Requires `Idempotency-Key` header** — 400 `INVALID_INPUT` if absent. Body is exactly one of `{ text }` (a plain prompt) or `{ answer: { toolUseId, selections: string[][] } }` (an answer to the currently pending `AskUserQuestion`; the daemon validates it against that question — 400 `INVALID_INPUT` `question is no longer pending` / `answer must cover every question` / `question <header> lists a duplicate selection` / `question <header> accepts one option` / `unknown option for <header>` / `answer too long` (the composed text exceeds `ANSWER_TEXT_MAX_CHARS`, a backstop no validated answer should reach) — composes the text `Answering your question(s):` + one `- <header>: <labels>` line per question, and sends it as a plain user turn; a same-key replay is matched on the canonical answer body before any re-validation). Delegates to `sendPrompt`, which throws a typed `FORBIDDEN` error for a session that has not been taken over — the route maps this to **HTTP 403** `{success:false, error:{code:'FORBIDDEN', message:'session is read-only until taken over'}}`, and no `PromptRecord` is persisted. An owned (taken-over) session still gets `{success:true, data:<PromptStatus>}`. |
| `/api/sessions/:id/takeover` | POST | bearer | Resume an idle laptop-started session as a daemon-owned process (`claude --resume <id>`), making it writable. `FORBIDDEN` (403) if the session is not idle or is on an unrecognized Claude Code build; `NOT_FOUND` (404) for an unknown session id. |
| `/api/sessions/:id/handback` | POST | bearer | Release ownership of a taken-over session and dispose the daemon-owned process — the session reverts to read-only. Returns **HTTP 200** `{success:true, data:{id, mode:'readonly'}}`. Idempotent: calling it on a session that was never taken over (or already handed back) is a no-op that returns the same envelope. |
| `*` (GET, non-`/api`, non-`/ws`) | GET | public | SPA fallback — serves the built PWA (`pwa/dist`) as the app shell, so the phone can load the app before it has a pairing token. |
| `/api/webpane-token` | POST | bearer (never the `mv_webpane` cookie — see below) | Mints a `WebpaneResource`-scoped opaque token, re-validating the resource first (`devserver`: port must be in the live `listResolvedDevServerPorts()` set, else 403; `localfile`: path must be readable via `readLocalFile`, else 404). Sets `Set-Cookie: mv_webpane=<token>; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300` — `Path=/` and `SameSite=None` because the content origin serves at root paths and the cookie must attach in a framed context; the loosened browser-side bound is enforced server-side instead (the cookie is ACCEPTED only on `/api/webpane/localfile` and the content-plane root proxy; every other route ignores cookies) (microviber-track-b-3). |
| `/api/webpane/localfile` | GET | bearer OR `mv_webpane` cookie (scoped to this exact path) | Reads and serves an arbitrary local file's bytes with a guessed `content-type` — **no folder restriction** (T16, accepted risk). Adds `x-content-type-options: nosniff` and `content-security-policy: sandbox allow-scripts` as a server-side isolation backstop. 404 if the path is missing, a non-regular file (directory, FIFO, device), or over the size cap (microviber-track-b-2). *(The former main-origin `/api/webpane/devserver/:port/*` proxy route was deleted in microviber-track-b-3 — dev servers are framed on the CONTENT plane instead; see below.)* |

Every request gets an `X-Request-Id` (generated if absent) echoed on the response. Every
request is checked, in order, against the Host allowlist (T3, DNS rebinding), the Origin
allowlist (T4, CORS), then the bearer token (skipped only for `/api/health` and the
static shell) — **with one narrow, resource-scoped exception**: the `/api/webpane/localfile`
content route above also accepts the `mv_webpane` cookie in place of the header (T15);
every other route, including `/api/webpane-token` itself, still requires the real header,
unchanged.

**The webpane CONTENT plane is a separate pipeline entirely** (microviber-track-b-3): a
request whose Host header carries `MV_WEBPANE_CONTENT_PORT` (default 8443 — a second
`tailscale serve` mapping to the same daemon, INSTALL.md Step 4.3b) is short-circuited
right after the Host allowlist, before Origin checks or route matching. None of the
routes in the table above exist on that origin; every path is reverse-proxied to the
loopback port the presented `mv_webpane` cookie is bound to, or rejected 401/403 — see
T15 for the full isolation model.

**Takeover and handback — live.** The design's write path
(`POST /api/sessions/:id/takeover`, `POST /api/sessions/:id/handback`) is wired to HTTP
routes in `app.ts`, with idle-gating (`ForbiddenTakeoverError` in `domain/ownership.ts`)
mapped to `FORBIDDEN` (403). The underlying spawn-and-own-stdin core
(`lib/claude-adapter/session-manager.ts`) supports both owned-mode creation and
resume-based takeover from a single code path (only `argv` differs). The dead
`POST /api/sessions/owned` fresh-session-creation route has been removed from the HTTP
surface; the shared spawn core it used remains internal to the adapter.

**WebSocket (`/ws`) — story 2 (in progress).** The building blocks for a live event
stream exist (`api/ws/hub.ts`'s per-session pub/sub `Hub`, `api/ws/authorize.ts`'s
Host/Origin/bearer handshake check per T5) but `app.ts` does not yet register a live
`/ws` upgrade route. Until that lands, the PWA must poll `/api/sessions/:id/transcript`
for updates.

---

## 5. Transport & security (threat model T1–T12)

MicroViber takes a capability that was previously local-only — inject a prompt into a
live Claude session running under `--dangerously-skip-permissions`, which is arbitrary
code execution as the logged-in user — and makes it reachable over a network. Every
mitigation below exists to ensure that reachability requires **two independent factors**,
neither sufficient alone, and that the exposure window is a deliberate choice.

**Two-factor posture:**

| Factor | What it is | Why it alone is not enough |
|---|---|---|
| **Network** | Membership of a private tunnel (Tailscale tailnet recommended) | Even on the tailnet, every request needs the bearer token. |
| **Application** | Bearer token, provisioned by QR pairing | Even with the token, the daemon is unreachable without tunnel membership. |

**Bind-address whitelist, off by default.** The daemon binds to a single configurable
address and refuses to run if that address resolves to a public interface — never
`0.0.0.0`. It is not a launch agent and does not run at boot; it is started deliberately
and stopped when not needed, so the exposure window is minutes-to-hours of chosen use.

Verbatim threat IDs from the source design spec (`features/microviber/spec.md` §9):

| # | Threat | Mitigation |
|---|---|---|
| **T1** | Someone on the public internet reaches the daemon | Daemon binds to a private-network interface only, asserted at startup; no port forwarding, no public tunnel. |
| **T2** | Someone on the same LAN reaches it | Same control as T1 — the LAN interface is never bound. |
| **T3** | DNS rebinding — a malicious page resolves its own hostname to the daemon's private IP | `Host` header validated against an allowlist before any other handling; rejected with 421. Bearer auth still required on top. |
| **T4** | A malicious site calls the API cross-origin | Strict CORS allowlist (never `*`). Auth is an `Authorization` header, not a cookie, so a cross-origin page cannot attach credentials — CSRF-resistant by construction. **One narrow, documented exception (microviber-track-b-2, 2026-08-28; narrowed to one main-origin route + the content plane in microviber-track-b-3):** the `mv_webpane` cookie used by the Web pane's `/api/webpane/localfile` route and the content-plane root proxy — see T15 for why this doesn't reopen the CSRF surface (content-plane cross-site fetch/POST/WS are rejected by an Origin check, and `access-control-*` is stripped from responses). |
| **T5** | WebSocket bypasses CORS | `Origin` and bearer token both validated explicitly on the WS upgrade (`authorizeUpgrade`), independent of the HTTP CORS hooks. |
| **T6** | Lost or stolen phone with a paired PWA | Device lock screen is the first barrier. Revocation is immediate: rotate the daemon token and restart — every paired client dies at once. |
| **T7** | XSS in the PWA stealing the token | Transcript content rendered as sanitized markdown, never `innerHTML`/`dangerouslySetInnerHTML`; strict CSP, no third-party script origins, no inline script, no `eval`. **(microviber-track-b-4, 2026-08-31):** `SafeMarkdown` now supplies a custom `urlTransform` (to let `file://` links through, scoped to the `href` attribute only) instead of relying solely on `react-markdown`'s default — verified it still delegates every other scheme to the default, unmodified. A second, independent scheme denylist (`javascript:`/`data:`/`vbscript:`) was added local to the anchor-rendering component itself as defense-in-depth, so this mitigation no longer rests on a single upstream chokepoint. |
| **T8** | Token leaks via logs, URLs, or screenshots | Token travels in a header, never a query param or body. The pairing URL carries it in the fragment, which browsers never send to a server. |
| **T9** | `~/.claude` secrets exfiltrated through the API | The daemon reads `peerToken` values for discovery only and never returns or logs them; `SessionSummary` is an explicit allowlist of fields. This mitigation is about the API response shape and is unaffected by microviber-track-b-4 (T11/T16) below — that story lets transcript content choose a local-file *path* to display in the PWA, not a field the API returns; the two are different surfaces, but see T16 for why a maliciously crafted transcript link could still surface unrelated on-disk secrets to the screen of whoever taps it. |
| **T10** | Replayed request re-injects a prompt | TLS prevents capture; the `Idempotency-Key` makes an accidental or replayed retry a no-op for 24h. Narrowed (microviber-2, 2026-08-26): a prompt rejected with 403 on a not-taken-over session persists **no** `PromptRecord`, so a replayed rejected attempt can never be mistaken for (or replayed into) an accepted one. |
| **T11** | Prompt injection via transcript content | MicroViber never executes, auto-sends, or acts on transcript content; it only displays it. **Narrowed (microviber-track-b-4, 2026-08-31):** "only displays it" now needs a caveat — transcript-rendered markdown links are classified and a local-file/dev-server link is one tap away from the Web pane's `POST /api/webpane-token` + `GET /api/webpane/localfile` (see T16). The daemon is still never told to *execute* transcript content; the PWA now lets transcript content pick which already-accepted-as-readable path gets *displayed*. See T16 for the containment this relies on. **Narrowed (askuserquestion-answer-mechanism, 2026-09-04):** the daemon now echoes model-authored `AskUserQuestion` option labels back into the session as a user prompt — only on an explicit user tap, only labels validated exactly against the pending question's own options (`lib/claude-adapter/ask-user-question.ts`'s `validateAnswer`), in a fixed format, length-capped; the composer already allows arbitrary user text on the same route, so no new capability is granted. **The "fixed format" claim is enforced, not just asserted (code review round 1, 2026-09-04):** `AskUserQuestionInputSchema` rejects control characters (including newlines) and duplicate option labels at detection time, so a poisoned question can't smuggle extra lines into a composed answer via a multi-line label, and an answer can't be ambiguous between two identically-labelled options. |
| **T12** | Malicious local process on the laptop | Out of scope — such a process can already read the key files and write the sockets directly; MicroViber widens only network exposure, not local exposure. |
| **T13** | A hostile or malformed project file (in a repo a discovered session's folder happens to contain) manipulates dev-server port resolution — either to execute code, hang the daemon, or enroll an unintended local port into what a later story (microviber-track-b-2) uses as a reverse-proxy allowlist | `lib/webpane/port-resolver.ts`/`devports-config.ts` read `.env`, `vite.config.*`, `angular.json`, `webpack.config.*`, `package.json`, and `devports.json` as **plain text only** — `readFileSync` + regex + `JSON.parse` (a safe data parser), never `eval`/`Function`/dynamic `import()`/`require()` (proven by a test using a file that would throw if imported). Every reader stats first and rejects non-regular files (directories, FIFOs) before reading, with a size cap — a directory or named pipe at any of these paths degrades to "unresolved" (or, for `devports.json`, a clear fail-closed error) rather than crashing the process or hanging the event loop forever. Resolved ports are range-checked (1024–65535, excluding the daemon's own listening port) before being exposed via `SessionSummary.devServerPorts`, narrowing what a hostile config file can enroll into the future proxy allowlist. **(microviber-track-b-3, 2026-08-29):** the same reader now additionally runs once per immediate child directory of a session's cwd, not only cwd itself — bounded by the same protections (text-only reads, size cap, non-regular-file rejection) plus two more specific to this scan: symlinked children are excluded rather than followed (so a crafted symlink can't redirect the scan outside cwd's own tree), and the number of children *statted/scanned* is capped at 25 — the raw directory entries are sliced to 25 *before* the per-child filter + config-file-read work — so an unusually large or hostile directory tree can't turn a routine `GET /api/sessions` into an unbounded per-child stat sweep. (The `readdirSync` enumeration itself still lists every name in the directory — that can't be pre-capped with `readdirSync` — but the expensive per-child work is bounded.) (microviber-track-b-1, 2026-08-28) |
| **T14** | The dev-server proxy (`/api/webpane/devserver/:port/*`) is steered toward an unintended local service — a resolved port isn't actually a dev server | Target host is hardcoded to `127.0.0.1` in `proxy.ts`'s `proxyToLoopback`, never derived from any request input or config — only the port varies. **(microviber-track-b-3):** the live resolved-port allowlist (`listResolvedDevServerPorts()`, sourced from every known folder's `SessionSummary.devServerPorts`) now gates an entire origin's root proxy AND a raw WebSocket socket-splice — not just the old `/api/webpane/devserver/:port/*` route (deleted this story) — so both the content-plane HTTP proxy and the upgrade splice 403/refuse any cookie-bound port not currently in that set before ever connecting to loopback. The set's scan surface is a session's cwd PLUS each of its ≤25 immediate child directories (not cwd alone), and the daemon's own control port AND webpane content port are excluded from it (a resolved port equal to either can never enroll, so the proxy can't loop back onto the daemon's own front end). Accepted residual risk, inherited from T13: tiers 1 and 3 of port resolution read content from the project folder itself, so a project's own files can influence which port gets enrolled — accepted for a single-user personal tool. (microviber-track-b-2, 2026-08-28; extended microviber-track-b-3, 2026-08-30) |
| **T15** | Web-pane content (a proxied dev server, or a served local file) executes script that reaches the PWA's bearer token, storage, or control-plane API — and the `mv_webpane` cookie that authorizes that content reopens the CSRF surface T4's "header, not a cookie" mitigation was written to prevent | **Isolation model redesigned in microviber-track-b-3 (2026-08-30), after real-device testing proved the original opaque-origin design unusable:** the first design (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`, content served same-origin) forced framed content into an opaque origin, where the browser bans `localStorage`/`sessionStorage`/IndexedDB outright and treats every subresource/`fetch` as cross-site — any real app (Firebase auth, Next.js) crashes before first paint. The shipped model instead isolates by **origin separation**: (a) **Dev-server content** loads from a dedicated CONTENT origin — same hostname, second tailscale-served HTTPS port (`MV_WEBPANE_CONTENT_PORT`, default 8443, mapped to the same daemon; INSTALL.md Step 4.3b) — in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin"`. Framed apps get a real origin (working `localStorage`/`sessionStorage`/IndexedDB and `fetch`), but that origin is a *different* origin from the control plane, so framed script can never read the PWA's token/storage or call its API with ambient credentials. **The proxied dev server's `Set-Cookie` response headers are stripped** on the content plane (microviber-track-b-3): cookies are host-scoped and port-blind, so relaying an upstream `Set-Cookie` would write into the shared host cookie jar and could shadow/poison the control origin's own `mv_webpane` cookie — a framed app therefore gets client-side storage but no server-set cookies. On the content plane the daemon does no route matching at all: every path (`/`, `/_next/*`, the framed app's own `/api/*`, redirect targets) is reverse-proxied to the one loopback port the presented `mv_webpane` cookie is bound to (`WebpaneTokenStore.resolve` — the cookie is the routing key), after the same live-allowlist check as T14; the daemon's own API is structurally unreachable there (verified by test: `/api/sessions` with a valid *bearer* on the content host is proxied, not answered). **Content-plane request/response hardening (microviber-track-b-3):** every response carries `Content-Security-Policy: frame-ancestors https://<control-origin host>` (only the control-plane PWA may embed the content origin — an attacker's `<iframe>` can't, blocking clickjacking) and `Referrer-Policy: no-referrer` (a framed dev server can't leak the tailnet `host:port` to an external site); the buffered request body is capped at 10MB; and the relay strips every `access-control-*` header the dev server emits (permissive dev-server CORS would otherwise let a cross-site page READ proxied responses). **WebSocket byte-splice:** the content plane also accepts HMR/dev-server WebSocket upgrades — the daemon splices the raw client socket to a fresh loopback connection to the cookie-bound port (protocol-agnostic byte pipe, no WS framing), authed by exactly the same gate as an HTTP content-plane request PLUS an explicit Origin check: Host allowlist → Host port === content port → valid `mv_webpane` devserver cookie → port in the live allowlist → `Origin === https://<host:content-port>` (browsers always send Origin on a WS handshake, and the legitimate HMR socket is same-origin with the content origin), else the upgrade is refused. The `sec-websocket-protocol` header (which this repo uses to carry the bearer token on the control-plane `/ws` socket) is never forwarded to a dev server. (b) **Local-file content** stays on the main origin behind `GET /api/webpane/localfile` with the opaque-origin sandbox (no `allow-same-origin`) *plus* the server-sent `CSP: sandbox allow-scripts` backstop — an arbitrary local file must never run same-origin with anything. Cookie attributes (`Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300`): `Path=/` because the content origin serves at root paths and cookies are port-blind; the old browser-side `Path=/api/webpane/` bound is enforced server-side instead — the daemon ACCEPTS the cookie only on the two `/api/webpane/*` content routes and the content plane's root proxy; every other route ignores cookies entirely (verified: a valid cookie presented to the mint endpoint or `/api/sessions` on the main origin still 401s). The capability itself stays bound to exactly one resource (one port, or one path) for 5 minutes, and minting still requires the real bearer header. Residual CSRF exposure (corrected microviber-track-b-3): because the `mv_webpane` cookie is `SameSite=None`, the browser attaches it to cross-site requests too — but the content plane now rejects a cross-site **fetch/XHR/POST** (a present Origin that doesn't equal the content origin → 403) and a cross-site **WebSocket** (Origin check on the upgrade, since CORS never covers sockets), and strips all `access-control-*` from responses so CORS can't grant a read either. The honest residual is therefore narrow but real: a third-party page can still force a **top-level GET navigation** to a content-origin URL — that carries no `Origin` header (so the same-origin check can't distinguish it) and is allowed — but the user visibly leaves their own page to land on it, the cookie value is unguessable, and it grants only the one already-authorized resource for ≤5 minutes and cannot mint new capabilities. Accepted residual risks: (1) everything proxied on the content origin shares that one origin's storage — one proxied dev server can read another's content-origin storage (sequentially, via the shared origin); (2) `allow-same-origin` lets a malicious proxied dev server register a **Service Worker** at scope `/` on the content origin that outlives the 5-minute cookie and can intercept subsequently-framed dev servers' content on that origin. Both are accepted for a single-user personal tool whose proxied targets are the user's own local dev servers, and deliberately NOT extended to local files (see (b)). (microviber-track-b-2, 2026-08-28; redesigned microviber-track-b-3, 2026-08-30) |
| **T16** | A minted local-file resource (`GET /api/webpane/localfile`), once requested, causes a live read of *any* file the daemon process can read on the laptop — no folder restriction, an explicit user decision | Accepted residual risk, by explicit choice, made after the tradeoff was stated plainly — a folder-scoped alternative was offered and declined. Bounded by: `POST /api/webpane-token` re-validates the path is actually readable before minting (403/404 otherwise, not a token good for nothing); the reader (`local-file.ts`) stats the target first and refuses anything that isn't a regular file (a FIFO would otherwise hang the daemon's event loop forever with no timeout; a device file like `/dev/zero` would OOM the process) or exceeds a size cap; responses carry `x-content-type-options: nosniff` and a `content-security-policy: sandbox allow-scripts` as a server-side isolation backstop, independent of whatever client-side iframe sandboxing a later story adds. The daemon only ever serves raw bytes and never executes file content server-side. (microviber-track-b-2, 2026-08-28) **Widened (microviber-track-b-4, 2026-08-31):** before this story `navigateWebPane` had no production caller, so a `localfile` target could only ever come from the user's own dropdown pick — a path they typed or chose themselves. Now `classifyLink` derives that path from a transcript markdown link's href, and `Transcript.tsx` resolves a relative one against the session's own `cwd` with no traversal normalization, so an assistant message (or content it echoes from the repo/web) can present a link whose visible text says one thing and whose target is a different file the daemon can read — one tap away, and the resolved absolute path only becomes visible in the pane's own header *after* the tap. `WebPane.tsx` additionally persists the tapped target to `localStorage` (`mv_webpane_last`) and auto-mints + auto-opens it on the pane's next mount, with no further user gesture. The "explicit user decision" this entry's mitigation describes still holds for the *daemon's* read capability (unrestricted-by-folder is accepted, by choice), but no longer holds for *which specific path* gets read on a given open — that choice can now originate in untrusted transcript content. Residual containment, same as before: the read lands only in an opaque-origin sandboxed iframe (no `allow-same-origin`) on the tapping user's own device, behind the same bearer-gated mint and the same resource-scoped `mv_webpane` cookie (a cookie minted for file A cannot read file B) — nothing is transmitted off-device by this path. No server-side change was made or is required; this note exists so a future reader doesn't rely on the pre-story "explicit user decision" framing covering more than it now does. |

---

## 6. Engineering standards

- **Testing gate.** `npm run typecheck && npm run lint && npm test` (all workspaces —
  `daemon` and `pwa`) must be green before any commit. This is the CI gate.
- **TS strictness**, as configured in `tsconfig.base.json`: `strict: true`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `exactOptionalPropertyTypes`. `@typescript-eslint/no-explicit-any` is an eslint error —
  any `any` needs a `// reason:` comment to survive review.
- **Adapter quarantine.** Nothing outside `daemon/src/lib/claude-adapter/` touches Claude
  Code internals — `~/.claude/sessions/`, `~/.claude/projects/`, the messaging socket,
  `peerProtocol`, or the transcript entry vocabulary. `domain/` and `api/` consume only
  the adapter's normalized types (`SessionSummary`, `TranscriptEvent`,
  `OwnedSessionHandle`). This is what keeps a Claude Code upstream change a one-module
  fix instead of a repo-wide one, and it is why the version gate lives in the adapter
  too: an unrecognised `peerProtocol` degrades to read-only rather than guessing. Lint-
  enforced via FENCE 2 (§3), not review alone.
- **Layering fence.** `schemas/ → domain/ → services/ → api/`, no upward imports. The PWA
  must never import daemon internals (enforced by an eslint `no-restricted-imports`
  rule) — the only boundary crossing is HTTP/WS.
- **One `config.ts`.** All environment variables are zod-parsed once, at startup; a
  missing required variable crashes immediately rather than failing later with an
  unclear error.
- **Fail closed.** Unknown protocol version, unauthenticated request, or disallowed
  Host/Origin all reject rather than degrade into a speculative write.
- **Audit every write attempt, not only successes.** The append-only audit log records
  every prompt that reaches a session AND every rejected attempt (e.g. a 403 on a
  not-taken-over session, recorded with `mode: 'readonly'`, `outcome: 'rejected'`,
  prompt hashed exactly like the owned path). A blocked write that leaves no trace is a
  forensic blind spot; rejections are logged before the error is thrown.
  (microviber-2, 2026-08-26)
- **Isolate proxied third-party content by ORIGIN, and own its security headers.** Any
  surface that reverse-proxies content the daemon does not control (today: the Web pane's
  dev-server proxy) must serve it from a browser origin distinct from the control plane —
  never same-origin with the PWA's bearer token — and must set the security headers that
  govern that content itself (`frame-ancestors`, `referrer-policy`) rather than trusting
  or relaying the upstream's: `reply.header()` overwrites, so daemon-owned security
  headers are set on every response (including error paths) and the upstream's copies of
  those headers, plus `access-control-*`, are stripped. Cross-origin requests the relaxed
  cookie makes reachable are rejected server-side by an explicit `Origin`-equals-this-origin
  check on both the HTTP path and the WebSocket upgrade (WS is not governed by CORS, so it
  needs its own check). (microviber-track-b-3, 2026-08-30)

---

## Superseded approaches

Two earlier write-path designs were evaluated and abandoned; see
`features/microviber/findings.md` (Investigation 6, "I6") for the full evidence.

- **Peer-socket "attach send."** The original plan was to attach to an *existing*
  laptop-started session (e.g. an open VS Code tab) and send prompts to it over the
  `/tmp/cc-socks/<pid>.sock` messaging socket the same way one Claude session messages
  another. A controlled test proved this socket accepts writes only from a **registered
  Claude session** — a standalone daemon's identical write was silently dropped (I6).
  Even where it had worked in principle, it wraps every prompt in a
  `<cross-session-message>` frame that the target session is told came from a peer, "not
  typed by your user" — which meant it could never approve a pending permission/question
  in that session.
- **Superseded: a separate stdin-based launch-only mode as the *only* write path.** An earlier design
  offered a binary choice between attaching to existing sessions (peer socket, wrapped)
  or MicroViber launching and owning its own fresh sessions (stdin, unwrapped) — with no
  way to write into a session someone had already started at the laptop. Investigation 7
  (`findings.md` F13–F15) found that `claude --resume <id>` reopens **the same session
  id** and appends to **the same history file**, even while the original process is still
  alive and idle. That made takeover strictly better than owned-mode-only: any idle
  laptop-started session becomes writable, with plain (unwrapped) user turns, without
  MicroViber having had to launch it. Fresh-session creation (formerly
  `POST /api/sessions/owned`) was never the only way to get a writable session once
  takeover landed, and the dead route has since been removed from the HTTP surface
  (story 2, AC6) — the shared spawn core it used remains internal to the adapter.

<!-- microviber-3 (2026-08-26): no architecture spec changes -->
<!-- microviber-4 (2026-08-26): no architecture spec changes -->
<!-- microviber-track-b-5 (2026-09-01): no architecture spec changes -->
<!-- microviber-track-b-6 (2026-09-02): no architecture spec changes -->
<!-- microviber-track-b-7 (2026-09-02): no architecture spec changes -->
<!-- askuserquestion-answer-mechanism-2 (2026-09-05): no architecture spec changes -->
