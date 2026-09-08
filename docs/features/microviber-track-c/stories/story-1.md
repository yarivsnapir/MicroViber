---
id: microviber-track-c-1
title: Widen the transcript event stream and render every kind, including diffs
status: in-progress
project: microviber
depends_on: []
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/37
---

## User Story
As a **developer reading a session from my phone**, I want **the transcript to show everything that actually happened — the assistant's prose, every tool call with its real arguments, what each tool returned, the reasoning, and a diff for each file edit**, so that **I can follow and judge the work without walking back to the laptop**.

## Acceptance Criteria

### Normalizer: stop discarding transcript data
1. An assistant message containing both a `text` block and a `tool_use` block produces **both** an `assistant` event and a `tool` event. Today the prose is discarded.
2. An assistant message containing several `tool_use` blocks produces **one `tool` event per block**, in source order. Today only the last survives.
3. Several `text` blocks in one message join with a blank line, not a single space, so paragraph breaks survive into the rendered markdown.
4. `normalizeLine` returns `TranscriptEvent[]`; an unparseable or unrenderable line returns `[]` rather than `null`.
5. A `tool_result` block produces a `toolResult` event carrying `toolUseId`, `ok`, `text` and `truncated`.
6. A user line containing **only** `tool_result` blocks produces **no** `user` event. This is the fix for the empty grey bordered box that currently appears for every tool result.
7. `ok` is `false` when the block carries `is_error: true`, and `true` otherwise.
8. `tool_result` content that is an array of blocks flattens to its text blocks joined by newlines; content that is neither a string nor an array serialises to JSON; absent content yields an empty string.
9. A `thinking` block produces a `thinking` event carrying its text. Today thinking blocks match no branch and render as an empty gutter row.
10. The `error` event kind is **removed** from the daemon union and the PWA mirror. Nothing has ever constructed it.
11. A `tool` event carries the complete `input` object and the tool_use `id`, not just one summarised scalar. `summary` is unchanged and still drives the collapsed one-liner.
12. Each **string field** in `input`, and each `toolResult.text`, is capped at 32000 characters, with `truncated: true` set when anything was cut. Capping per field rather than serialising the whole object is deliberate: the object must keep its shape so the diff renderer can address `old_string` and `new_string` by name.
13. A non-object tool input yields `input: {}` rather than throwing.

### AskUserQuestion must not regress
14. The `AskUserQuestion` path keeps its whole-content short-circuit and still produces exactly one `askUserQuestion` event per line. Every existing test in `daemon/test/tail.test.ts` covering detection and cross-line resolution passes **unmodified**.
15. A tool_result line that resolves a pending `AskUserQuestion` is still dropped in full and does **not** surface as a `toolResult`. Covered by an explicit regression test.

### Renderer
16. **`EventRow` gains a tolerant fallback** returning `null` for any unrecognised event kind, instead of falling off the end of the switch and returning `undefined`. See Technical Notes for why this is load bearing rather than merely defensive.
17. Tool results render as a collapsed one-line preview, expandable on tap, with a failed result visually tinted.
18. Tool calls render collapsed to one line, expandable on tap to a key and value list of the full input, with a notice when the payload was capped. This finally implements the line in `docs/functional-spec.md` promising "Tool calls collapse to one line each, expandable on tap", which no code has ever satisfied.
19. Thinking renders as a collapsed marker by default, per the functional spec's rule that thinking is a marker and not a wall of text, and expands to its text on tap.
20. Expanding an `Edit` or `MultiEdit` whose input has string `old_string` and `new_string` renders a red and green line diff. A `Write` renders as an all-addition diff.
21. Diff context is capped at three lines either side, so a one-line edit in a large file renders as a small hunk rather than the whole file.
22. The diff has its own horizontal scroll container, so a long line never makes the whole transcript scroll sideways.
23. Every other input field still appears in the key and value list, so a `MultiEdit` edit array and a `TodoWrite` todo list stay visible.
24. `lineDiff` is a pure exported function with its own unit tests, independent of React.
25. `pwa/src/lib/types.ts` is updated in lockstep with every daemon union change, in the same commit as that change.
26. `npm run typecheck && npm run lint && npm test` is green from the repo root.

## Affected Files
- `daemon/src/lib/claude-adapter/schemas.ts` — add `ThinkingBlock`, add `is_error` to `ToolResultBlock`, and add both to the `Content` union so they stop falling through the passthrough catch-all.
- `daemon/src/lib/claude-adapter/tail.ts` — widen `TranscriptEvent`; `normalizeLine` returns an array; replace `normalizeContent` with `assistantEvents` / `userEvents` block walkers; add `TOOL_PAYLOAD_MAX_CHARS`, `capText`, `capInput`, `toolResultText`; `parseChunk` flattens while preserving each event's line index.
- `daemon/test/tail.test.ts` — existing single-event call sites become array assertions. **Deliberate updates, not deletions** — see Technical Notes.
- `daemon/test/schemas.test.ts` — new block-parsing cases.
- `pwa/src/lib/types.ts` — mirror the widened union; remove the `error` member.
- `pwa/src/components/Transcript.tsx` — tolerant fallback in `EventRow`; dispatch the new per-kind components.
- `pwa/src/components/transcript/ToolResult.tsx` — **new.**
- `pwa/src/components/transcript/ToolCall.tsx` — **new.** Includes the diff branch.
- `pwa/src/components/transcript/Thinking.tsx` — **new.**
- `pwa/src/components/transcript/DiffView.tsx` — **new.**
- `pwa/src/lib/diff.ts` — **new.** Pure `lineDiff` helper.
- `pwa/test/transcript-tools.test.tsx` — **new.**
- `pwa/test/transcript-thinking.test.tsx` — **new.**
- `pwa/test/diff.test.ts` — **new.**

## Technical Notes
Implements **plan tasks 1, 2, 3, 4, 5, 8, 9 and 11**. This story is the merge of what were originally stories 1 through 5 (issues #38, #39, #40 and #41, now closed into this one).

**Why these five merged.** They all edit the *same functions* in `daemon/src/lib/claude-adapter/tail.ts` — the union, the block walker, `assistantEvents` and `userEvents` — plus the same `pwa/src/lib/types.ts` mirror and the same `daemon/test/tail.test.ts`. The diff work then edits the very `ToolCall.tsx` and `transcript-tools.test.tsx` that the tool work creates. Shipped separately they would have produced four sequential conflicts on four shared files, each needing a rebase, for no rollout benefit. Merged, the whole widening lands atomically.

**Rollout assumption: none.** Purely additive to the event shape, and the daemon and PWA ship together in one pull request.

**Why AC16 is load bearing, not defensive.** The PWA is an installed progressive web app with a service worker, so a phone can be running a **cached older bundle** while the daemon on the laptop is already new. That version skew is one this repo genuinely produces. A stale app meeting a new event kind would hit `EventRow`'s switch with no matching branch, return `undefined`, and React would throw "Nothing was returned from render", blanking the entire transcript. Land the fallback before any new kind exists.

**Suggested internal order** — the plan's task numbering is the safe sequence: schema blocks, then the array-returning walker, then tool results, then thinking and the `error` removal, then full tool input, then the renderers, then diffs. Do not reorder the daemon work after the renderer work; the renderer consumes fields the normalizer does not yet send.

**An existing test asserts one of these bugs.** `daemon/test/tail.test.ts` has a case named `'an ordinary tool_result for a non-AskUserQuestion tool is unaffected (pre-existing behavior, untouched)'` whose comment marks the blank user bubble as out of scope for an earlier story. This story owns it. **Update it, do not delete it** — it becomes the assertion that the defect is fixed.

**Adapter quarantine and fences.** All normalizer work stays inside `daemon/src/lib/claude-adapter/`, sole owner of the transcript entry vocabulary, so FENCE 2 is unaffected. `pwa/src/lib/types.ts` stays a hand-maintained mirror because FENCE 1 forbids importing across.

**T7 and T11.** Tool input, tool results and thinking text are all arbitrary model output. Each renders as plain text inside `<pre>`, never as markdown and never as HTML, and nothing acts on their content. No `innerHTML`, no `dangerouslySetInnerHTML`.

**Size caps.** The existing 500-event cap bounds event *count*, not payload *size*. One read of a large file would otherwise balloon a single transcript response.

**No diff library is added.** A common-prefix and common-suffix trim suffices for the single contiguous change `Edit` and `Write` produce, and keeps the phone bundle flat. `noUncheckedIndexedAccess` applies to the split line arrays: use `?? ''`, not a non-null assertion.

**Deliberately out of scope:** assistant prose sharing a message with an `AskUserQuestion` (the detection keeps its single-event short-circuit, because the cross-line resolution pass depends on exactly one such event per line, and it is the most security-sensitive logic in the adapter); rendering a `MultiEdit` edit array as several separate diffs.

**This story is large by design**, at your request to consolidate. If it proves unwieldy in review, the natural cut is to lift the diff work (AC20 to AC24, plan task 11) back out — it is purely additive to `ToolCall.tsx` and touches no daemon code.

## Manual Test Checklist
- [ ] Start the daemon from `microviber/` per `INSTALL.md`, and open the PWA on the phone.
- [ ] Find an assistant turn that explains something *and* calls a tool. Confirm the explanation now appears above the tool line, where previously only the tool line showed.
- [ ] Find a turn with several tool calls in one message. Confirm every call is listed, not just the last.
- [ ] Confirm a multi-paragraph assistant answer keeps its paragraph breaks.
- [ ] Confirm the empty grey boxes that used to follow every tool call are gone, replaced by a readable one-line result preview.
- [ ] Tap a result and confirm it expands to full output, then collapses.
- [ ] Trigger a failing command on the laptop and confirm its result renders in the error tint.
- [ ] Run something with very long output, such as a full test run, and confirm the transcript stays responsive and shows a truncation marker.
- [ ] Confirm the empty bullet rows are gone, replaced by a `thinking…` marker that expands to the reasoning.
- [ ] Tap a `Bash` call and confirm the full command and description appear.
- [ ] Tap a `Read` call and confirm any offset and limit arguments are visible, which they never were before.
- [ ] Expand an `Edit` and confirm removed lines are red with a leading minus, added lines green with a leading plus, and context muted.
- [ ] Confirm a one-line change inside a large file shows a small hunk, not hundreds of context lines.
- [ ] Expand a `Write` and confirm the content renders as additions.
- [ ] Confirm a diff with a very long line scrolls inside its own box, and the page does not scroll sideways.
- [ ] Expand a `MultiEdit` and confirm the edit array is still visible in the key and value list.
- [ ] Open a session with a pending or recently answered `AskUserQuestion`. Confirm the card still renders, still resolves, and that no blank or stray row appeared beside it.
- [ ] Scroll a long transcript and confirm nothing renders blank or throws.
