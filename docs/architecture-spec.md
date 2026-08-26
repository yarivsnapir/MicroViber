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
| `/api/sessions/:id/prompt` | POST | bearer | Send a user turn. **Requires `Idempotency-Key` header** — 400 `INVALID_INPUT` if absent. Delegates to `sendPrompt`, which throws a typed `FORBIDDEN` error for a session that has not been taken over — the route maps this to **HTTP 403** `{success:false, error:{code:'FORBIDDEN', message:'session is read-only until taken over'}}`, and no `PromptRecord` is persisted. An owned (taken-over) session still gets `{success:true, data:<PromptStatus>}`. |
| `/api/sessions/:id/takeover` | POST | bearer | Resume an idle laptop-started session as a daemon-owned process (`claude --resume <id>`), making it writable. `FORBIDDEN` (403) if the session is not idle or is on an unrecognized Claude Code build; `NOT_FOUND` (404) for an unknown session id. |
| `/api/sessions/:id/handback` | POST | bearer | Release ownership of a taken-over session and dispose the daemon-owned process — the session reverts to read-only. Returns **HTTP 200** `{success:true, data:{id, mode:'readonly'}}`. Idempotent: calling it on a session that was never taken over (or already handed back) is a no-op that returns the same envelope. |
| `*` (GET, non-`/api`, non-`/ws`) | GET | public | SPA fallback — serves the built PWA (`pwa/dist`) as the app shell, so the phone can load the app before it has a pairing token. |

Every request gets an `X-Request-Id` (generated if absent) echoed on the response. Every
request is checked, in order, against the Host allowlist (T3, DNS rebinding), the Origin
allowlist (T4, CORS), then the bearer token (skipped only for `/api/health` and the
static shell).

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
| **T4** | A malicious site calls the API cross-origin | Strict CORS allowlist (never `*`). Auth is an `Authorization` header, not a cookie, so a cross-origin page cannot attach credentials — CSRF-resistant by construction. |
| **T5** | WebSocket bypasses CORS | `Origin` and bearer token both validated explicitly on the WS upgrade (`authorizeUpgrade`), independent of the HTTP CORS hooks. |
| **T6** | Lost or stolen phone with a paired PWA | Device lock screen is the first barrier. Revocation is immediate: rotate the daemon token and restart — every paired client dies at once. |
| **T7** | XSS in the PWA stealing the token | Transcript content rendered as sanitized markdown, never `innerHTML`/`dangerouslySetInnerHTML`; strict CSP, no third-party script origins, no inline script, no `eval`. |
| **T8** | Token leaks via logs, URLs, or screenshots | Token travels in a header, never a query param or body. The pairing URL carries it in the fragment, which browsers never send to a server. |
| **T9** | `~/.claude` secrets exfiltrated through the API | The daemon reads `peerToken` values for discovery only and never returns or logs them; `SessionSummary` is an explicit allowlist of fields. |
| **T10** | Replayed request re-injects a prompt | TLS prevents capture; the `Idempotency-Key` makes an accidental or replayed retry a no-op for 24h. Narrowed (microviber-2, 2026-08-26): a prompt rejected with 403 on a not-taken-over session persists **no** `PromptRecord`, so a replayed rejected attempt can never be mistaken for (or replayed into) an accepted one. |
| **T11** | Prompt injection via transcript content | MicroViber never executes, auto-sends, or acts on transcript content; it only displays it. |
| **T12** | Malicious local process on the laptop | Out of scope — such a process can already read the key files and write the sockets directly; MicroViber widens only network exposure, not local exposure. |

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
