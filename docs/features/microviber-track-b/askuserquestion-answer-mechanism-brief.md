# Brief: AskUserQuestion answer-submission mechanism

**Purpose:** seed material for a fresh `syncounter-brainstorming` session on MicroViber. Everything below is already true/shipped/verified — the brainstorming session's job is to design a working answer-submission mechanism, not to re-derive any of this.

**Status:** story `microviber-track-b-8` shipped everything except interactive answering. See `docs/features/microviber-track-b/stories/story-8.md` (AC15 resolution note) and `docs/architecture-spec.md` §2 (F16, F17) for the full paper trail this brief summarizes.

**Outcome (2026-09-03):** brainstormed — see [`../askuserquestion-answer-mechanism/spec.md`](../askuserquestion-answer-mechanism/spec.md). The §6 hybrid was adopted with transcript-derived resolution instead of daemon-side state; F18 records that the handshake is conditional and that `AskUserQuestion` is disabled in `-p`.

---

## 1. What already works (do not redesign this)

MicroViber can now:
- Detect a pending `AskUserQuestion` tool call in a session's transcript (`daemon/src/lib/claude-adapter/transcript-meta.ts`, `tail.ts`).
- Correctly report the session as a distinct `awaiting-input` state — a structural override that unblocks phone takeover, which was previously impossible for up to an hour (the actual bug this story fixed).
- Render the pending question expanded on the phone, with real options, in the session's live transcript view (`pwa/src/components/Transcript.tsx`).
- Render a **resolved** question read-only with the selected option highlighted, once a real answer lands.

All of this is tested (313 daemon + 122 pwa tests) and verified against real live sessions, not just fixtures.

## 2. The unsolved problem

**Goal:** a developer takes over a session that's blocked on `AskUserQuestion`, taps an answer option on their phone, and the laptop session continues normally — the actual point of the story (see the User Story in `story-8.md`).

**Current state:** the phone renders the question but the options are **inert** (non-tappable). No submission mechanism has been found that reliably works. Two have been tried and empirically ruled out:

### Attempt 1 — plain-text prompt (the story's original design, AC15 as originally written)
Send the tapped label as an ordinary prompt through the existing `send()`/`userFrame()` path (the same mechanism used for any normal phone-injected prompt).

- **Conversationally coherent**: the model understands and correctly acts on the answer. Real example, verified live: sending `"Yes"` as a plain prompt after a pending `AskUserQuestion` produced the model reply *"Got it — noted as 'yes.' Nothing further pending from me; let me know what you'd like to do next."* — a completely sensible, on-topic response.
- **But never resolves the pending state**: Claude Code does not backfill a `tool_result` for the abandoned tool_use just because a later plain-text turn arrived. Grepping the resulting transcript for the original `tool_use_id` finds it exactly once (the original call) — never a `tool_result`. So `pendingQuestion` (and the `awaiting-input` state) stays stuck **forever** after this kind of answer, even though the conversation itself is fine.

### Attempt 2 — real `tool_result` frame (Task 7, added specifically to fix Attempt 1's stuck-state problem)
Send `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"<id>","content":"<label>"}]}}` — the literal mechanism the Anthropic API defines for resolving a tool call, written to the daemon's takeover stdin (same transport as F11/F13-F15's already-verified plain-prompt writes).

- **The write itself lands correctly** (F16): verified directly — the transcript grows with a `tool_result` entry correctly attributed to the pending `tool_use_id`, and `pendingQuestion` clears (`resolved: true`, `awaiting-input` → `idle`) when re-derived from the real resulting transcript by the actual shipped code.
- **But the model does not coherently continue from it** (F17): `claude -p --resume` unconditionally injects its own synthetic `"Continue from where you left off."` handshake turn (`isMeta: true` in the transcript) the instant the process starts — **before processing anything on stdin, regardless of delay**. Reproduced identically across 4+ independent real sessions, including one where the `tool_result` was the literal first and only stdin content ever written (zero delay between spawn and write). Once that synthetic turn completes, the model's own most recent turn is no longer the tool_use — so when the real `tool_result` arrives afterward, it's technically valid (hence F16's bookkeeping success) but the model treats it as orphaned: it searches for an `AskUserQuestion` tool (doesn't find one — headless `-p` sessions never expose it), gives up, and just re-presents the original question in plain text instead of incorporating the answer.

**The asymmetry is the interesting part:** plain text is conversationally coherent but never resolves our own tracking; `tool_result` resolves our tracking but is not conversationally coherent. Neither alone is AC15.

## 3. Evidence trail (for verification, not to be re-derived)

- `docs/architecture-spec.md` §2, rows **F16** and **F17** — full procedure and real transcript excerpts for both.
- Every reproduction was against genuinely independent, non-nested real sessions (a VS Code session that was never reopened afterward, ruling out any "stale client reconnecting" theory).
- The synthetic handshake is **not specific to AskUserQuestion or to MicroViber's code** — the exact same `"Continue from where you left off."` / `isMeta: true` pattern was found in ordinary session-resume activity unrelated to this feature (confirmed by grepping across multiple unrelated transcripts). It appears to be intrinsic behavior of `claude -p --resume ... --input-format stream-json`, triggered by *any* resume that doesn't already have queued work, not something introduced by or fixable purely within MicroViber's own daemon code.
- Ordinary plain-text prompts sent to a resumed session *after* this handshake are picked up by the model normally — the confusion is specific to a `tool_result` referencing a tool_use that's no longer the model's own most recent turn.

## 4. Constraints for a new design

- **No new trust boundary** (existing architecture rule, `docs/architecture-spec.md` §16 / this story's own Global Constraints): whatever mechanism is chosen must reuse the existing takeover-gated write path and its protections — bearer auth, ownership checks, audit logging. Not negotiable.
- The daemon only ever drives sessions via `claude -p --resume ... --input-format stream-json --output-format stream-json` (headless). This is a deliberate architectural choice (`daemon/src/lib/claude-adapter/session-manager.ts`), not incidental — a solution that requires a different invocation mode needs to justify that change explicitly.
- Whatever ships must give the user honest feedback. The current interim state (inert, read-only options) was chosen specifically to avoid shipping something that *looks* interactive but silently fails — do not regress to that.

## 5. Relevant code, already built and available to reuse

- `daemon/src/lib/claude-adapter/prompt-sender.ts` — `userFrame()` (plain text, existing) and `toolResultFrame()` (tool_result, Task 7 — verified byte-for-byte matching F16's confirmed-working shape).
- `daemon/src/lib/claude-adapter/session-manager.ts` — `OwnedSessionHandle.send()` (plain) and `.sendAnswer()` (tool_result, Task 7).
- `daemon/src/domain/prompt-lifecycle.ts` — `PromptLifecycle.submit()`/`.observe()` (plain-text accepted-tracking, matches by exact text) and `.submitAnswer()`/`.observeAnswer()` (tool_result accepted-tracking, matches by `toolUseId` — Task 7).
- `daemon/src/lib/claude-adapter/tail.ts` — `resolveAskUserQuestions()`, the cross-line resolution matcher (by `tool_use_id`, not adjacency — this part is correct and durable regardless of what mechanism ships).
- All of the above is tested and reviewed; a new design can call into it, extend it, or bypass it, but shouldn't need to rediscover how it works.

## 6. One observed direction worth considering (not a decision — brainstorming's call)

The coherence/tracking asymmetry in §2 suggests a possible hybrid: submit the answer as a **plain-text prompt** (already proven conversationally coherent) through the *existing*, working `send()` path, and have the daemon mark the corresponding `pendingQuestion` as resolved through its **own** bookkeeping the moment that specific prompt is accepted — rather than waiting for a genuine `tool_result` to appear in the transcript. This sidesteps F17 entirely (no `tool_result` frame needed, so the broken conversational path is never exercised) at the cost of the daemon's resolution state being "trust that our own write succeeded" rather than "independently re-derived from the transcript like everything else." Whether that trade-off is acceptable — and whether it holds up under the same rigor as everything else in this story (a fresh transcript re-scan should still show pendingQuestion cleared even after a daemon restart, page reload, etc.) — is exactly the kind of question brainstorming should work through, not something to assume.

## 7. Open questions for brainstorming

1. Is there any `claude` CLI flag, invocation variant, or SDK option that suppresses the automatic `"Continue from where you left off."` handshake? (Not yet investigated — F17 only confirms the behavior exists, not that it's unavoidable.)
2. Does genuinely interactive (non-`-p`) `--resume` avoid this handshake? If so, is there a viable way to drive that from a headless daemon at all?
3. Is the §6 hybrid direction (plain-text send + daemon-side-only resolution tracking) acceptable given the "everything else re-derives from the real transcript" pattern the rest of this story follows — or does that inconsistency matter enough to require a real transcript-verifiable resolution?
4. Whatever ships, how does it interact with a subsequent page reload / daemon restart — is resolution state properly durable, or does an unlucky restart mid-flow lose it?
