# microviber-track-c — Story Index

> **Scope:** these stories cover **Feature C (transcript parity)** only. Features A (terminal pane) and B (new-session button) from `spec.md` are a separate cluster and are not yet planned or carved.

> **Consolidated 2026-09-07.** Originally eight stories, merged down to four by shared-file analysis. Stories 2, 3, 4 and 5 all edited the same functions in `daemon/src/lib/claude-adapter/tail.ts`, the same `pwa/src/lib/types.ts` mirror and the same `daemon/test/tail.test.ts`, with the diff work then editing the very `ToolCall.tsx` the tool work creates — so they folded into story 1. Issues #38, #39, #40 and #41 are closed into [#37](https://github.com/yarivsnapir/MicroViber/issues/37).
>
> **Numbering is deliberately non-contiguous** (1, 6, 7, 8). Story IDs are never reused or renumbered once issues exist against them, so the survivors keep their original ids and issue numbers.

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Widen the transcript event stream and render every kind, including diffs | microviber | L | — | **done** | [#37](https://github.com/yarivsnapir/MicroViber/issues/37) |
| 6 | Style code blocks with syntax highlighting and render GFM tables | microviber | M | — | todo | [#42](https://github.com/yarivsnapir/MicroViber/issues/42) |
| 7 | Mark phone-sent prompts and stop collapsing newlines in user turns | microviber | S | story-1 | todo | [#43](https://github.com/yarivsnapir/MicroViber/issues/43) |
| 8 | Follow the transcript bottom while pinned, without yanking the view | microviber | S | — | todo | [#44](https://github.com/yarivsnapir/MicroViber/issues/44) |
| 9 | Bound the /transcript response by bytes, not only by event count | microviber | M | story-1 | todo | [#54](https://github.com/yarivsnapir/MicroViber/issues/54) |

## Dependency Graph

```
story-1 → story-7
story-1 → story-9

story-6 (independent)

story-8 (independent)
```

## Shared-file map

`pwa/src/components/Transcript.tsx` is touched by stories 1, 7 and 8. That is
unavoidable — it is the dispatcher — but the edits do not collide: stories 1
and 7 add distinct `case` arms to its switch, while story 8 replaces the
scroll effects in a different region of the file. Every other file in the
track is now owned by exactly one story.

## Closed into story 1

| Was | Title | Issue |
|---|---|---|
| 2 | Render tool results instead of empty grey boxes | [#38](https://github.com/yarivsnapir/MicroViber/issues/38) |
| 3 | Show the assistant's thinking text and remove the never-constructed error kind | [#39](https://github.com/yarivsnapir/MicroViber/issues/39) |
| 4 | Carry the full tool input and make tool calls expandable on tap | [#40](https://github.com/yarivsnapir/MicroViber/issues/40) |
| 5 | Render inline red and green diffs for file edits | [#41](https://github.com/yarivsnapir/MicroViber/issues/41) |
