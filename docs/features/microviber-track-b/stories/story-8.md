---
id: microviber-track-b-8
title: "AskUserQuestion support: detection, takeover fix, and PWA answer flow"
status: in-progress
project: microviber
depends_on: []
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/15
---

## User Story
As a **developer whose laptop session is blocked on an `AskUserQuestion`**, I want MicroViber to recognize that state honestly, let me take the session over from my phone, and let me see and answer the question there, so that I'm not stuck unable to respond until the tool call's turn eventually times out (up to an hour, per the existing `OPEN_TURN_MAX_MS` window) — and so I can actually answer it without walking back to my laptop.

## Acceptance Criteria

**Prerequisite spike (must run first, gates the answer-submission criteria below):**
1. Empirically verify whether a `tool_result` content block can be written into a `--resume`'d, daemon-owned session over the same stdin stream-json transport already verified for plain user turns (architecture-spec.md F11/F13-F15) — this has never been tested, only assumed possible. Document the exact procedure followed and the observed outcome (PASS/FAIL, with a real transcript excerpt as evidence) as a new F16 row in `microviber/docs/architecture-spec.md` §2.

**Detection (daemon):**
2. `scanTranscriptMeta`'s output gains `pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null`.
3. A `tool_use` block named `AskUserQuestion` in the newest assistant entry, with no later matching `tool_result` (by `tool_use_id`), sets `pendingQuestion` to that call's parsed `input.questions` (validated through a defensive zod schema at this boundary).
4. A later `user`-role entry containing a `tool_result` block whose `tool_use_id` matches clears `pendingQuestion` back to `null`.
5. A `tool_use` for any tool other than `AskUserQuestion` never sets `pendingQuestion`.

**The actual bug fix (daemon — this is a real bug fix, not just new UI):**
6. Today, `deriveState` treats any open turn (`turnOpen: true`, which an `AskUserQuestion` tool call produces since the assistant entry stops with `stop_reason: 'tool_use'`, not `'end_turn'`) as `working` for up to `OPEN_TURN_MAX_MS` (60 minutes) — and takeover is gated on `state === 'idle'`. Net effect before this story: **a session blocked on `AskUserQuestion` cannot be taken over at all** for up to an hour. Verify this bug reproduces against the actual pre-fix code before claiming it's fixed.
7. `SessionState` gains a fourth value, `'awaiting-input'`.
8. `deriveState` gains a `hasPendingQuestion: boolean` input; when true, the result is `'awaiting-input'` **unconditionally** — a structural override, checked immediately after the `!alive` check and before every timing-based rule (including `notify_idle` and the 20s/60min growth windows), not another heuristic layered alongside them.
9. `assertIdleForTakeover` accepts `'awaiting-input'` alongside `'idle'` — the actual fix that unblocks takeover.
10. `NotifyPolicy`'s own independent `State` type (not imported from `session-state.ts`) gains `'awaiting-input'` as a second value that counts as "waiting for you," alongside `'idle'`, for both the notify-on-transition and dismiss-on-leaving logic — verified to not double-notify a session moving directly between `idle` and `awaiting-input`.

**PWA — rendering and answering (gated on criterion 1's outcome for the interactive piece):**
11. `awaiting-input` sessions get a state-dot treatment in the session picker visibly distinct from both `working` and `idle` (the dropdown's `STATE_DOT` map already reserves a color for it, shipped in story microviber-track-b-6 — this story is what actually produces `'awaiting-input'` values for it to render).
12. An `AskUserQuestion` tool call **always** renders expanded in the transcript — question text, header, and options as a real list — never the generic "collapse to one line" treatment every other tool call gets.
13. A **resolved** question (its `tool_result` has arrived) renders the same layout read-only/dimmed, with the actually-selected option(s) highlighted.
14. The composer's status-bar state table gains `awaiting-input` as a second mapping to the existing "Take over — send from phone" button — **no shortcut**: per the explicit decision recorded in `docs/features/microviber-track-b/spec.md` §9, answering still requires the same explicit take-over tap as everything else, even though the `awaiting-input` signal is structural rather than a heuristic.
15. **If and only if criterion 1 recorded PASS:** once taken over, tapping an option on a *pending* question submits it as a plain prompt through the existing `send()` path (reusing its accepted/queued/failed lifecycle unchanged) — options are only tappable when `mode === 'owned'` and the question is unresolved. **If criterion 1 recorded FAIL:** render the question and its options per criteria 12-13 but leave them inert (non-interactive) even when taken over, and flag in the PR description (not a code comment) that submission is pending a resolved design — do not invent an alternative submission mechanism inline without returning to brainstorming first.

## Affected Files
- `microviber/docs/architecture-spec.md` — new F16 finding row (spike outcome).
- `daemon/src/lib/claude-adapter/schemas.ts` — adds `id` to `ToolUseBlock` (needed for tool_use/tool_result matching, a real pre-existing gap), adds `ToolResultBlock`, `AskUserQuestionInputSchema`.
- `daemon/src/lib/claude-adapter/transcript-meta.ts` — `TranscriptMeta.pendingQuestion` + detection logic.
- `daemon/src/domain/session-state.ts` — `SessionState`, `deriveState`.
- `daemon/src/domain/ownership.ts` — `assertIdleForTakeover`.
- `daemon/src/domain/registry.ts` — threads `pendingQuestion`/`hasPendingQuestion` into `buildSummary`.
- `daemon/src/lib/claude-adapter/discovery.ts` — passes `pendingQuestion` through from `scanTranscriptMeta`'s output.
- `daemon/src/domain/notify-policy.ts` — `State` type extension, `isWaitingForYou` helper.
- `pwa/src/lib/types.ts` — `SessionState` gains `'awaiting-input'`; `TranscriptEvent` gains an `askUserQuestion` kind.
- `pwa/src/components/Transcript.tsx` — renders pending/resolved questions.
- `pwa/src/components/Composer.tsx` / `pwa/src/App.tsx` — `awaiting-input` → Take-over-button mapping; answer submission wiring.
- `daemon/test/schemas.test.ts`, `daemon/test/transcript-meta.test.ts`, `daemon/test/session-state.test.ts`, `daemon/test/ownership.test.ts`, `daemon/test/registry.test.ts`, `daemon/test/notify-policy.test.ts` — extended.
- `pwa/test/transcript-askuserquestion.test.tsx` — new; other affected PWA test files extended.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 17-21 — originally spread across three stories (detection, state-derivation fix, PWA UI), merged here into one because they form a single coherent bug-fix-plus-feature with no independently shippable intermediate state that isn't itself either "detects a thing nothing reads yet" or "reads a thing that doesn't exist yet." Do the work in the order the acceptance criteria are numbered — the spike gates criterion 15, detection gates the state fix, the state fix gates the PWA UI.

**Explicit scope boundary — do not expand this story to cover it:** `NotifyPolicy` has zero call sites anywhere in the shipped app today (confirmed via workspace-wide grep — only its own unit test consumes it), and the daemon has **no push-dispatch mechanism of any kind** despite `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` existing in `config.ts`. Criterion 10 makes `NotifyPolicy`'s logic correct and ready; it does **not** wire it into `app.ts`/`services.ts`, and does **not** build a `web-push`-based sender. That's a separate, larger pre-existing gap — file it as its own follow-up story rather than absorbing it here.

Given the combined size (a genuine spike plus two backend subsystems plus PWA UI), consider committing in stages that mirror the acceptance-criteria groups above (spike → detection → state fix → PWA UI) even though it's one story/PR, so a reviewer can follow the sequence.

**Reconciliation note (2026-09-02):** this story was originally split into three (microviber-track-b-8/9/10, issues #15/#16/#17). GitHub issue #15 was subsequently edited to merge all three into one combined story, and issues #16/#17 were closed as superseded. This local file was re-synced from issue #15's body to match; see `stories/story-9.md` and `stories/story-10.md` for the superseded originals and `stories/README.md` for the updated index.

## Manual Test Checklist
- [ ] Complete the spike (criterion 1) and record its outcome before writing any other code in this story.
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Verification script: feed `scanTranscriptMeta` a real transcript excerpt containing an `AskUserQuestion` tool_use with no matching tool_result, confirm `pendingQuestion` is populated with the correct question text/options; feed it the same transcript plus a matching tool_result entry, confirm `pendingQuestion` is `null`.
- [ ] **Before implementing the state fix**, reproduce the bug on current `main`: get a real session to call `AskUserQuestion`, confirm the daemon reports it as `working` and that `POST /api/sessions/:id/takeover` 403s.
- [ ] **After implementing**, repeat: confirm the session now reports `awaiting-input` and takeover succeeds.
- [ ] Confirm a session with a genuinely open non-question tool call (e.g. mid-`Bash`) still correctly reports `working`, not `awaiting-input` — no regression to the existing open-turn heuristic.
- [ ] On the phone, confirm the session list shows the distinct `awaiting-input` dot and the transcript shows the question expanded with real options.
- [ ] If the spike passed: tap "Take over," then tap an option; confirm it submits and the session continues normally. If the spike failed: confirm the options render but are inert, with no submission affordance.
- [ ] Confirm a resolved question elsewhere in the transcript renders read-only with the actually-chosen option highlighted, not tappable.
- [ ] Confirm a non-`AskUserQuestion` tool call is unaffected — still collapses to one line as before.
