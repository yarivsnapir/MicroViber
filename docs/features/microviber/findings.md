# MicroViber — Phase 0 Findings

> Investigation run 2026-08-23 on this machine. Claude Code CLI/extension `2.1.216`–`2.1.237`, `peerProtocol: 1`.
> Method: string-mining the shipped native binary + live probes on disposable sessions (cleaned up after).

---

## Investigation 1 — [GATE] Native user-turn frame — **RESOLVED, with a fork**

**Question.** Can a prompt be delivered to a running session as a *genuine user turn* (spec §3.1), not the `<cross-session-message>` peer wrapper?

**Method.**
1. Mined the shipped `native-binary/claude` for the peer/socket vocabulary.
2. Read the `UserCrossSessionMessage` render component and the wrapper builder/parser in the binary.
3. Live probe A: peer-socket send into a disposable → observed the transcript entry (reconfirms the earlier PONG result).
4. Live probe B: a plain `{"type":"user",...}` frame written to a disposable session's **stdin** (which the launcher owns via a fifo) → observed the transcript entry.

**Result — two distinct channels into a running session, with opposite framing:**

| Channel | How reached | Transcript entry | Satisfies §3.1? |
|---|---|---|---|
| **Peer socket** `/tmp/cc-socks/<pid>.sock` | Any process with the `peerToken` | `user` entry **wrapped** in `<cross-session-message from=… from-mode=…>`, rendered by the `UserCrossSessionMessage` component as `@ <name>` | ❌ No |
| **stdin stream-json** | Only the process that **owns the child's stdin** | Plain `user` entry — verified: `USER >> 'Reply with exactly one word: STDINPROBE'`, no wrapper | ✅ Yes |

Confirmed from the binary, verbatim: *"Incoming peer messages arrive as user-role messages wrapped in `<cross-session-message from="...">` — they look like user input but are from another Claude, not your user."* `from-mode` values are only `default` / `bypass` (the **sender's** permission mode), never a delivery mode that skips the wrapper. The messaging socket's other methods are the **IDE bridge** (`project_read`, `write_files`, `list_files`, `initialize`, `ping`) — file ops, **no prompt-submit method**. There is no un-wrapped injection path over any socket.

**Conclusion.** A native user-turn frame exists (stdin stream-json — which is the *documented Claude Agent SDK transport*, the most stable interface Claude Code has), **but it is reachable only by the process that launched the session.** You cannot write another process's stdin safely. Therefore:

- **To attach to an existing VS Code/terminal session** → the only write path is the peer socket → **prompts are wrapped** → §3.1 **cannot** be met, and a phone prompt **cannot approve a pending permission/question** in that session.
- **To get plain user turns (§3.1)** → MicroViber must **own the session's stdin** → it must **launch the session itself** (headless `claude` via the SDK stream-json protocol) → the session is MicroViber-owned, not a VS Code tab.

**This is the fork the plan reserved for the user (outcome 3-adjacent).** §3.1 and "attach to the VS Code sessions I already have open" are **mutually exclusive** with stable mechanisms. See the decision section below.

---

## Investigation 2 — Does the injected prompt render as a user bubble — **RESOLVED by I1**

- **Peer-socket (wrapped) prompt:** renders as `@ <peer-name>` via `UserCrossSessionMessage`, *not* as a normal user turn. This is deliberate product behavior, stable, not a bug.
- **stdin (plain) prompt:** renders as a normal user turn (STDINPROBE showed a plain `USER` entry).

So R5's asymmetry is explained: the wrapper is intentionally rendered distinctly. Which renderer you get is determined entirely by which channel you use (I1). No separate mitigation needed — the choice of channel *is* the mitigation.

---

## Investigation 3 — Idle-subscription one-shot semantics — **PARTIAL**

The `notify_idle` peer feature and the `enqueuePendingNotification` / `peer_idle` machinery are present in the binary. Full one-shot-vs-persistent confirmation is best done once the daemon holds a real subscription (it needs a live subscriber to observe redelivery). **Deferred to the first daemon spike (plan Task 3/19).** Design impact is contained: spec §5.1's idle *state* derivation is deliberately independent of the subscription, so session state is correct either way; only the re-subscribe bookkeeping in Task 19 depends on this.

**Mitigation already in the design:** the host-agnostic 20s no-growth heuristic is the primary idle signal, so notifications do not depend on `notify_idle` being one-shot or even present.

---

## Investigation 4 — Version-gate range & peerToken lifetime — **RESOLVED**

Observed live: versions `2.1.216`, `2.1.228`, `2.1.231`, `2.1.237` — **all `peerProtocol: 1`**. A 21-patch spread with a single protocol number.

**Decisions:**
- **Gate on `peerProtocol`, not `version`.** Protocol is the stable, coarse compatibility signal; `version` is recorded for diagnostics only. This means the adapter keeps working across normal Claude Code updates and only degrades to read-only if `peerProtocol` changes — exactly the fail-closed behavior spec §16.5 wants.
- **Bonus:** the session JSON's `entrypoint` field (`claude-vscode` vs `cli`) is a cleaner host discriminator than the process-path check the plan assumed. Use `entrypoint`; corroborate with `peerFeatures`.
- peerToken lifetime: to be confirmed in the daemon spike; treat as possibly per-launch and re-read the `.key` on reconnect (cheap, safe default).

---

## Investigation 5 — Transport — **RESOLVED (adapted)**

**Tailscale is NOT installed on this machine.** Per spec §9, a public tunnel (ngrok/Cloudflare) is rejected for an endpoint that executes code on the laptop.

**Decision:** the daemon is made **transport-agnostic** — it binds to a single configurable address and never `0.0.0.0`, and the tunnel is an *external* concern the user sets up (Tailscale recommended; `tailscale up` + `tailscale cert` is a 5-minute install). This is both the most stable design (the daemon has no tunnel dependency to break) and the most flexible. Task 5 becomes "install Tailscale and confirm cert issuance" as a user setup step, not a code dependency. Until then, LAN-bind works for same-wifi testing.

---

## The decision only the user can make

**§3.1 (mobile prompts read as ordinary prompts) forces a choice about what MicroViber fundamentally is:**

**Path A — Attach to existing sessions (mirror + peer-socket send).**
Matches the stated workflow ("I run a command in a VS Code tab, then leave"). Read = perfect live mirror. Send works, but every phone prompt is wrapped as an `@peer` message and **cannot approve a pending permission/question**. §3.1 is *not* met. Relies on the undocumented peer socket for writes.

**Path B — MicroViber owns the sessions (SDK stream-json).**
Uses the **documented, most-stable** Claude Code interface. Phone prompts are genuine user turns — §3.1 fully met, can approve anything. But these are sessions you start *through MicroViber*, not your existing VS Code tabs. You'd still see them at the laptop (same transcript on disk), but to drive them at the laptop you'd use MicroViber's own view or resume them, not the VS Code tab.

**Recommendation (given "as stable as possible"):** a **hybrid with Path A as the default and Path B available** — attach-and-mirror any existing session for the common micro-moment ("did it finish? send a follow-up"), and offer "start a phone-owned session" (Path B) for work you intend to drive primarily from the phone with full fidelity. The daemon's read path (transcript tail) and discovery are identical for both; only the *write* path differs (peer socket vs owned stdin), cleanly isolated in the adapter. This delivers the user's real workflow immediately and reserves full §3.1 for when it matters, at the cost of one clearly-labeled mode toggle.

---

## Build note (2026-08-23)

Tasks 1–5, 7–22, 25 built and committed on `feature/microviber` (in `microviber/`).
Daemon verified live serving real sessions over authenticated HTTP; PWA compiles
to a production bundle (108 tests green). Two Phase-0 items remain genuinely open
and are deferred to the daemon+phone spike (plan Task 24), each with a safe
default already shipped:
- **I3 idle one-shot semantics** — notify-policy uses the host-agnostic idle
  heuristic, so notifications work regardless; only re-subscribe bookkeeping
  depends on the answer.
- **I6 peerToken lifetime** — the peer client (Task 6, deferred) will re-read the
  `.key` on reconnect as the safe default.

---

## Investigation 6 — Attach-mode send (Task 6): peer socket rejects standalone clients

**Question.** Can the MicroViber daemon send a prompt to an *existing* Claude session by speaking the peer socket protocol directly?

**Method.** Against a disposable session: read its `peerToken` (32 hex) and `messagingSocketPath`. Mined the binary for the wire protocol (found `{"type":"auth","token":...}`, `writeUInt32/readUInt32` length-prefix hints, `peerToken` classification as role "peer"). Then a standalone Node client tried: (a) newline-delimited JSON auth + 6 candidate message frames; (b) 4-byte-length-prefixed auth + message frames. Control: sent the *same* message to the *same* session via a real Claude peer (the harness SendMessage).

**Result — decisive.**
- Standalone socket client: **no server response to auth or any frame; nothing delivered** to the transcript, across both framings and all candidate shapes, with the correct token.
- Same message via a **real Claude peer**: landed immediately (`RELAYMARK` prompt + `RELAYOK` reply in the transcript).

**Conclusion.** The peer socket **only accepts messages from a registered Claude session**, not an external process — the server validates the connecting peer (peer credentials / registered-session check), so token-plus-framing alone is insufficient. **Attach-send from a standalone daemon is not achievable directly.**

**Implications / options.**
1. **Relay** — the daemon spawns a long-lived owned Claude session and drives it (via stdin) to `SendMessage` to the target. Works (the relay is a real peer), but: heavier (a persistent extra Claude process), still `@peer`-framed (target can't treat it as user intent → **cannot answer the session's own permission/clarifying questions**), two-hop. Delivers "give the next instruction" but not "answer its question".
2. **Fall back (plan's stated fallback):** attach = **watch-only**; sending uses **owned mode**. Simplest and most stable.

This is the fragile outcome the plan reserved as a possible result of Task 6. Recommendation: option 2 unless the user specifically wants relayed `@peer` follow-ups to existing sessions and accepts the overhead + the can't-answer-questions limit.

---

## Investigation 7 — Takeover via resume (2026-08-24): the write path

**Question.** Since attach-send is infeasible (Investigation 6), can MicroViber write to a laptop-started session by *resuming* it — and does that fork the conversation or continue it? Critically: does resume work while the laptop's session is still alive and idle (an open tab)?

**Method.** Two controlled tests in throwaway dirs (Claude Code CLI on this machine), cleaned up after:
1. **Resume append test.** Created a session (`-p`), noted its `<id>.jsonl` (16 lines). Ran `claude --resume <id> -p "recall + SECOND"`. Observed returned session_id, recall, and file behaviour.
2. **Resume-while-live test.** Held a session alive & idle via a persistent `--input-format stream-json` process (simulating an open idle tab), captured its session_id (`fd42…`, 13 lines). While that process stayed alive, ran a *second* process `claude --resume fd42… -p "recall + BETA"`.

**Results — decisive.**
- **F13 — no fork.** Resume returned the **same** session_id and grew the **same** `<id>.jsonl` (16→34 lines). No second file. History is one append-only file; resume continues it.
- **F14 — resume works against a live idle session.** The persistent process stayed alive (`kill -0` = yes) throughout; the second `claude --resume` succeeded (exit 0, no lock/error), grew the shared file 13→21 lines. The original process was left holding a **stale** in-memory view (frozen at 13) — confirming the laptop must `/resume` to catch up.
- **F15 — full history carried.** The resumed process answered `ALPHA BETA` / `FIRST SECOND`, proving it loaded the whole prior transcript.

**Conclusion.** The write path is **takeover-via-resume** (spec §3.2): read-only mirror always; a deliberate **Take over** (gated on `idle`) spawns a daemon-owned `claude --resume` that writes plain user turns (F11) to the same history file. One shared source of truth; phone and laptop take turns. Baton discipline + idle-gating keep writers serial; the conflict case (user types in the stale laptop tab) is left unpoliced per the user's rule "do nothing".

**Open (checkpoint 13.7).** Ownership lifecycle — parenting the resume child across daemon restarts, keeping it findable in discovery, teardown on hand-back/abandonment. F14 proves the resume itself; this is the process-management layer around it.
