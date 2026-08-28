# MicroViber — Implementation Plan (v3, takeover-via-resume)

> Spec: [spec.md](spec.md) · Findings: [findings.md](findings.md) · Standards: [../../architecture-spec-v2.md](../../architecture-spec-v2.md) §16 (normative)
> Branch: `feature/microviber` · Repo: `microviber/` (local, on `main`)
> Scope: **MVP only** (spec §3). Model: **read-only mirror + takeover-via-resume** (spec §3.2), decided 2026-08-24 — supersedes the v2 "hybrid (attach + owned)" write model.

**Why v3.** v2's write model had two send paths: *attach* (peer socket) and *owned* (fresh SDK session). Phase-0 Investigation 6 then proved **attach-send is infeasible** — the peer socket rejects a standalone daemon (findings I6). Investigation 7 proved the replacement: `claude --resume <id>` continues the **same** history file (F13), works against a **live idle** session (F14), and carries full history (F15). So the single write path is now **takeover**: a deliberate, idle-gated action that resumes a session into a MicroViber-owned process and drives it over the same stream-json stdin transport owned mode already uses.

**Build status.** Tasks 1–5, 7–22, 25 were built to the v2 model and committed (`microviber/`, on `main`). This v3 revises the write-path tasks and the UX tasks that referenced the mode toggle; the **read path, domain state, security, notifications, and PWA shell are unchanged**. The concrete code delta is enumerated in [§ Delta from built code](#delta-from-built-code) at the end — that is the actual development work remaining.

Phase 0 is **done** (findings I1–I7). Two small daemon-spike unknowns remain (idle one-shot semantics; takeover ownership-lifecycle, spec checkpoint 13.7); each has a safe default and is folded into the task that needs it.

---

## Stability principles (this plan's spine)

The user's overriding ask is **"as stable as possible."** Every task is shaped by five rules:

1. **Prefer documented interfaces to reverse-engineered ones.** The one write path — takeover — uses the **SDK stream-json protocol** (`claude --resume <id> --input-format stream-json --output-format stream-json`), Claude Code's supported headless transport (findings F11), resuming into the same history file (F13). No undocumented write surface is used at all — the peer socket is read for discovery metadata only, never written (findings I6).
2. **Quarantine every undocumented surface** behind `lib/claude-adapter/`, gated on `peerProtocol` (findings I4). An unrecognised protocol **degrades to read-only mirror** and disables takeover, never a guessed write (§16.5 fail-closed). The rest of the codebase never sees a Claude Code internal.
3. **Never assert success you did not observe.** A prompt is `accepted` only when the tailer sees it in the transcript as a plain `user` turn (findings F11), never on stdin-write return. Verification over assertion is a §16.7 discipline and the spec-review caught a false-failure bug here already.
4. **Fail closed on the network.** The daemon executes arbitrary code on the laptop; every security control (§9 / T1–T12) is a first-class task with a test, not later hardening.
5. **One writer at a time, gated on idle.** Read (discovery, tail, state, notifications) is always on and shared. Write exists only after a deliberate **Take over**, which is **enabled only when the session is `idle`** (spec §3.2 hard rule) — this is what keeps the phone from ever writing under a working laptop. The conflict case (user then types in the stale laptop tab) is left unpoliced per the user's rule "do nothing".

### Gap register — explicit exclusion

Spec §11 records the Part B gap register as **`none matched`**: MicroViber is a new standalone repo touching no file in `studio/`, `audio-producer/`, or `scenario-creator/`. **No gap-closure tasks appear, deliberately** — this note is the record.

### Out of scope (spec §3)

Browser panel; permission-approval UI; resuming *dead* sessions; a companion VS Code extension. The only Phase-2 artifact built is the disabled pane switch (spec §3: Web position visibly disabled, "coming soon", no route, no proxy, no web-view).

---

## Architecture at a glance

```
                    microviber-daemon (Node 22 + TS + Fastify)
  ┌──────────────────────────────────────────────────────────────┐
  │ lib/claude-adapter/  ── ONLY module touching Claude internals │
  │   discovery · tail · version-gate · encode-path               │
  │   ┌── single write path ─────────────────────────────────┐    │
  │   │  takeover → session-manager: spawn                    │    │
  │   │    `claude --resume <id>` (idle-gated), own stdin,    │    │
  │   │    stream-json plain user turns (F11) → same .jsonl   │    │
  │   │  (peer socket: READ for discovery only, never written)│    │
  │   └──────────────────────────────────────────────────────┘    │
  │ domain/   registry · session-state · prompt-lifecycle ·        │
  │           ownership-lifecycle · notify                         │
  │ services/ web-push · audit-log                                 │
  │ api/      routes (+ /takeover, /handback) · ws-hub · security  │
  │ config.ts (zod, one place)                                     │
  └──────────────────────────────────────────────────────────────┘
        ▲ WSS + HTTPS (bearer, tailnet-bound)     ▲ Web Push
        │                                          │
                    microviber-pwa (Vite + React + Tailwind + shadcn)
```

Read path (discovery/tail/state) is always on and shared. There is **one** write implementation behind the `PromptSender` interface: `session-manager`, reached only after an idle-gated **takeover** puts the session into the owned map.

Each task states: **Goal · Tests first (TDD, §16.7) · §16 · Done when.**

---

## Phase 1 — Scaffold

### Task 1 — Repo scaffold, gated from commit one
**Goal.** Two workspaces (`daemon/`, `pwa/`), TS strict, CI gating typecheck + lint + tests, ESLint import-fence so `pwa` can't import daemon internals and nothing outside `lib/claude-adapter/` can reference `~/.claude` or `/tmp/cc-socks`.
**Files.** `microviber/{package.json,tsconfig.base.json,eslint.config.js,.gitignore,.github/workflows/ci.yml,README.md}`, `daemon/*`, `pwa/*`.
**§16.** §16.7 strict + gated CI (no `ignoreBuildErrors` debt to inherit). §16.1 fence enforces layering from day one.
**Done when.** typecheck/lint/test all green on the empty project; CI runs all three.

---

## Phase 2 — `lib/claude-adapter/` — the read path + quarantine (highest risk, spec R1)

### Task 2 — Schemas, path encoding, host + version classification
**Tests first.**
- `encodePath` maps **`/`, `.` and `_` → `-`** (findings: the `_` case is mandatory; this machine's username has one).
- Session-JSON schema parses real fixtures; rejects missing `messagingSocketPath` / malformed `peerProtocol`.
- Host = `entrypoint` field (`claude-vscode`→vscode, `cli`→terminal), corroborated by `peerFeatures` (findings I4 — cleaner than the process-path check).
- Version gate keys on **`peerProtocol`** (supported: `1`); `version` recorded, not gated.
**Files.** `daemon/src/lib/claude-adapter/{encode-path.ts,schemas.ts,classify.ts}`, `daemon/test/fixtures/*`.
**§16.** §16.2 zod at boundary, `.max()` bounds. §16.5 parse failure throws typed, never coerces.
**Done when.** Fixture tests pass incl. underscore + unsupported-protocol cases.

### Task 3 — Discovery
**Tests first.** Returns only live-pid sessions; classifies host; resolves title (`ai-title` → truncated `last-prompt` → `"(untitled)"`); derives `lastPromptAt` (newest `user` turn) and `lastActivityAt`; **never** emits `peerToken`. `SessionSummary` is an explicit field allowlist (T9).
**Files.** `daemon/src/lib/claude-adapter/discovery.ts`.
**§16.** T9 — token stays in the adapter, never logged/returned. §16.4 no token in logs.
**Done when.** Tests pass; a live run lists this machine's real sessions with correct titles, host, and sort.

### Task 4 — Version gate → read-only degrade
**Tests first.** Supported `peerProtocol` → `{writable:true}`. Unsupported → `{writable:false, reason}` and no write path offered. The gate **never sets session `state`** (spec §5.1) — an unrecognised build still mirrors.
**Files.** `daemon/src/lib/claude-adapter/version-gate.ts`.
**§16.** §16.5 fail-closed: degrade, don't guess.
**Done when.** Tests pass.

### Task 5 — Transcript tailer + normalization (shared read path)
**Tests first.**
- Incremental parse from a byte offset emits only new events; a partial trailing line doesn't throw and is re-read when complete.
- Maps internal entries → spec §5 `TranscriptEvent` union.
- **Unwrap:** a `user` entry containing the `<cross-session-message>` wrapper emits `text` = the original prompt only, `injected:true` (spec §5; findings F10/F12).
- `injected` for owned-mode prompts comes from **daemon-side correlation** (match sent text+timestamp), since those are plain turns with no wrapper (findings F11).
**Files.** `daemon/src/lib/claude-adapter/tail.ts`.
**§16.** §16.2 validate each entry; §16.4 no transcript content at info level.
**Done when.** Tests pass; tailing a live session streams events in real time.

---

## Phase 3 — The single write path: takeover-via-resume

### Task 7 — Session-manager spawn engine (documented SDK transport — the stable path) — **BUILT**
**Tests first.** Spawns claude with daemon-owned stdio over stream-json; writes a `{"type":"user"}` frame → a plain user turn (findings F11); parses stream-json output for the `session_id`; surfaces process exit/crash as a typed error; the sent prompt is **not** wrapped.
**Files.** `daemon/src/lib/claude-adapter/session-manager.ts` (built — `startOwnedSession`, `OwnedSessionHandle`, `PromptSender`, `userFrame`).
**§16.** §16.5 timeouts + typed errors; §16.8 spawn flags from config.
**Done when.** ✅ Built and tested. This is the reusable engine for both takeover (Task 6, `--resume <id>`) and Phase-2 fresh-session creation (`-n <name>`).

### Task 6 — Takeover: resume a live idle session into an owned handle (**the write path — TO BUILD**)
**Goal.** Convert a read-only mirrored session into a writable owned one by resuming it, gated on `idle`. This replaces the abandoned attach-mode peer client (findings I6).
**Tests first (TDD).**
- `startTakeoverSession({ sessionId, cwd, spawner, claudeBin })` spawns `claude --resume <sessionId> --input-format stream-json --output-format stream-json --dangerously-skip-permissions` and returns a handle whose `sessionId` is the **resumed** id (verify the resumed process reports the same id, findings F13/F14 — not a new one).
- The returned handle satisfies `PromptSender`; a `send()` writes a plain user turn to its stdin; process exit/crash → typed `EXTERNAL_SERVICE_ERROR`, `retryable`.
- **Idle gate:** takeover of a non-`idle` session is refused before any spawn (unit-tested at the orchestration boundary; the route enforces `FORBIDDEN`, Task 12).
- **Ownership lifecycle (spec checkpoint 13.7):** handle is tracked in the owned map keyed by the resumed `sessionId`; `handback()` kills the child and removes it; a child that exits on its own is reaped from the map so state reverts to read-only. Parenting so it survives a daemon restart is the spike's open question — ship the safe default (child dies with daemon; on restart the session reverts to read-only and can be taken over again) and record it.
**Files.** `daemon/src/lib/claude-adapter/session-manager.ts` (add `startTakeoverSession`, sharing the spawn/stdin/init-parse core with `startOwnedSession`), `daemon/src/domain/ownership.ts` (owned-map lifecycle: acquire/release/reap).
**§16.** §16.5 explicit timeouts + typed retryable errors; §16.8 resume flags from config; §16.1 lifecycle logic in `domain/`, spawn in the adapter. Deviation note: owns a child process — lifecycle documented inline, spike-tracked (13.7).
**Done when.** Tests pass; a manual takeover of a real live idle session accepts a plain-turn prompt that lands in the **same** transcript file (F13), and handback tears the child down cleanly.

---

## Phase 4 — Domain

### Task 8 — Session registry + state derivation
**Tests first.** Spec §5.1 first-match-wins: `pid` gone→`stale`; `notify_idle` after last growth→`idle`; growth <20s→`working`; else→`idle`. **Required:** an open assistant turn with no growth for 20s → `idle` not `working` (the review-caught defect: otherwise idle push never fires for a session parked awaiting input). Unopened session with no subscription → `idle` via heuristic. Version-gate reject → `writable:false`, `state` untouched. Sort by `lastPromptAt` desc. Each session carries `takenOver: boolean` (in the owned map) — a taken-over session renders `owned`, all others `readonly`. **Delta from built code:** the built registry uses `mode: 'attach' | 'owned'`; rename the read-only value from `attach` → `readonly` (there is no attach *send* anymore) and derive it from the owned-map membership.
**Files.** `daemon/src/domain/{registry.ts,session-state.ts}`.
**§16.** §16.1 domain has no I/O; §16.7 state transitions test-required.
**Done when.** All cases pass incl. the open-turn case.

### Task 9 — Prompt lifecycle
**Tests first.** Spec §5 transitions: `sending`→(write ok)→`queued`→(observed in transcript)→`accepted`; write fail→`failed`; 10-min unobserved→`expired`. **`accepted` never on stdin-write-success alone** — only on transcript observation (spec F11). Idempotency: same key replayed → original status; same key + different body → `INVALID_INPUT`. `injected` is always set by daemon-side correlation (plain user turns, F11 — no wrapper unwrap; the old attach/wrapper branch is removed).
**Files.** `daemon/src/domain/prompt-lifecycle.ts`.
**§16.** §16.2 `Idempotency-Key` 24h de-dupe. §16.6 N/A (no DB) — declared deviation (spec §11).
**Done when.** All transitions incl. expiry pass.

---

## Phase 5 — API + security (first-class; the daemon runs code on the laptop)

### Task 10 — `config.ts` + safe bind
**Tests first.** Missing required env → crash at startup, not first request. Bind address resolving to a public interface / `0.0.0.0` → refuse to start. Tailnet/LAN address → ok. Transport-agnostic (findings I5): the tunnel is external; the daemon only binds.
**Files.** `daemon/src/config.ts`, `daemon/src/server/bind.ts`.
**§16.** §16.8 one zod-parsed config; addresses are config not constants. T1/T2.
**Done when.** Public bind refused; tests pass.

### Task 11 — Security middleware (one test per threat)
**Tests first.** T3 DNS-rebinding: unexpected `Host` → `421` before auth. T4 CORS allowlist, never `*`. Bearer auth on every route, checked in-route (§16.3), fail-closed. T8 token only from `Authorization` header; token in query/body rejected. `X-Request-Id` minted at edge, in every log + error.
**Files.** `daemon/src/api/middleware/{host-allowlist,cors,auth,request-id}.ts`.
**§16.** §16.2 request-id; §16.3 headers-not-bodies, server-side fail-closed.
**Done when.** Every threat test passes.

### Task 12 — HTTP routes
**Tests first.** Each spec §6 route, zod in+out, canonical envelope with the two declared deltas (`ADAPTER_UNSUPPORTED` added, `RATE_LIMITED` dropped; `EXTERNAL_SERVICE_ERROR` kept). `GET /api/sessions` → `lastPromptAt`-sorted, each with `takenOver`/`writable`. Transcript route cursor-paginated + bounded (never whole-file). **`POST /api/sessions/:id/takeover`** — `FORBIDDEN` unless `state === 'idle'`; on success calls Task 6, puts the session in the owned map, returns the now-writable summary; idempotent if already owned. **`POST /api/sessions/:id/handback`** — releases ownership (kills child), returns to read-only. `POST …/prompt` requires `Idempotency-Key`, returns `PromptStatus`, and returns **`FORBIDDEN` if the session has not been taken over** (no owned handle). **Delta from built code:** the built routes have a `POST /api/sessions/owned` (fresh-start) and an attach-not-implemented send path — replace with `/takeover` + `/handback`; keep fresh-start only if trivially retained behind a Phase-2 flag, else drop.
**Files.** `daemon/src/api/routes/*.ts`, `daemon/src/schemas/api.ts`.
**§16.** §16.2 no logic in handlers: parse→auth→delegate→serialize; header comment documents auth/contract/errors.
**Done when.** Route tests pass against the domain.

### Task 13 — WebSocket hub
**Tests first.** T5: upgrade validates `Origin` explicitly **and** requires the bearer token (CORS doesn't cover WS). Subscribe→stream events; unsubscribe→stop; dropped socket leaks no tailer.
**Files.** `daemon/src/api/ws/hub.ts`.
**Done when.** Two clients on one session both receive events; tests pass.

### Task 14 — Audit log
**Tests first.** Every send appends {timestamp, sessionId, mode, client id, **prompt hash** (not text), outcome, requestId}; append-only; failures recorded too.
**Files.** `daemon/src/services/audit-log.ts`.
**§16.** §16.4 audit trail, no PII/prompt content. Spec §9.5.
**Done when.** Survives restart; tests pass.

---

## Phase 6 — Notifications (spec §8)

### Task 15 — Web Push delivery
**Tests first.** Session→`idle` sends one push with the harness status line (findings I3: notices carry it) + deep link. Trigger = host-agnostic idle heuristic (§5.1), so **every** session notifies, not just `notify_idle` ones. Subscription bookkeeping uses the safe re-subscribe default until the one-shot question is confirmed in the daemon spike. No polling.
**Files.** `daemon/src/services/web-push.ts`, `daemon/src/domain/notify-policy.ts`.
**Done when.** A real push arrives on the phone from a real session going idle.

### Task 16 — Notification cancellation (spec §8, user A6)
**Tests first.** Tagged `session:<id>` so a later notice replaces rather than stacks. Session leaves `idle` → daemon pushes `dismiss` → SW closes via `getNotifications({tag})`. Open-in-app clears its notices. TTL self-expiry (iOS Web Push may drop non-displaying pushes — TTL + clear-on-open are load-bearing, test the missing-dismiss path).
**Files.** `pwa/src/sw-notifications.ts`, `daemon/src/domain/notify-policy.ts`.
**Done when.** The user's stale-notification case is demonstrably fixed: go idle → notified → continue at laptop → phone notice disappears.

---

## Phase 7 — PWA

### Task 17 — Shell, service worker, CSP
**Tests first.** SW: `NetworkFirst` navigations, `CacheFirst` hashed assets, **`NetworkOnly` for `/api/*` + WS** (no transcript/token in cache). T7: strict CSP, no third-party script origins, no inline/eval.
**Files.** `pwa/{vite.config.ts,index.html}`, `pwa/src/sw.ts`, manifest+icons.
**§16/guidelines.** Dark-only, semantic HSL tokens (deviations recorded spec §12).
**Done when.** Installs on the phone over the Task 10 TLS host; offline fallback works.

### Task 18 — Pairing
**Tests first.** Daemon prints a pairing URL with token in the **fragment** (never sent to server) + QR. PWA reads from fragment, stores in `localStorage`, clears the URL. Token rotation invalidates the client → re-pair prompt.
**Files.** `daemon/src/server/pairing.ts`, `pwa/src/lib/auth.ts`.
**§16.** §16.3 secrets via env; T6/T8.
**Done when.** Phone pairs by scan; rotation forces re-pair.

### Task 19 — Session picker
**Goal.** A sheet (not a tab strip). Rows: `ai-title`, then `folder · relative-time · state` (working/idle/stale), `lastPromptAt`-sorted; taken-over sessions marked as writable. **Delta from built code:** remove the "＋ start phone session" (owned/fresh-start) action — session creation is Phase 2; the MVP entry to writing is Take over (Task 21), not creation.
**Files.** `pwa/src/components/SessionPicker.tsx`, `pwa/src/components/ui/sheet.tsx`.
**Guidelines.** §2.1 shadcn first; §2.6 aria-labels; §4.3 `cn()`.
**Done when.** Lists real sessions in order with correct state; switching swaps the transcript.

### Task 20 — Transcript renderer (matches the VS Code extension) — **security-critical**
**Goal.** Extension conventions (spec §7): flowing single column with left-gutter markers, not bubbles; user prompts as bordered blocks; full markdown (bold, lists, inline `code`, links); tool calls one-line, expandable; tool output in the labelled block; thinking as a marker. Phone-injected prompts stay visually distinct.
**Tests first — T7 is the critical one.** Content renders via **sanitized markdown, never `dangerouslySetInnerHTML`**. Adversarial fixture (`<script>`, `onerror`, `javascript:`) proves nothing executes. **Highest-likelihood bug in the project — rendering transcripts IS the product**, and transcripts hold arbitrary model output, code, and scraped web text.
**Files.** `pwa/src/components/Transcript.tsx`, `pwa/src/components/transcript/*.tsx`, `pwa/src/lib/markdown.ts`.
**Done when.** Adversarial fixture inert; a real streaming session reads correctly on a phone.

### Task 21 — Composer with the Take-over state (spec §7) — **the key UX delta**
**Goal.** The composer real estate is a single control with three pre-write states driven by session `state` (spec §5.1/§7), then the live composer once taken over:
- **working** → disabled bar, "laptop is working…" (takeover forbidden — spec §3.2 hard rule).
- **idle** → enabled **"Take over"** button → `POST …/takeover`; on success becomes the live composer.
- **stale** → disabled, "this session has ended".
- **taken over** → textarea resting ~7 lines → ~10 then internal scroll (prompts are paragraphs); all four `PromptStatus` states: `accepted` in-thread; `queued` greyed "waiting…"; `expired` ("never picked up") and `failed` ("couldn't reach the session") retain text + Resend. A **"hand back"** affordance (→ `POST …/handback`) appears only while taken over.
**Delta from built code:** the built composer is always-on with an attach/owned mode hint and a broken send (hits the not-implemented attach path — this is the "couldn't reach the session" the user saw). Replace the mode hint with the state-driven Take-over gate; send only ever hits the owned (taken-over) path.
**Files.** `pwa/src/components/Composer.tsx`.
**Guidelines.** §2.4 validated form; §2.5 inline status + toast; minimalism — no separate mode toggle (spec §7).
**Done when.** The gate matches session state (working disables, idle enables); taking over a real idle session then sending lands a real prompt in it; all four post-send states render; hand back returns to read-only.

### Task 22 — Pane switch + app states
**Goal.** Bottom 2-way switch, **Web disabled + "coming soon"** (markup only, no route/proxy/view — spec §3 reconciled with §16.1). App states: empty (teaches sessions start on the laptop), read-only (version gate), disconnected (last-synced time). Retention: a session dying under view → `stale`, transcript readable, composer disabled.
**Files.** `pwa/src/components/{PaneSwitch,EmptyState,ReadOnlyBanner,DisconnectedBanner}.tsx`.
**Done when.** Each state reachable in a manual walkthrough.

---

## Phase 8 — Integration + hardening

### Task 23 — End-to-end on a physical phone (record real output, §16.7)
1. Start a session in VS Code, run a command, walk away → it appears in the phone list, correctly sorted, showing **working**.
2. Watch the turn stream live (read-only mirror, no takeover).
3. It goes **idle** → push with the harness status line; the composer's **Take over** button lights up. Take-over is **refused** while still working (verify the gate).
4. Tap **Take over** → session becomes writable; send a prompt (incl. one that answers a question — proving the genuine user-turn path, F11); it lands in the **same** transcript file (F13).
5. Send again while it's busy → `queued`, then `accepted` when it drains.
6. Continue at the laptop: `/resume` the session → it reloads with the phone's turns (F13/F14); the frozen tab is abandoned. Notification **disappears** (Task 16).
7. Kill the daemon mid-stream → disconnected state; on restart the taken-over session reverts to read-only (safe default, 13.7) and can be taken over again.
8. **Hand back** from the phone → session returns to read-only.
9. Repeat 1–7 against a **terminal** session (host-agnostic — resume works there too, F14).
**Done when.** All pass on a real phone, output recorded.

### Task 24 — Daemon spike: close the two open questions
**Goal.** With the daemon live, confirm (a) whether `notify_idle` subscriptions are one-shot (Task 15 bookkeeping) and (b) the **takeover ownership-lifecycle** (spec checkpoint 13.7): does a daemon-spawned `claude --resume` child need explicit re-parenting to survive a daemon restart, or is reverting to read-only on restart acceptable? Both have safe defaults already specified; this replaces default with fact.
**Done when.** findings.md updated with observed behaviour; code adjusted only if the default was wrong.

### Task 25 — Off-by-default runner
**Goal.** Daemon is **not** a launch agent (spec §9.4). Start/stop script + a visible "MicroViber is listening" indicator so it's never left running unnoticed.
**Done when.** Starts only when asked; running state visible at a glance.

### Task 26 — README + spec reconciliation
**Goal.** `microviber/README.md`: what it is, setup (link to `INSTALL.md` for the full Tailscale runbook), pairing, the read-only-mirror + takeover model and its idle-gate rule, and the security posture + residual risk (spec §9.6). Fold any daemon-spike findings back into spec.md; no §13 item left open without a recorded answer.
**§16.** §16.10 spec updated in the same PR.
**Done when.** README accurate; spec §13 fully closed.

---

### Task 27 — Tailscale HTTPS pairing URL + `INSTALL.md` (spec §15)
**Goal.** Two contained pieces. (a) **Pairing URL:** when serving behind a proxy, the daemon prints/QRs the public **`https://<ts.net name>`** pairing URL derived from `MV_ALLOWED_HOSTS[0]` (or an explicit public-URL config), keeping the local `http` form as fallback; `buildPairingUrl` omits the port when it is the scheme default (443/80). Token stays in the fragment (T8). (b) **`microviber/INSTALL.md`:** the Claude-consumable install runbook (preconditions → build → Tailscale → `.env` → start → `tailscale serve` → pair/install → stop/rotate), each step with a `verify` command. Already drafted in the Harness repo — reconcile it against the shipped daemon here.
**§16.** No new boundary; `buildPairingUrl`/config change is unit-tested (§16.7). No transcript content in logs (§16.4).
**Done when.** Behind `tailscale serve`, the printed URL/QR opens the installable HTTPS origin on the phone; unit tests cover default-port omission and https-vs-http selection; `INSTALL.md` steps all pass their verify lines on a real install.

---

## Dependencies

```
Phase 1 ─► Phase 2 (read path) ─► Phase 3 (write paths) ─► Phase 4 (domain)
                                                         └─► Phase 5 (API+security)
Phase 5 ─► Phase 6 (notifications)
Phase 1 ─► Phase 7 (PWA)  ── needs Phase 5 for real data
All ─► Phase 8 (integration, spike, hardening)
```

Build order within a phase is listed. Security tasks (10–14) are not deferrable — they gate any real-network use.

---

## Delta from built code

The repo (`microviber/`, `main`) is built to the v2 model. Converting to takeover-via-resume is a **contained, additive change** — the read path, domain state, security, notifications, and PWA shell are untouched. The complete work:

**Daemon**
1. **`session-manager.ts`** — add `startTakeoverSession({ sessionId, cwd, … })` alongside `startOwnedSession`, sharing the spawn/stdin/init-parse core; it passes `--resume <sessionId>` (not `-n <name>`) and returns a handle whose `sessionId` is the resumed id. (Task 6)
2. **`prompt-sender.ts`** — change `PromptSender.mode` from `'attach' | 'owned'` to `'readonly' | 'owned'`; delete the attach/peer-socket doc comment and the not-implemented attach sender in `services.ts`. (Tasks 6, 8, 9)
3. **`domain/ownership.ts`** (new) — owned-map acquire/release/reap keyed by resumed `sessionId`; idle-gate check; reap on child exit. (Task 6)
4. **routes** — replace `POST /api/sessions/owned` + the attach send stub with `POST /api/sessions/:id/takeover` (idle-gated, `FORBIDDEN` otherwise) and `POST /api/sessions/:id/handback`; make `POST …/prompt` return `FORBIDDEN` when the session isn't owned. (Task 12)
5. **`registry.ts`** — derive `readonly`/`owned` (and `writable`) from owned-map membership; expose `takenOver`. (Task 8)
6. **`prompt-lifecycle.ts`** — drop the wrapper-unwrap `injected` branch; correlation only. (Task 9)

**PWA**
7. **`Composer.tsx`** — replace the always-on composer + mode hint (and its broken attach send) with the state-driven **Take over → live composer → hand back** gate. (Task 21)
8. **`SessionPicker.tsx`** — remove "＋ start phone session"; mark taken-over rows writable. (Task 19)
9. **`App.tsx` / `lib/api.ts` / `lib/types.ts`** — swap the owned-start call for `takeover`/`handback`; `mode` → `readonly | owned`; wire `state`-driven composer gating.

**Docs**
10. **`README.md`** — replace the "two modes (attach/owned)" explanation with read-only mirror + takeover; keep the security/residual-risk posture (unchanged). (Task 26)
11. **`INSTALL.md` + HTTPS pairing URL** — add the Claude-consumable Tailscale install runbook, and make the startup pairing URL/QR the public `https://<ts.net name>` origin when serving behind a proxy (`buildPairingUrl` drops the default port). Additive; no impact on the read/write paths. (Task 27, spec §15)

Each converted task keeps its original TDD discipline: write the failing test for the new behaviour first, then delete the superseded test alongside the code it covered.

**Adapter files no longer needed:** `peer-client.ts` was never built (Task 6 was deferred in v2), so there is nothing to remove there — only the not-implemented stub in `services.ts`.
