---
id: askuserquestion-answer-mechanism-3
title: "Daemon+PWA: per-question selectedLabels so two questions sharing an option label don't cross-highlight"
status: todo
project: microviber
depends_on: [askuserquestion-answer-mechanism-2]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/36
---

## User Story
As a developer who gets asked two questions in one `AskUserQuestion` call that happen to share an option label (e.g. two Yes/No questions), I want the resolved card to highlight the actual answer to EACH question independently, so that I'm not shown a misleading "Yes" highlighted on a question I actually answered "No" to.

## Acceptance Criteria
1. `daemon/src/lib/claude-adapter/ask-user-question.ts`'s `parseAnswerText` (spec §5.3) returns a PER-QUESTION shape — `string[][]`, one array per question — instead of today's flattened `string[]` accumulated across all questions.
2. The `tool_result` resolution path (`labelsFromToolResult` / the `'tool_result'` clause of `Resolution`) is similarly scoped per question where the transport allows it — if the laptop's own answer stub genuinely cannot be split per-question, confirm that empirically before assuming, and document it as an accepted asymmetry between the two resolution clauses rather than silently leaving it inconsistent.
3. `TranscriptEvent`'s `askUserQuestion.selectedLabels` (daemon `tail.ts` + PWA `types.ts` mirror) becomes `string[][] | undefined`, one entry per question, keeping the existing "undefined = no labels / can't tell" semantics per question.
4. `AskUserQuestionCard.tsx`'s `isOn(qi, label)` matches `selectedLabels?.[qi]?.includes(label)` instead of matching across the whole flat array — a resolved two-question call where Q1="Yes" and Q2="No" now highlights ONLY the correct option in each question, even when both questions offer the same label set.
5. Existing single-question resolved-with-labels tests are updated to the new per-question shape; a new test covers the specific regression (two questions, shared option labels, confirm only the actually-selected option is highlighted in each).
6. `docs/features/askuserquestion-answer-mechanism/spec.md` §7.1's "Resolved with labels" row loses the "Known limitation" note this story closes (added in story-2's code-review fix pass, commit `2bed1b2`) — replace it with a note that this was fixed here.

## Affected Files
- `daemon/src/lib/claude-adapter/ask-user-question.ts` — `parseAnswerText` return shape.
- `daemon/src/lib/claude-adapter/tail.ts` — `TranscriptEvent.askUserQuestion.selectedLabels` type + resolution wiring.
- `daemon/test/ask-user-question.test.ts`, `daemon/test/tail.test.ts` — updated + new regression test.
- `pwa/src/lib/types.ts` — mirror the wire-shape change.
- `pwa/src/components/AskUserQuestionCard.tsx` — `isOn` per-question matching.
- `pwa/test/ask-user-question-card.test.tsx` — updated + new regression test.
- `docs/features/askuserquestion-answer-mechanism/spec.md` — close the known-limitation note.

## Technical Notes
Found during story `askuserquestion-answer-mechanism-2`'s final code review (2026-09-05): `selectedLabels` is a flat `string[]` matched via `.includes()` per question in `AskUserQuestionCard.tsx`'s `isOn()`, so two questions sharing an option label both light up regardless of which one the user (or the daemon's text-resolution parser) actually selected. This is a pre-existing bug (present since the original chip-based rendering), but story-2 is what made multi-question answering a shipped, first-class flow, so it's the reachable one now. This is a wire-shape change spanning daemon + PWA — not a client-only fix.

## Manual Test Checklist
- [ ] `cd microviber && npm run typecheck && npm run lint && npm test` — all green.
- [ ] Real session: get the model to ask two Yes/No questions in one `AskUserQuestion` call, answer them differently (e.g. "Yes" then "No"), confirm the resolved card highlights the CORRECT option in each question, not both "Yes"es or both "No"s.
