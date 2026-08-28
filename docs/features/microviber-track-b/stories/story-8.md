---
id: microviber-track-b-8
title: "AskUserQuestion detection: empirical spike + transcript-meta scanning"
status: todo
project: microviber
depends_on: []
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/15
---

## User Story
As the **MicroViber daemon**, I want to detect when a session's newest assistant turn is a pending `AskUserQuestion` tool call (and when it's since been resolved), so that the next story can stop that session from lying about its own state.

## Acceptance Criteria
1. **Prerequisite spike, must run first and gate everything else in this story:** empirically verify whether a `tool_result` content block can be written into a `--resume`'d, daemon-owned session over the same stdin stream-json transport already verified for plain user turns (architecture-spec.md F11/F13-F15) — this has never been tested, only assumed possible. Document the exact procedure followed and the observed outcome (PASS/FAIL, with a real transcript excerpt as evidence) as a new F16 row in `microviber/docs/architecture-spec.md` §2.
2. `scanTranscriptMeta`'s output gains `pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null`.
3. A `tool_use` block named `AskUserQuestion` in the newest assistant entry, with no later matching `tool_result` (by `tool_use_id`), sets `pendingQuestion` to that call's parsed `input.questions` (validated through a defensive zod schema at this boundary — Claude Code writes this data, but every parse boundary in this codebase is validated regardless).
4. A later `user`-role entry containing a `tool_result` block whose `tool_use_id` matches clears `pendingQuestion` back to `null`.
5. A `tool_use` for any tool other than `AskUserQuestion` never sets `pendingQuestion`.

## Affected Files
- `microviber/docs/architecture-spec.md` — new F16 finding row (spike outcome).
- `daemon/src/lib/claude-adapter/schemas.ts` — adds `id` to `ToolUseBlock` (needed for tool_use/tool_result matching, a real pre-existing gap), adds `ToolResultBlock`, `AskUserQuestionInputSchema`.
- `daemon/src/lib/claude-adapter/transcript-meta.ts` — `TranscriptMeta.pendingQuestion` + detection logic.
- `daemon/test/schemas.test.ts`, `daemon/test/transcript-meta.test.ts` — extended.

## Technical Notes
Full spike procedure and implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 17 and 18. **If the spike outcome is FAIL**, this story still ships the detection logic (Task 18 stands regardless — it's pure transcript parsing, independent of whether answer submission turns out to work), but the finding must be recorded honestly and story microviber-track-b-10's answer-submission acceptance criteria will need to be revisited before that story starts — do not silently proceed as if it passed.

This story is backend-only, purely additive (a new, currently-unused field) — no existing behavior changes yet (that's story microviber-track-b-9). Per spec-to-stories rule 4, verify via script.

## Manual Test Checklist
- [ ] Complete the spike (Acceptance Criterion 1) and record its outcome before writing any other code in this story.
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Verification script: feed `scanTranscriptMeta` a real transcript excerpt containing an `AskUserQuestion` tool_use with no matching tool_result, confirm `pendingQuestion` is populated with the correct question text/options.
- [ ] Feed it the same transcript plus a matching tool_result entry, confirm `pendingQuestion` is `null`.
