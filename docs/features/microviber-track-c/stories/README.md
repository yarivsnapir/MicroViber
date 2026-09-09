# microviber-track-c — Story Index

> **Scope:** these stories cover **Feature C (transcript parity)**, **Feature A (terminal pane)**, and **Feature B (new-session button)** from `spec.md`. Stories 10–20 add Features A and B; stories 1, 6–9 cover Feature C.

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
| 10 | Reconcile the architecture spec with CLAUDE.md's existing no-spawn-outside-the-adapter rule | microviber | S | — | todo | [#56](https://github.com/yarivsnapir/MicroViber/issues/56) |
| 11 | A PTY session and registry in lib/terminal, with a bounded ring buffer | microviber | M | story-10 | todo | [#57](https://github.com/yarivsnapir/MicroViber/issues/57) |
| 12 | One known-folder set that both the spawn gate and the pickers use | microviber | S | — | todo | [#58](https://github.com/yarivsnapir/MicroViber/issues/58) |
| 13 | Terminal REST routes — create, list, kill | microviber | M | story-11, story-12 | todo | [#59](https://github.com/yarivsnapir/MicroViber/issues/59) |
| 14 | The control-plane WebSocket lands, with its upgrade gate and frame protocol | microviber | M | story-13 | todo | [#60](https://github.com/yarivsnapir/MicroViber/issues/60) |
| 15 | A working terminal on the phone — third pane tab and xterm.js | microviber | L | story-14 | todo | [#61](https://github.com/yarivsnapir/MicroViber/issues/61) |
| 16 | Terminal dropdown — open terminals, and a new one in a known folder | microviber | M | story-15, story-12 | todo | [#62](https://github.com/yarivsnapir/MicroViber/issues/62) |
| 17 | Accessory key row — Esc, Tab, sticky Ctrl, arrows, Ctrl-C | microviber | M | story-15 | todo | [#63](https://github.com/yarivsnapir/MicroViber/issues/63) |
| 18 | Reopening the Terminal pane returns to the terminal you were in | microviber | S | story-16 | todo | [#64](https://github.com/yarivsnapir/MicroViber/issues/64) |
| 19 | Start a real Claude session in a PTY, and correlate it back to its session id | microviber | M | story-10, story-13 | todo | [#65](https://github.com/yarivsnapir/MicroViber/issues/65) |
| 20 | New session from the picker — watch Claude boot, then jump to it | microviber | M | story-19, story-16 | todo | [#66](https://github.com/yarivsnapir/MicroViber/issues/66) |

## Dependency Graph

```
Feature C (transcript parity)
  story-1 (done) → story-7
  story-1 (done) → story-9
  story-6, story-8 (independent)

Feature A (terminal pane)
  story-10 → story-11 → story-13 → story-14 → story-15 → story-16 → story-18
                        story-12 ↗           ↘ story-17
             story-12 → story-13

Feature B (new Claude session)
  story-10 → story-19 → story-20
  story-13 → story-19
  story-16 → story-20
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
