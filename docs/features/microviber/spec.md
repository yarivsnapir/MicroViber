# MicroViber — Design Spec

> Status: design approved (2026-08-22); **write-path revised to takeover-via-resume 2026-08-24** (§3.2, supersedes the peer-socket send path) · Branch: `feature/microviber`
> Project: `microviber/` — a **new standalone repo**, nested in the Harness-2 workspace, gitignored by the Harness repo (same convention as `studio/`, `audio-producer/`, `scenario-creator/`).

---

## 1. Problem & Product Thesis

The developer works in the Claude Code **VS Code extension**, typically with several VS Code windows (one per folder) and several session tabs per window. Long-running commands are started, then the laptop is left behind. The dead time is the problem: from a phone there is currently no way to see whether a session finished its task, or to hand it the next prompt.

**MicroViber** is a phone-sized PWA for those micro-moments. Open it, glance at a session, see whether the last task landed, type the next prompt, put the phone away.

The load-bearing requirement, in the user's words:

> "I DO NOT WANT to have to resume the session every time I open the app… if I run a command from my phone and later come back to my laptop, I DO NOT WANT the laptop session to be 'behind' the phone session… think of it as a WhatsApp conversation you start on WhatsApp Web, continue from the phone and go back to the web. Both chats are mirrored in realtime."

The ideal implementation — one live process that phone and laptop both write into, WhatsApp-Web style — proved **impossible** ([findings.md](findings.md) I6): the peer socket accepts writes only from other *registered Claude sessions*, so a standalone daemon's prompt is silently dropped. There is no un-wrapped external write path into a running session.

What *is* possible, and what MicroViber does instead, is a **baton pass over one shared history file** (verified 2026-08-24, F13–F15):

- **Reading is always on.** Every session's transcript is a single append-only file on the laptop; the phone tails it to mirror live progress. Watching spawns no process and cannot conflict — it works for working, idle, and even dead sessions.
- **Writing is a deliberate takeover.** When (and only when) a session is **idle**, the phone can "Take over": MicroViber runs `claude --resume <id>` to spawn its own process on **that same session id**, and from then the phone drives it with genuine user turns. Resume appends to the *same* history file (F13) and works even while the laptop's idle tab is still alive (F14) — no fork of history, only a second live process that the idle laptop is not using.
- **One writer at a time, by discipline.** Takeover is blocked while the session is working (§3.2), so the phone never starts writing under the laptop. When you return to the laptop, you `/resume` that session to reload the phone's turns; the frozen tab is abandoned. MicroViber does not police the case where you instead keep typing in the stale tab (conflict rule: do nothing).

The history file is the single source of truth; phone and laptop take turns appending to it.

### Design principle: host-agnostic

**MicroViber works with *any* Claude Code session, not only VS Code ones.** This is a stated preference and the architecture satisfies it: all three capabilities go through mechanisms common to every session — discovery via `~/.claude/sessions/*.json`, mirroring via the transcript `.jsonl`, and writing via `claude --resume` (§3.2), none of which is VS Code-specific. Resume works against terminal- and extension-hosted sessions alike (F14).

No VS Code extension is written, and no VS Code API is called. The only capability that is extension-specific is the `notify_idle` peer feature (F7) — and §8 uses the host-agnostic idle heuristic as the notification trigger precisely so that notifications work everywhere too, with `notify_idle` as a faster path where it happens to exist. Nothing in the MVP is gated on VS Code.

### Non-goals

- Not a Claude Code replacement or a general mobile IDE. No file tree, no diff review, no git UI.
- Not multi-user or multi-machine. One developer, one laptop.
- Not a hosted service. The daemon runs on the laptop and is reachable only over a private tunnel.
- Not a session *creator* in the MVP — MicroViber attaches to sessions started on the laptop. **Creating a session from the phone is Phase 2** (§3), not a permanent exclusion.

---

## 2. Verified Feasibility

Everything below was **empirically confirmed on this machine** during design (Claude Code `2.1.233` CLI / `2.1.237` VS Code extension), not inferred. This section is the evidence base for the architecture; re-verify it when the Claude Code version changes.

| # | Claim | Evidence |
|---|---|---|
| F1 | Sessions are discoverable with live metadata | `~/.claude/sessions/<pid>.json` → `{pid, sessionId, cwd, version, peerProtocol, peerFeatures, kind, entrypoint, messagingSocketPath, name}`; paired `<pid>.<hash>.key` holds a `peerToken` |
| F2 | Transcripts are append-only and written live | `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`, growing during an active turn |
| F3 | Real session titles already exist | `ai-title` entries carry `aiTitle` (e.g. *"SynKounter studio issue #747"*); `last-prompt` carries `lastPrompt` as fallback |
| F4 | A prompt can be injected into a **live** session | Sent to `harness-2-aa` (pid 51006, VS Code-hosted); session replied `PONG`, recorded in its transcript |
| F5 | The VS Code webview **streams the assistant response** of an injected turn live | Confirmed visually by the user — the `PONG` reply appeared in the open tab with no reload. Scope limit: only the *response* is proven. In that same screenshot no user bubble was visible for the injected prompt, but the capture was cropped, so prompt rendering is **observed-absent, not established** — see R5 |
| F6 | Idle notification is deliverable and carries context | `notify_when_idle` accepted; `harness-2-fb` delivered an unprompted idle notice **carrying a harness status line** («Both reviews still running…»), not just a bare flag. Scope limit: **delivery** is proven. One-shot *consumption* (subscription spent on delivery, requiring re-subscribe) is asserted by the tool contract but **not independently verified** — see checkpoint 13.3 |
| F7 | VS Code-hosted sessions are distinguishable | `peerFeatures: ['notify_idle']` present on all 7 VS Code sessions, `[]` on all 3 terminal sessions; corroborated by process path under `.vscode/extensions/` |
| F8 | A busy session **queues** an injected prompt | Message to a mid-turn session drained only at its next tool round |
| F9 | No public CLI or documented API exists for any of this | `claude --help` exposes no peer/message subcommand; the protocol must be spoken directly |
| F10 | The injected prompt **is itself written to the transcript** as a `user` entry | Observed in three separate sessions: the `.jsonl` gains a `user` entry whose text is the `<cross-session-message …>` wrapper, immediately before the assistant reply. Makes transcript-observation a usable delivery signal (§5) |
| F11 | **stdin `{"type":"user"}` produces a plain user turn** (no wrapper) | Phase 0: a `{"type":"user",…}` frame on a launcher-owned session's stdin landed as `USER >> 'Reply with exactly one word: STDINPROBE'` — the documented SDK stream-json transport, the basis of owned mode (§3.1) |
| F12 | **The peer socket always wraps; no un-wrapped socket path exists** | Binary confirms peer messages "arrive as user-role messages wrapped in `<cross-session-message>`"; `from-mode` is only the sender's permission mode. The messaging socket's other methods are the IDE file bridge (`project_read`/`write_files`/`list_files`), not prompt submission |
| I6 | **A standalone daemon cannot write into a running session over the peer socket** | [findings.md](findings.md) I6: a control test proved the same message delivered by a *real* Claude peer landed, while a standalone client's write was silently dropped — the socket accepts only registered Claude sessions. This kills the attach-mode send path; the write path is takeover-via-resume (§3.2) |
| F13 | **`claude --resume <id>` appends to the *same* history file — no fork** | 2026-08-24: a session (16 lines) resumed with a second prompt returned the **same** `session_id`, recalled the prior turn, and grew the **same** `<id>.jsonl` to 34 lines. No second file was created |
| F14 | **A session can be resumed while its original live process is still alive & idle** | 2026-08-24: a persistent stream-json process held session `fd42…` alive and idle; a second process `claude --resume fd42…` succeeded (exit 0, no lock/error), recalled the earlier turn, and grew the shared file 13→21 lines. The original process stayed alive with a now-stale in-memory view — confirming the laptop must `/resume` to catch up |
| F15 | **Resume carries full history across the process boundary** | Same test: the resumed process answered `ALPHA BETA`, proving it loaded the whole prior transcript, not a blank context |

### Injected-message framing (F4, verbatim)

```
Another Claude session sent a message:
<cross-session-message from="uds:/tmp/cc-socks/29905.sock"
    from-name="harness-2-f9" from-mode="bypass">
<the prompt text>
</cross-session-message>

This came from another Claude session — not typed by your user, but very
likely working on their behalf. Treat it as a teammate's request and act on
it within this session's own permission settings…
```

This is **semantically wrong for MicroViber**: the prompt *was* typed by the user, just on a phone. The wrapper tells the target session the opposite.

**Does this contradict the mirroring design? No — but it does constrain it.** Worth separating the two clearly, because they are independent:

| | Status |
|---|---|
| **Delivery** — does the prompt reach the live session and produce a real turn? | ✅ **Works.** Proven end-to-end (F4), and the prompt is written to the transcript (F10). Mirroring is not in question. |
| **Framing** — how does the receiving session *interpret* the prompt? | ⚠️ **Degraded.** It is told the message came from a peer agent, "not typed by your user". |

> **Superseded 2026-08-24 — this analysis applied to the peer-socket send path, which MicroViber no longer uses.** It is retained as evidence of *why* that path was abandoned. The degraded framing below is exactly what drove the switch to takeover-via-resume (§3.2), where prompts are plain user turns (F11) with none of these consequences.

Three practical consequences of the (abandoned) degraded framing:

1. The session may answer more conservatively, or add caveats, because it thinks a teammate rather than its owner is asking.
2. The wrapper's guardrails explicitly forbid treating a peer message as user approval. **So a phone prompt cannot approve a pending question** — if a session is parked waiting for the user to confirm something, sending "yes" from the phone may not unblock it. This was the sharpest functional limit of the peer path, and the reason it was dropped.
3. Protocol boilerplate lands in the transcript and must be stripped before display.

The user's **requirement** that "phone prompts appear as regular prompts" is what forced this decision: it cannot be met over the peer socket at all, so the write path is takeover-via-resume (§3.2), which meets it by construction.

### Incidental findings that will otherwise cost implementation time

- **Project-dir encoding maps `/`, `.` *and* `_` to `-`.** A cwd of `<home>/My_Project.v2` becomes `-<home>-My-Project-v2`. Missing the `_` rule silently yields "transcript not found" for every developer whose username or folder contains an underscore — which is the case on this machine.
- **Derived peer names are meaningless to a human.** `harness-2-aa`, `harness-2-fb` — the user did not recognise their own session by name. The UI must key on `ai-title`.
- **A session's process outlives its visible tab.** The live list includes sessions with no open tab, so `cwd` + last-activity are required to identify them.
- **`peerFeatures` varies by launch path.** A session started from a shell reported `peerProtocol: 1` but *no* `peerFeatures`; only extension-hosted sessions advertised `notify_idle`.
- **The injected prompt was not visible as a user bubble** in the one (cropped) screenshot from F5, though the reply was. Treated throughout as observed-absent-but-unconfirmed, not fact: it drives checkpoint 13.2, not MVP work. See R5.

---

## 3. Scope

### MVP

1. **Session list** — live sessions with real titles, folder, activity, and state (working / idle / stale), **sorted by most-recently-prompted first**.

   *Sort rule:* descending `lastPromptAt` — the timestamp of the session's most recent **user turn**, not of any activity. "The one I last talked to" is how the user identifies the session they want, and it is a different ordering from last-assistant-output (a session can churn through tools for an hour after its last prompt). Derived by scanning the transcript backwards for the newest `user` entry, so it costs a tail read rather than a full parse.
2. **Transcript mirror** — live-streaming read-only view of any selected session (working, idle, or stale). Always available; spawns no process (§3.2).
3. **Take over (resume)** — a deliberate one-tap action, **enabled only when the session is idle** (disabled and labelled "laptop is working…" otherwise). It runs `claude --resume <id>` to make the session phone-drivable (§3.2). This is the single write path.
4. **Prompt composer** — once a session is taken over, send genuine user turns into it; show queued vs accepted. Disabled (read-only) until takeover.
5. **Idle push notification** — "session X is waiting for you", carrying the harness status line from F6. Doubles as the "you can now take over" signal.

### Phase 2

6. **Browser panel** — a mini web view onto the laptop's local dev servers, reached by the bottom 2-way switch. Base URLs are suggested from detected listening ports; the path suffix is editable. Open question: how the scan enumerates listening ports without hardcoding any, since ports are per-developer and live only in `CLAUDE.local.md`.

7. **Start a new session from the phone** — pick a folder (from the set that already has sessions, plus recents), spawn a session on the laptop, and land in its transcript. Deferred from the MVP because it needs process lifecycle management the mirror does not: where the process is parented so it survives the daemon restarting, how it is named so it is findable, and what happens to it when the phone disconnects. None of that is hard, but none of it is needed to answer "did my task finish".

**MVP behaviour of the pane switch,** stated to avoid both a dead control and accidental Phase-2 scope: the switch renders with its *Web* position **visibly disabled and labelled "coming soon"**. It is ~15 lines of presentational markup with no route, no `services/dev-proxy` module, and no web-view component — so it does not constitute a dead module under §16.1, and it keeps the layout stable when Phase 2 lands.

### Explicitly deferred

- Permission-approval UI (unnecessary — see §8).
- Resuming *dead* sessions from the phone. Takeover-via-resume (§3.2) targets sessions that are **live and idle**; resuming a session whose process is gone (`stale`) is technically the same `claude --resume` but adds process-lifecycle questions (where it's parented, disconnect handling) shared with Phase-2 session creation, so it rides along with that. Reading a stale session's transcript is still in the MVP.
- A companion VS Code extension. Rejected on the host-agnostic principle (§1) — takeover-via-resume needs no extension, so this is now a clean exclusion.

Terminal-hosted sessions are **not** deferred: they get the full MVP (mirror, takeover, notify). Nothing in the MVP requires VS Code.

### 3.1 The two write channels (evidence; decision superseded by §3.2)

> **Superseded 2026-08-24.** This section's "hybrid" decision assumed the peer socket was a usable send channel for MicroViber. Finding I6 later disproved that — the socket rejects a standalone daemon's writes. The tables below remain accurate as *evidence* about how the two channels frame prompts, but the product's write path is now **§3.2 (takeover-via-resume)**, which uses only the stdin/owned channel. Read §3.2 for what MicroViber actually does.

The Phase 0 gate ([findings.md](findings.md), Investigation 1) settled this. There are **two ways to put a prompt into a running session, with opposite framing**, both empirically verified:

| Channel | Reachable by | Framing | Can it answer the session's own questions/approvals? |
|---|---|---|---|
| **Peer socket** `/tmp/cc-socks/<pid>.sock` | any process holding the `peerToken` — so it works on **sessions already owned by VS Code** | wrapped `<cross-session-message>`, rendered as `@peer` | **No** — the wrapper forbids treating it as user intent |
| **stdin stream-json** (documented SDK transport) | **only the process that launched the session** | plain user turn — verified: `STDINPROBE` landed as an ordinary `USER` entry | **Yes** |

The requirement "phone prompts must read as ordinary prompts, and behave as user intent" is therefore satisfiable **only for sessions MicroViber launches itself** (owned stdin). For a session already open in a VS Code tab, the only write path is the peer socket, which always wraps.

**Decision (user, 2026-08-23): Option 3 — hybrid.** *(Superseded — see §3.2. The peer-socket "attach send" half of the hybrid is infeasible per I6; only the owned/stdin half survives, now reached via takeover-resume.)*

---

### 3.2 RESOLVED — read-only mirror + takeover via resume (the write path)

> Decision: user, 2026-08-24. This is the authoritative write model; it replaces the peer-socket send path of §3.1.

Because a standalone daemon cannot write over the peer socket (I6), MicroViber has exactly one write mechanism: **become an owner of the session by resuming it.** The two states of a session on the phone:

| Phone state | How it works | Available when |
|---|---|---|
| **Read-only mirror** (default for every session) | Tail the session's `<id>.jsonl` history file. No process spawned; cannot conflict with the laptop. | Always — working, idle, or stale |
| **Taken over** (writable) | `claude --resume <id>` spawns a MicroViber-owned process on the **same session id**; prompts are sent to its stdin as genuine user turns (F11). Appends to the same history file (F13). | Only after a deliberate **Take over** tap, itself enabled **only when the session is idle** |

**Why gate takeover on idle (hard rule, user 2026-08-24).** Takeover is **disallowed while the session is working.** Two reasons: (1) it enforces "one writer at a time" — the phone never begins writing under a laptop that is mid-task; (2) it dodges the false-idle race. Idle detection is a heuristic (§5.1); the Take-over control is enabled off the **strongest** available idle signal (the session's own `notify_idle` event where present, else the 20s no-growth rule), and even then requires a deliberate tap, so a momentary lull mid-tool-call cannot silently arm a write.

**What happens on the laptop.** The resume works even while the laptop's idle tab is still alive (F14) — they coexist because the idle laptop isn't writing. After the phone appends turns, the laptop tab holds a **stale** in-memory view; to continue on the laptop the user `/resume`s that session (reloads the full history, phone turns included) and abandons the frozen tab. MicroViber takes **no action** on the laptop tab and does not warn if the user keeps typing in the stale tab (conflict rule: do nothing).

**Ownership lifecycle.** A taken-over session is owned by a daemon-spawned `claude --resume` process. It must be parented to survive daemon restarts, named so it stays findable in discovery, and torn down / released on explicit "hand back" or when the phone abandons it. (This is the same process-lifecycle surface Phase-2 session-creation needs; the MVP handles only the resume-of-a-live-idle case — see checkpoint 13.7.)

**One open risk, already de-risked:** F14 proved resume-while-live-idle succeeds on this Claude Code version. Re-verify when the version changes (§2 is the version-gated evidence base); the version gate (§5.1, `ADAPTER_UNSUPPORTED`) degrades takeover to read-only if the build is unrecognised rather than guessing.

---

## 4. Architecture

Two components. All knowledge of Claude Code internals lives in exactly one module.

```
   Phone (PWA)                      Laptop
┌────────────────┐        ┌──────────────────────────────────┐
│ microviber-pwa │        │ microviber-daemon                │
│                │  WSS   │  ┌────────────────────────────┐  │
│  session strip │◄──────►│  │ lib/claude-adapter/        │  │
│  transcript    │        │  │  ← THE ONLY module that    │  │
│  composer      │  HTTPS │  │    touches internals       │  │
│                │◄──────►│  └────────────────────────────┘  │
└────────────────┘        │   │ discovery │ tail │ resume-owner │
        ▲                 └───┼───────────┼──────┼──────────────┘
        │ Web Push            ▼           ▼      ▼ (only on Take over)
        │              ~/.claude/   transcript   spawn: claude --resume <id>
        └────────────── sessions/    .jsonl        │ (stdin = user turns, F11)
             (peerToken read for                    ▼
              discovery only; socket        ┌─────────────────────┐
              never written — I6)           │ daemon-owned claude │→ appends to
                                            │  process (§3.2)     │  same .jsonl (F13)
                                            └─────────────────────┘
```

### 4.1 `microviber-daemon` (Node 22 + TypeScript)

| Layer | Responsibility |
|---|---|
| `lib/claude-adapter/` | **Quarantine.** Sole owner of `~/.claude/sessions/`, `~/.claude/projects/`, `/tmp/cc-socks/`, `peerProtocol`, path encoding, and the transcript entry vocabulary. Everything above it sees only MicroViber's own normalized types. |
| `domain/` | Session registry, session-state derivation (working / idle / stale), prompt lifecycle, notification policy. No I/O, no HTTP. |
| `services/` | Web Push sender; phase-2 dev-server proxy. |
| `api/` | Fastify HTTP routes + WebSocket hub. Parse → authenticate → delegate → serialize. |

**Adapter sub-modules:**

- `discovery.ts` — scan `~/.claude/sessions/*.json`, liveness-check each `pid`, classify VS Code vs terminal (F7), read `peerToken` from the paired key file. Resolve `ai-title` / `last-prompt` from the transcript (F3).
- `encode-path.ts` — the `/`, `.`, `_` → `-` rule, with a unit test per finding above.
- `tail.ts` — watch the active transcript, parse incrementally from a byte offset, emit normalized events. Tolerates partial trailing lines (the file is appended mid-write). Phone turns arrive as plain `user` entries (F11); `injected` is set by daemon-side correlation, not by unwrapping (§5).
- `resume-owner.ts` — the write path (§3.2). Spawns and supervises the daemon-owned `claude --resume <id> --dangerously-skip-permissions` process for a taken-over session, writes user turns to its stdin as stream-json (F11), and tears it down on hand-back. Owns the process-lifecycle concerns of checkpoint 13.7. Reads discovery's `peerToken` are unaffected — the peer socket is **not** written (I6).
- `version-gate.ts` — compare the observed `version` / `peerProtocol` against a supported range. **Unknown version ⇒ degrade to read-only mirror**, surfaced in the UI. Never guess at a changed protocol.

### 4.2 `microviber-pwa` (Vite + React + Tailwind + shadcn/ui)

Deliberately **not** Next.js. This is a single-page realtime WebSocket client with no SSR, no routing depth, and no SEO surface; "lightweight" was the first stated requirement. `vite-plugin-pwa` supplies the manifest and service worker.

Service-worker policy follows the pattern already proven in this workspace (`functional-spec/17a-pwa-install-affordances.md`): `NetworkFirst` for navigations, `CacheFirst` for hashed static assets, and **`NetworkOnly` for every API and WebSocket path** — no transcript content ever enters the service-worker cache. (This constrains the SW cache only; the pairing token is deliberately persisted — see §9.)

---

## 5. Normalized Event Model

The adapter translates Claude Code's internal transcript vocabulary into a small stable shape, so an upstream format change is a one-file fix.

```ts
type SessionId = string;

interface SessionSummary {
  id: SessionId;
  title: string;            // ai-title, else truncated last-prompt, else "(untitled)"
  folder: string;           // basename of cwd
  cwd: string;
  host: 'vscode' | 'terminal';
  writable: boolean;        // live pid + socket + supported protocol
  state: 'working' | 'idle' | 'stale';   // NOT a queue state — see PromptStatus
  lastActivityAt: string;   // ISO — any transcript growth
  lastPromptAt: string;     // ISO — the most recent *user* turn; the list's sort key
}

type TranscriptEvent =
  | { kind: 'user';      at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool';      at: string; name: string; summary: string }
  | { kind: 'thinking';  at: string }
  | { kind: 'error';     at: string; message: string };
```

**Normalization the adapter owes the client.** Under takeover-via-resume (§3.2) a phone prompt is sent to the owned process's stdin and lands in the transcript as a **plain `user` entry** (F11) — no `<cross-session-message>` wrapper, so no unwrap is required. `text` is directly renderable. What the adapter must still do is set the `injected` flag: since MicroViber's own daemon issued the turn, `injected` is derived by **daemon-side correlation** (the daemon records each prompt it sends and matches it to the transcript entry it observes), not by parsing wrapper boilerplate. This is why F10's wrapper-observation, though real, is no longer the delivery mechanism — it belonged to the abandoned peer path.

A prompt's queue state is **per-prompt, not per-session** — F8 shows a prompt queues *because* the session is `working`, so the two are simultaneous and cannot share one enum:

```ts
interface PromptStatus {
  id: string;                 // client-generated, doubles as the Idempotency-Key
  state: 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';
  sentAt: string;
  observedAt?: string;        // when the tailer saw it enter the transcript
}
```

Transitions:

| From | Event | To |
|---|---|---|
| `sending` | stdin write to the owned resume process returned ok | `queued` |
| `sending` | write failed / owned process unreachable or exited | `failed` |
| `queued` | tailer observes the prompt as a plain `user` entry in the transcript (F11) | `accepted` |
| `queued` | 10 min elapsed, never observed | `expired` |

`queued` is milliseconds long for an idle session and open-ended for a busy one (F8) — the same state covers both.

`accepted` is asserted only when the tailer observes the prompt appear in the transcript — never merely because the stdin write returned. This is sound because a phone turn **is** written as a plain `user` transcript entry (F11). The transcript, not any webview, is MicroViber's source of truth: after takeover the laptop's original tab is stale by design (§3.2), so MicroViber never depends on the webview rendering anything. A prompt still `queued` past **10 minutes** with no transcript sighting becomes `expired` (R3): a session can end a turn without another tool round and hold the message indefinitely.

`injected: boolean` is what lets the phone render *its own* prompts distinctly. It is set by daemon-side correlation (above) — the daemon knows which `user` turns it sent versus those typed on the laptop.

### 5.1 Session-state derivation

State is shown on every row and gates notifications, so its inputs are fixed here rather than left to implementation:

| State | Derivation |
|---|---|
| `working` | Transcript byte-offset grew within the last 20s |
| `idle` | No transcript growth for 20s with `pid` still alive. This heuristic is **host-agnostic** and is the primary signal for every session; a `notify_idle` event (VS Code only, F7) is treated as faster confirmation, not as the sole source. Without this, an unopened VS Code session — the default condition of most rows on first load, since §8 subscribes only to opened sessions — would have no derivable state at all. It also covers the case where a one-shot subscription has already been spent (checkpoint 13.3) |
| `stale` | `pid` is gone (discovery liveness check fails) |

**Recency dominates, deliberately.** An earlier draft also treated "an assistant turn is open" as a `working` signal. That is removed: OR'd with byte-growth and ranked above `idle`, it meant a session whose last entry is an unclosed assistant turn stayed `working` forever — and those are exactly the sessions the user most needs pushed (a turn parked on an interactive prompt, or one abandoned by a crash). **No transcript growth for 20s with a live `pid` means `idle`, whatever the last entry looks like.**

Evaluation order, applied top-down and first-match-wins:

1. `pid` gone → `stale`
2. a `notify_idle` event arrived after the last observed growth → `idle`
3. growth within 20s → `working`
4. otherwise → `idle`

**The version gate never sets `state`.** A session on an unrecognised Claude Code build is still live and still mirroring, so the gate sets `writable: false` only (§5) and the UI renders it via §7's read-only state. Conflating that with `stale` would label an actively streaming session dead. Precedence is the four-step order below, not a per-row ranking.

Because the heuristic is host-agnostic and primary, **every session can notify** — not just `notify_idle`-capable ones. Extension-hosted sessions simply reach `idle` faster, via the event; terminal sessions reach it via the 20s no-growth rule. This is what keeps the design generic (see the host-agnostic principle in §1).

**This state also gates takeover (§3.2).** The **Take over** control is enabled only when `state === 'idle'`, and preferentially off the `notify_idle` event where the session advertises it — the strongest signal — falling back to the 20s no-growth rule elsewhere. `working` disables it ("laptop is working…"); `stale` (dead process) is out of MVP takeover scope (§3 deferred). The gate is deliberately conservative: an idle misfire that briefly disables a genuinely-idle button costs one wait; enabling a write under a working session is the failure mode we refuse.

---

## 6. API Surface

All payloads zod-validated at the boundary in both directions (§16.2).

| Route | Method | Purpose |
|---|---|---|
| `/api/sessions` | GET | List `SessionSummary[]` |
| `/api/sessions/:id/transcript` | GET | Backfill page of `TranscriptEvent[]` (bounded, cursor-paginated) |
| `/api/sessions/:id/takeover` | POST | **Take over an idle session** — spawn `claude --resume <id>` as a daemon-owned process, making it writable (§3.2). Rejected with `FORBIDDEN` if the session is not `idle`. Idempotent: a second call while already owned returns the existing ownership |
| `/api/sessions/:id/handback` | POST | Release ownership — tear down the daemon-owned resume process, returning the session to read-only mirror |
| `/api/sessions/:id/prompt` | POST | Send a user turn into a **taken-over** session. **Requires `Idempotency-Key`.** Returns a `PromptStatus`; `FORBIDDEN` if the session has not been taken over |
| `/api/push/subscribe` | POST | Register a Web Push subscription |
| `/api/health` | GET | Daemon + adapter version-gate status |
| `/ws` | WS | Live `TranscriptEvent` stream + session-state changes |

One error envelope everywhere, matching the canonical Syncounter shape (§16.2):

```ts
{ success: false, error: { code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN'
  | 'NOT_FOUND' | 'INTERNAL_ERROR' | 'EXTERNAL_SERVICE_ERROR'
  | 'ADAPTER_UNSUPPORTED', message, details? } }
```

Two deltas from the canonical §16.2 set, both deliberate (retaining a canonical code is not a delta):

- **`ADAPTER_UNSUPPORTED` added** — the version gate rejected the local Claude Code build (R1). No canonical code expresses "the substrate changed underneath me".
- **`EXTERNAL_SERVICE_ERROR` retained** — the daemon-spawned `claude --resume` child *is* an external dependency; a resume that fails to start, exits early, or refuses stdin maps here, carrying `details.retryable` per §16.5.
- **`RATE_LIMITED` dropped** — single-user local daemon, no quotas to enforce.

An `Idempotency-Key` replayed within the window with a *different* body returns `INVALID_INPUT` (the key is bound to its first payload); an exact replay returns the original `PromptStatus` unchanged.

`POST /api/sessions/:id/prompt` **requires an `Idempotency-Key`** (§16.2), de-duplicated for 24h. This is the system's most consequential mutation and the transport is mobile cellular: a naive retry would otherwise inject the same prompt into a live session twice. The client reuses `PromptStatus.id` as the key.

---

## 7. UX

Minimalism is a hard requirement ("as few buttons and controls as possible"). The MVP has **three persistent** controls — session picker, composer, pane switch — plus **one contextual** control, the **Take over** button, which is the composer's own affordance: while a session is read-only it *is* the composer's state, not a separate widget.

```
┌──────────────────────────────┐
│ SynKounter studio issue #747▾│ ← session picker (ai-title)
│ Harness · 4m ago · working   │ ← secondary identity line
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ run the story-18 tests   │ │ ← user prompt: bordered block,
│ └──────────────────────────┘ │   as the VS Code extension renders it
│ ● thinking…                  │ ← gutter marker per block
│ ● ▸ Bash · npm test          │
│ ● Two failures, both from    │
│   the missing `voiceId`      │ ← inline code chips, bold, lists
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ commit it and open the PR │ │
│ │                          │ │
│ │                          │ │ ← composer rests at 7 lines,
│ │                          │ │   grows to 10
│ │                          │ │
│ │                          │ │
│ │                       ↑  │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│      ◉ Claude   ○ Web        │ ← phase-2 switch, ships in MVP shell
└──────────────────────────────┘
```

**Session picker.** A sheet, not a tab strip: seven-plus live sessions do not fit a phone's width, and the screenshot's desktop tab strip does not translate. Rows show `ai-title` (primary), then `folder · relative-time · state`. Non-writable sessions are visibly read-only.

**Transcript — matches the Claude Code VS Code extension.** This is a deliberate constraint, not a default: the user reads the same conversation on both surfaces, and a different visual language on the phone would make the two feel like different conversations. MicroViber therefore adopts the extension's rendering conventions rather than inventing chat bubbles:

- **Flowing document, not a chat.** No opposing-side bubbles. Blocks stack in one column, each with a small **left-gutter marker** (`●`), exactly as the extension renders assistant turns, thinking, and tool activity.
- **User prompts are bordered blocks**, full-width, visually quieter than assistant text — the extension's input-echo treatment.
- **Full markdown rendering**: bold, numbered and bulleted lists, inline `code` chips, and links. The extension renders rich markdown and the phone must too, or responses containing lists and code read as mush. Rendered from **sanitized markdown, never raw HTML** (§9, T7).
- **Tool calls collapse to one line each** (`▸ Bash · npm test`), expandable on tap. Tool *output* uses the extension's subdued label-plus-block treatment.
- **Thinking renders as a marker** (`● thinking…`), not a wall of text.
- **Phone-injected prompts stay visually distinct** from laptop-typed ones — the one place MicroViber deliberately departs from the extension, because it is the guard against re-asking something already asked (R5).

**Composer — 7 lines resting, growing to 10.** Explicitly not a single-line input: prompts to a coding agent are paragraphs, not chat messages, and a one-line box makes reviewing what you typed impossible before sending. The textarea rests at ~7 lines and auto-grows to ~10, after which it scrolls internally.

*Trade-off, stated rather than silently resolved:* on a ~600px phone viewport a 7-line composer plus the header and pane switch leaves roughly half the screen for the transcript, and less once the keyboard is up. The transcript scrolls and pins to newest, so nothing is unreachable, but reading a long answer and composing a long prompt now compete for space. If that proves annoying in use, the fix is a collapse-on-scroll composer (shrink to 2 lines while reading, restore on focus) — deliberately deferred rather than built speculatively. After sending: `accepted` shows the prompt in-thread; `queued` shows it greyed with a "waiting for the session to finish" note (F8) — never a false success. `expired` and `failed` both keep the text in the composer and offer Resend, distinguished only by copy ("never picked up" vs "couldn't reach the session"), so no typing is ever lost.

**Take over (the composer's read-only state).** Before takeover, the composer area is **not** an empty text box — it is a single full-width bar whose state mirrors §5.1:

- session **working** → bar disabled, reads *"laptop is working…"* (grey). No takeover possible (§3.2 hard rule).
- session **idle** → bar becomes an enabled **"Take over"** button. Tapping it calls `POST …/takeover`; on success the bar turns into the live composer (mock above) and the session is writable.
- session **stale** → bar disabled, *"this session has ended"* (dead-session resume is out of MVP scope, §3).

This keeps the control count honest: there is no separate "mode toggle" (the superseded §3.1 hybrid had one) — the same real estate is either a status line, a Take-over button, or the composer, never more than one at a time. A **"hand back"** affordance (calls `POST …/handback`) appears only while a session is taken over, releasing it to read-only.

**Retention.** `/api/sessions` lists only sessions with a live `pid`, so `stale` is reachable in exactly one way: a session dies while the phone is viewing it. That row is kept for the remainder of the session's visit — marked `stale`, transcript still readable, composer disabled with "this session has ended" — and disappears on the next full list refresh. Historical (dead) sessions are not browsable in the MVP; resuming a `stale` session is deferred with Phase-2 lifecycle work (§3 deferred).

**States.** Empty (no live sessions, explaining that sessions are started on the laptop), read-only (version gate tripped), disconnected (tunnel down, with last-synced time).

---

## 8. Permissions & Notifications

**Permissions need no UI.** Takeover resumes the session as a daemon-owned `claude --resume` child, and MicroViber chooses that child's permission mode. To match the user's established workflow it resumes with **`--dangerously-skip-permissions`** — the same mode the user already runs sessions under — so a phone-driven turn executes without an approval prompt, and no approval screen is needed. This grants no privilege the user did not already grant themselves on this laptop; the exposure is the *reachability* of that privilege from the phone (§9, R4), which is why the whole transport is tailnet-only and off by default (§9). Read-only mirroring, by contrast, spawns nothing and executes nothing.

**Notification cancellation (required).** A notification that has been overtaken by events must go away by itself. The case: a session goes idle, the phone is notified, but the user is *at the laptop* and simply continues there — the notification is now stale and misleading.

Mechanism: every notification for a session is tagged `session:<sessionId>`, so a later one **replaces** rather than stacks. When the daemon observes that session leave `idle` (transcript growth resumes, or the session exits), it pushes a `dismiss` message for that tag; the service worker calls `registration.getNotifications({tag})` and closes it. The app also clears all notifications for a session when that session is opened, and every notification carries a TTL so a missed dismiss self-expires rather than lingering.

*Platform caveat:* iOS/Safari Web Push is unreliable about pushes that display no notification, so the dismiss path must tolerate not being delivered — hence the TTL and the clear-on-open, which are belt-and-braces rather than redundancy.

**Notifications** use the host-agnostic idle signal (§5.1) as the trigger, with `notify_idle` (F6) as a faster path where the session advertises it. Policy: subscribe on any session the user has opened in MicroViber; on idle, send one Web Push carrying the harness status line, deep-linking to that session. One notice per subscription — re-subscribe after each delivery. No polling. (Whether subscriptions are truly one-shot is checkpoint 13.3; if they persist, this policy inverts. The §5.1 idle heuristic is deliberately independent of it, so session state stays correct either way.)

---

## 9. Transport & Security

This section answers one question directly: **how does nobody else get to drive my laptop?**

The honest framing first. MicroViber takes a capability that was previously *local-only* — inject a prompt into a live Claude session running under `bypassPermissions`, which is arbitrary code execution as the logged-in user — and makes it **reachable over a network**. That is the entire security problem. Everything below exists to ensure that reachability requires two independent secrets, neither sufficient alone, and that the exposure window is a deliberate choice rather than a default.

### 9.1 Two independent factors

| Factor | What it is | Why it alone is not enough |
|---|---|---|
| **Network** | Membership of the private Tailscale tailnet (WireGuard device keys) | Even on the tailnet, every request needs the bearer token |
| **Application** | Bearer token, provisioned by QR pairing | Even with the token, the daemon is unreachable without tailnet membership |

**Tailscale** is the recommended transport: laptop and phone join a private WireGuard tailnet; the daemon is reachable on cellular but never published to the public internet. `tailscale cert` issues a real TLS certificate for the `*.ts.net` hostname — required regardless, since PWA install and Web Push both demand a secure context. Tailscale ACLs restrict which devices may reach the daemon's port at all.

**Explicitly rejected:** Cloudflare Tunnel, ngrok, and any port-forward. A public HTTPS endpoint that executes commands on a laptop is a standing invitation to internet-wide scanning, and the convenience gain over Tailscale is nil.

### 9.2 Threat model

| # | Threat | Mitigation |
|---|---|---|
| **T1** | Someone on the public internet reaches the daemon | Daemon binds to the **tailnet interface only — never `0.0.0.0`**, asserted at startup and logged. No port forwarding, no public tunnel. Startup refuses to run if the bind address resolves to a public interface. |
| **T2** | Someone on the same café/hotel wifi reaches it | Same as T1 — the LAN interface is never bound. Physical network proximity grants nothing. |
| **T3** | **DNS rebinding** — a malicious web page in the phone's browser resolves its own hostname to the daemon's tailnet IP and issues requests from the victim's browser | The classic attack on local daemons, and the one most often missed. Daemon **validates the `Host` header against an allowlist** and rejects anything else with 421. Bearer auth is still required on top. |
| **T4** | A malicious site calls the API cross-origin | Strict CORS allowlist (never `*`); the API is not a public read surface so nothing is exempt. Because auth is a **`Authorization` header, not a cookie**, a cross-origin page cannot attach credentials without a preflight the daemon refuses — this design is CSRF-resistant by construction rather than by token bolt-on. |
| **T5** | WebSocket bypasses CORS | `Origin` is validated explicitly on the WS upgrade, and the bearer token is checked there too (§6). CORS does not govern WebSockets; this must be its own check. |
| **T6** | Lost or stolen phone with a paired PWA | Device lock screen is the first barrier. Revocation is immediate: rotate the daemon token and restart — every paired client dies at once (§9.3). Optional hardening: a WebAuthn/biometric gate on app open, deferred unless wanted. |
| **T7** | **XSS in the PWA stealing the token** — transcripts contain arbitrary model output, source code, and web content | Transcript content is rendered as **sanitized markdown, never `innerHTML`/`dangerouslySetInnerHTML`**. A strict CSP with no third-party script origins, no inline script, no `eval`. This is the highest-likelihood application bug in the whole design, because rendering transcripts *is* the product. |
| **T8** | Token leaks via logs, URLs, or screenshots | Token travels in a header, never a query param or body (§16.3). The pairing URL carries it in the **fragment**, which browsers never send to a server. Secrets are redacted from all logs; no transcript content at info level (§16.4). |
| **T9** | `~/.claude` secrets exfiltrated through the API | The daemon reads `peerToken` values from `~/.claude/sessions/*.key` and **never returns them over any route, never logs them**. `SessionSummary` (§5) is an explicit allowlist of fields — no passthrough of raw session JSON. |
| **T10** | Replayed request re-injects a prompt | TLS prevents capture; the `Idempotency-Key` (§6) makes an accidental or replayed retry a no-op for 24h. |
| **T11** | Prompt injection via transcript content — a session that processed hostile input renders text designed to manipulate the reader | MicroViber **never executes, auto-sends, or acts on transcript content**; it only displays it. There is no "suggested reply" affordance and no automation triggered by transcript text. The human remains the only actor. |
| **T12** | Malicious local process on the laptop | Out of scope: such a process can already read the key files and write the sockets directly. MicroViber does not widen local exposure, only network exposure. |

### 9.3 Token lifecycle

- **Provisioning:** the daemon prints a pairing URL (token in the URL **fragment**) plus a QR code at startup; the phone scans it once, on the tailnet. Nothing is committed and nothing reaches a third party.
- **Storage:** persisted in `localStorage` so the installed PWA survives relaunch — re-entering it each launch would defeat the micro-moment use case. Accepted trade-off, and the reason T7's CSP and sanitization are non-negotiable rather than nice-to-have.
- **Rotation / revocation:** the token is a daemon env var. Change it and restart; every paired client is invalidated instantly and re-pairs by scanning the new QR. There is no partial revocation — with one user, a single blunt kill switch is the right primitive.
- Token and VAPID keys come from env, zod-parsed in one `config.ts` at startup (§16.8).

### 9.4 Reduce the window: the daemon is off by default

The strongest control is not cryptographic. **The daemon is not a launch agent and does not run at boot.** It is started deliberately when remote access is wanted and stopped when it is not, so the exposure window is minutes-to-hours of chosen use rather than permanently. A visible indicator (menu-bar item or terminal banner) makes "MicroViber is currently listening" impossible to forget.

### 9.5 Audit trail

Every injected prompt is appended to a local audit log — timestamp, target `sessionId`, client identifier, prompt hash, and outcome (§16.4's `audit_log` discipline). This is what makes the difference between "I think nothing was sent" and knowing. If a prompt ever appears in a session that the user did not send, the log is the evidence.

### 9.6 Residual risk, stated plainly

With all of the above: an attacker who holds **both** tailnet access **and** the bearer token can execute arbitrary commands on the laptop, because that is what a `bypassPermissions` Claude session does. No application-layer control changes that — it follows from the user's chosen permission mode (§8), not from MicroViber. The mitigations are the two factors, the off-by-default posture, and the audit trail. This is the accepted trade for the product existing at all, and R4 records it as High.

---

## 10. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | Every internal surface (`~/.claude/sessions/`, `/tmp/cc-socks/`, `peerProtocol: 1`, transcript vocabulary) is undocumented and can change on any Claude Code update (F9). | **High** | Total quarantine in `lib/claude-adapter/`; version gate degrades to read-only rather than corrupting; contract tests assert the shape of real fixtures; §2 is the re-verification checklist. |
| **R2** | ~~Injected prompts are framed "not typed by your user" and cannot approve a pending question.~~ **RESOLVED by §3.2.** | ~~High~~ → **Resolved** | Takeover-via-resume sends prompts over the owned process's stdin as **genuine user turns** (F11), which can approve anything. The peer-socket framing that caused this is no longer used. The hard requirement "phone prompts appear as regular prompts" is met by construction. |
| **R3** | A prompt sent to a busy session queues silently (F8), and a session that ends its turn without another tool round may hold it indefinitely. | Low | Per-prompt `PromptStatus` (§5); `accepted` only once the tailer *observes* the prompt in the transcript, never on stdin-write success; `expired` after 10 minutes unobserved, surfaced in the UI with a resend affordance. |
| **R4** | Reaching the daemon means arbitrary code execution on the laptop (§9). | **High** | Tailnet-only binding, bearer auth on every route, no public exposure, secrets via env. Accepted risk, explicitly. |
| **R5** | ~~Injected prompt may not render as a user bubble in the VS Code webview.~~ **Moot under §3.2.** | ~~Medium~~ → **Resolved** | After takeover the laptop's original tab is stale by design; the user returns to the laptop via `/resume`, which reloads the full history (including phone turns) into a fresh view. MicroViber never depends on the old webview rendering the turn. |
| **R6** | Phone (owned resume) and laptop write to the same session concurrently — a genuine second writer now exists, unlike the old peer model. | **Medium** | Structurally bounded: takeover is **gated on `idle`** (§3.2), so the phone never starts under a working laptop, and the "one driver at a time" baton discipline (§1) keeps writers serial. If the user ignores it and types in the stale laptop tab, both append from divergent points — accepted per the user's **conflict rule: do nothing** (no warn, no block). The shared history file still serializes at the append level; only conversational coherence is at risk, and only under deliberate misuse. |

---

## 11. Architecture & Spec Alignment

**MicroViber is a separate repo from the Syncounter platform.** It shares none of its infrastructure — no Firebase project, no Firestore, no Storage bucket, no Auth realm, no `studio`/`audio-producer`/`scenario-creator` code. It is a local developer tool that happens to live in the same workspace.

**Part B gap register (`architecture-spec-v2.md` §11–14): none matched.** The clean-as-you-touch rule is scoped to the three Syncounter services; MicroViber touches no file in any of them. The only Harness-repo changes are this spec, the `microviber/` gitignore entry, and the new project directory. No gap is made worse.

**`architecture-spec-v2.md` §16 standards adopted** (normative for all new code):

| Standard | Application |
|---|---|
| §16.1 Layering | `schemas/ → domain/ → services/ → api/`, no upward imports; the adapter is the only module aware of Claude Code internals |
| §16.1 No dead modules | Nothing kept "for later" |
| §16.2 zod at every boundary | Every route, WS frame, and adapter-parsed transcript entry; `.max()` bounds on all prompt strings |
| §16.2 One error envelope | Canonical `{success:false,error:{code,message,details?}}`; the two deliberate code deltas are declared in §6 |
| §16.2 `X-Request-Id` | Generated at the edge, present in every log line and error response |
| §16.2 Responses validated too | Adapter output validated before it enters the domain |
| §16.3 No secrets in bodies | Bearer token in `Authorization` only |
| §16.4 Structured logs (pino) | `action` / `requestId` / `outcome` / `durationMs`; **no transcript content at info level** |
| §16.5 Fail closed | Unknown protocol version ⇒ read-only, never a speculative write |
| §16.5 Explicit timeouts | `AbortSignal.timeout` on socket writes; no unbounded await |
| §16.7 TS strict | No `any` without a `// reason:` comment; CI gates typecheck + lint + tests |
| §16.8 One `config.ts` | All env zod-parsed at startup; missing required var crashes immediately |

**Deviations from §16, with justification:**

- **§16.6 Firestore conventions do not apply** — MicroViber has no database. Its state is derived from the filesystem and held in memory; there is nothing to version, migrate, or transact.
- **§16.9 Cross-service headers do not fully apply** — the daemon's only "upstream" is a local Unix socket speaking a fixed third-party protocol. `X-Request-Id` is honoured internally; OIDC and `X-Firebase-Id-Token` are meaningless here.
- **§16.2 OpenAPI** deferred to the same "once shared tooling lands" clause the Syncounter services rely on; route header comments document auth, contract, and error codes in the interim.

---

## 12. UI/UX Guidelines Alignment

Rules from `UI_UX_GUIDELINES.md` that shaped this design:

- **§1.1 / §1.4 Semantic tokens, dark by default.** HSL custom properties, no hardcoded hex in components. Dark is the only theme MicroViber ships (see deviations).
- **§2.1 Component sourcing order.** shadcn/Radix primitive first, then a domain component, build new only as a last resort. `Sheet` for the session picker, `Textarea` for the composer, `Badge` for session state, `Skeleton` for transcript load.
- **§2.3 CVA for variants** rather than conditional class strings at call sites.
- **§2.5 Feedback & status.** Never a bare error string: `Alert` for persistent states (version gate, disconnected), toast for transient send failures. Empty states get icon + one-line copy + primary CTA, per §8's empty-list pattern (the guidelines describe the shape; the component itself lives in studio and is not shared across repos, so MicroViber builds its own).
- **§2.6 Accessibility.** `aria-label` on every icon button; Radix keyboard/ARIA behaviour left intact; focus rings preserved.
- **§2.7 Mobile-first.** Base styles target the phone. This is the guideline MicroViber leans on hardest — and the reason the desktop tab strip from the reference screenshot became a picker sheet.
- **§4.3 `cn()` composition** for all class merging.
- **§4.6 Bounded lists.** Transcript backfill is cursor-paginated, never a full-file read into the client.
- **§4.7 Hygiene.** One component per file, `<Component>Props` interfaces, comments only for non-obvious *why*.
- **§8 Loading / empty / error** state table adopted as-is.
- **§17a PWA patterns** (functional spec) reused: `NetworkOnly` for authenticated APIs, iOS-Safari install hint, `beforeinstallprompt` capture outside the React mount race.

**Deliberate deviations:**

1. **No `next-intl`, no i18n, no Hebrew/RTL.** §4.4 makes i18n mandatory and §3 treats Hebrew as first-class — both exist because Syncounter ships to Hebrew-speaking end users. MicroViber is a single-user English developer tool with no end users. String literals in JSX are acceptable here; adding a translation layer would be pure overhead. *If* MicroViber ever gains users, this decision reverses.
2. **No shared Syncounter brand tokens or components.** Separate repo, no cross-repo imports (§16.1 forbids the coupling). MicroViber defines its own minimal token set following the same *conventions*; it is not Syncounter-branded and should not look like it.
3. **Vite, not Next.js.** The guidelines assume studio's Next.js App Router (§4.1–4.2, server components, server actions). None applies: MicroViber is a WS-driven SPA with a separate Node daemon, so the server/client component discipline has no counterpart. Component-level conventions still hold.
4. **No `Progress` / `Chart` / `Calendar` / `Table`** and most of the primitive catalogue — MicroViber installs only the handful of shadcn components it uses, per §2.1's "never reach for a dependency you don't need".
5. **Dark theme only.** §1.4 requires every component to look correct in *both* themes. MicroViber ships dark only: it is used in bed, on a couch, in the dark, by one person who has never wanted a light theme. Tokens are still defined semantically, so adding light later is a token file, not a refactor.

---

## 13. Open Questions & Implementation Checkpoints

Ordered; each must be settled before the code that depends on it.

Phase 0 ([findings.md](findings.md)) plus the 2026-08-24 resume tests (F13–F15) resolved the framing questions; two daemon spikes and the new ownership-lifecycle spike remain. Current status:

1. **[RESOLVED — moot] Native user-turn frame.** Originally a gate on whether an un-wrapped write path exists for an *already-running* session. Settled differently than framed: I6 proved no external write path exists at all, so MicroViber does not write into existing processes — it **resumes** them (§3.2) and writes over the owned process's stdin, which is a plain user turn (F11). No native peer frame is needed. `injected` derives from daemon-side correlation.
2. **[RESOLVED — moot] Prompt rendering.** With takeover-via-resume the phone turn is an ordinary `user` entry in the shared history file (F11), and the laptop sees it by `/resume` (§3.2), not via a live webview. There is no `@peer` rendering and no echo mitigation to build.
3. **[OPEN — daemon spike] Idle one-shot semantics.** Whether a `notify_idle` subscription is consumed on delivery. Contained: the host-agnostic 20s heuristic is the primary idle signal, so notifications work regardless; only Task 19's re-subscribe bookkeeping depends on this. Confirm with a live subscriber. *(Re-checked as part of microviber-4, 2026-08-26 — still requires a live daemon spike; remains open.)*
4. **[RESOLVED] Version gate.** Gate on **`peerProtocol`** (observed `1` across versions `2.1.216`–`2.1.237`), with `version` recorded for diagnostics only. Host discriminator: the session JSON's `entrypoint` field (`claude-vscode` vs `cli`).
5. **[RESOLVED] Transport.** Tailscale not installed; daemon made **transport-agnostic** (binds one configurable address, never `0.0.0.0`; tunnel is external, Tailscale recommended). User installs Tailscale as a setup step.
6. **[OPEN — daemon spike] `peerToken` lifetime.** Only relevant to read-side discovery now (the peer socket is not written). Default to re-reading the `.key` on reconnect (cheap, safe) until confirmed. *(Re-checked as part of microviber-4, 2026-08-26 — still requires a live daemon spike; remains open.)*
7. **[RESOLVED, 2026-08-26 — microviber-2/3] Takeover ownership lifecycle (§3.2).** Ownership is tracked **in-memory only** (`daemon/src/domain/ownership.ts`'s `OwnershipRegistry`, a plain `Map<sessionId, OwnedSessionHandle>`): a daemon restart is not specially parented through — it simply drops every entry, which reverts every previously-owned session to read-only, and the phone can take it over again via the normal `/takeover` route. Discovery still finds the underlying `claude --resume` process the same way it finds any session (§2, F1). Teardown on hand-back is explicit: `POST /api/sessions/:id/handback` calls `release()`, which kills the owned child (SIGTERM to its process group) and removes the map entry. Teardown on phone abandonment (no explicit hand-back) is *not* automatic — this is the accepted trade-off already stated in §3.2's conflict rule ("do nothing"), not a gap in this checkpoint.

Phase-2 port detection is *not* listed here — it gates no MVP code and is recorded inline in §3.

---

## 14. Repo Layout

```
microviber/                        ← independent git repo, gitignored by Harness
  daemon/
    src/
      lib/claude-adapter/          ← discovery, encode-path, tail, resume-owner (takeover, §3.2), version-gate
      domain/                      ← session registry, state machine, notify policy, ownership lifecycle
      services/                    ← web-push, dev-proxy (phase 2)
      api/                         ← routes + ws hub
      schemas/                     ← zod
      config.ts                    ← all env, zod-parsed at startup
    test/                          ← adapter contract tests over real fixtures
  pwa/
    src/
      components/ui/               ← shadcn primitives (only what is used)
      components/                  ← SessionPicker, Transcript, Composer, PaneSwitch
      hooks/
      lib/
  README.md
```

**Published, 2026-08-26.** The repo now lives at `github.com/yarivsnapir/MicroViber` (public), under its own GitHub identity (`yarivsnapir`) rather than the `yariv-syncounter`/`SynKounter` org used for the Syncounter apps — MicroViber remains a personal tool, not a Syncounter product, but is distributed as an independent open-source project. Stories are tracked as GitHub issues there (`github_issue:` in each story's frontmatter); the production-readiness program that published it is recorded in `docs/features/microviber/production-readiness.md`.

---

## 15. Distribution & Install (Tailscale)

MicroViber is a **personal, single-user tool**, not a hosted product: one laptop (daemon + live Claude Code sessions) and one phone (installed PWA). Making it "installable" means making it installable *for one owner on their own two devices*, which is a deliberately narrower goal than public distribution — and the security model (§9) depends on that narrowness.

### 15.1 Two hard requirements that fix the transport

1. **Stable HTTPS origin.** A PWA's identity, service worker, cache, and stored token are keyed to its origin. A LAN IP changes between networks (breaking the installed app), and plain HTTP over a LAN IP is **not a secure context**, so the browser refuses to register a service worker at all — no install, no push. The install therefore requires a *stable hostname on real HTTPS*.
2. **Never publicly reachable.** The daemon can inject prompts into a `bypassPermissions` session (§9.6) — arbitrary code execution as the user. A public endpoint is unacceptable regardless of auth.

**Tailscale is the only transport that satisfies both**, and §9.1 already names it the recommended transport. It provides a permanent MagicDNS name that follows the laptop across any network, a real Let's Encrypt certificate via `tailscale cert`/`serve`, and tailnet-only reachability. ngrok / Cloudflare Tunnel / port-forwarding remain **explicitly rejected** (§9.1).

### 15.2 The documented deployment shape

Daemon binds **loopback**; `tailscale serve` terminates HTTPS on the `*.ts.net` name and reverse-proxies to it. The daemon speaks plain HTTP by design and never handles certificates — TLS is Tailscale's job. Config is three env values (`MV_BIND_ADDRESS=127.0.0.1`, `MV_ALLOWED_HOSTS=<ts.net name>`, `MV_ALLOWED_ORIGINS=https://<ts.net name>`) plus VAPID keys for push. The built `config.ts` bind-guard already whitelists loopback and the `100.64/10` Tailscale range, so **no code change is required to run behind Tailscale** — the only code delta is the pairing-URL polish in §15.4.

A same-WiFi fallback (bind the `100.x` tailnet IP, open over `http://`) works in a browser but **cannot install or push** (no secure context); it is a quick-look mode only, never the install path.

### 15.3 The install runbook is written for Claude to consume

The owner installs by asking Claude to do it. The authoritative, executable runbook lives at **`microviber/INSTALL.md`** — a step-by-step Claude runbook (preconditions → build → Tailscale → `.env` → start → `tailscale serve` → pair/install → stop/rotate), each step carrying a `verify` command. The spec states the *why* (this section); `INSTALL.md` states the *how* and is the file handed to an installing session. `README.md` (Task 26) links to it.

### 15.4 Required code delta: HTTPS pairing URL

Today `index.ts` prints the pairing URL with the local `http` scheme and the bind address/port. Behind `tailscale serve` the phone must scan the **`https://<ts.net name>` origin** (the bearer token rides in the fragment either way). The daemon must print/QR the public HTTPS pairing URL derived from `MV_ALLOWED_HOSTS[0]` (or an explicit public-URL config) when serving behind a proxy, keeping the local `http` form as fallback. `buildPairingUrl` already accepts an `https` scheme; it must additionally omit the port when it is the scheme default (443/80). Small, contained, tracked as plan Task 27.
