---
id: microviber-track-b-10
title: "AskUserQuestion: PWA rendering + answer submission"
status: superseded
project: microviber
depends_on: [microviber-track-b-9]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/17
---

> **Superseded (2026-09-02):** this story's scope was merged into
> [story-8](story-8.md) (GitHub issue [#15](https://github.com/yarivsnapir/MicroViber/issues/15)),
> which now covers the combined spike + detection + state-fix + PWA-UI work
> as a single story/PR. Issue #17 was closed as part of that merge. The
> content below is kept for historical reference only — do not implement it
> separately.

## User Story
As a **developer whose laptop session is waiting on an `AskUserQuestion`**, I want to see the actual question and its options on my phone, take the session over, and answer it, so that I'm not stuck at my laptop just to respond to a structured question.

## Acceptance Criteria
1. `awaiting-input` sessions get a state-dot treatment in the session picker visibly distinct from both `working` and `idle` (the dropdown's `STATE_DOT` map already reserves a color for it, from story microviber-track-b-6 — this story is what actually produces `'awaiting-input'` values for it to render).
2. An `AskUserQuestion` tool call **always** renders expanded in the transcript — question text, header, and options as a real list — never the generic "collapse to one line" treatment every other tool call gets.
3. A **resolved** question (its `tool_result` has arrived) renders the same layout read-only/dimmed, with the actually-selected option(s) highlighted.
4. The composer's status-bar state table gains `awaiting-input` as a second mapping to the existing "Take over — send from phone" button — **no shortcut**: per the explicit decision recorded in `docs/features/microviber-track-b/spec.md` §9, answering still requires the same explicit take-over tap as everything else, even though the `awaiting-input` signal is structural rather than a heuristic.
5. **Gated on story microviber-track-b-8's spike outcome (PASS required):** once taken over, tapping an option on a *pending* question submits it as a plain prompt through the existing `send()` path (reusing its accepted/queued/failed lifecycle unchanged) — options are only tappable when `mode === 'owned'` and the question is unresolved.

## Affected Files
- `pwa/src/lib/types.ts` — `SessionState` gains `'awaiting-input'`; `TranscriptEvent` gains an `askUserQuestion` kind.
- `pwa/src/components/Transcript.tsx` — renders pending/resolved questions.
- `pwa/src/components/Composer.tsx` / `pwa/src/App.tsx` — `awaiting-input` → Take-over-button mapping; answer submission wiring.
- `pwa/test/transcript-askuserquestion.test.tsx` — new; other affected test files extended.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Task 21. Depends on story microviber-track-b-9 for the `awaiting-input` `SessionState` value and `pendingQuestion` data to render.

**If story microviber-track-b-8's spike recorded FAIL:** implement everything in this story except Acceptance Criterion 5 — render the question and its options, but leave them inert (non-interactive) even when taken over, and flag in the PR description (not as a code comment) that submission is pending a resolved design. Do not invent an alternative submission mechanism inline without returning to brainstorming first.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Get a real session to call `AskUserQuestion`; confirm the phone's session list shows the distinct `awaiting-input` dot and the transcript shows the question expanded with real options.
- [ ] Tap "Take over," then tap an option; confirm it submits and the session continues normally (accepted → the model's next turn reflects the answer).
- [ ] Confirm a resolved question elsewhere in the transcript renders read-only with the actually-chosen option highlighted, not tappable.
- [ ] Confirm a non-`AskUserQuestion` tool call is unaffected — still collapses to one line as before.
