# microviber-track-c — Story Index

> **Scope:** these stories cover **Feature C (transcript parity)**, **Feature A (terminal pane)**, and **Feature B (new-session button)** from `spec.md`. Stories 10, 14, 15 and 19 add Features A and B; stories 1 and 6–9 cover Feature C.

> **Consolidated 2026-09-07.** Originally eight stories, merged down to four by shared-file analysis. Stories 2, 3, 4 and 5 all edited the same functions in `daemon/src/lib/claude-adapter/tail.ts`, the same `pwa/src/lib/types.ts` mirror and the same `daemon/test/tail.test.ts`, with the diff work then editing the very `ToolCall.tsx` the tool work creates — so they folded into story 1. Issues #38, #39, #40 and #41 are closed into [#37](https://github.com/yarivsnapir/MicroViber/issues/37).
>
> **Numbering is deliberately non-contiguous** (1, 6–10, 14, 15, 19). Story IDs are never reused or renumbered once issues exist against them, so the survivors keep their original ids and issue numbers.
>
> **Consolidated again 2026-09-09.** Features A and B were first carved as eleven stories (10–20) and merged down to four the same day, by the same shared-file criterion used in 2026-09-07. Stories 11, 12 and 13 folded into **10** (12's `listKnownFolders()` existed only to be the gate 13 calls, and 13 existed only to wire up 11's registry — apart, each is a component with no caller). Stories 16, 17 and 18 folded into **15** (all four edit `TerminalPane.tsx`; the dropdown, key row and reattach are not features layered on the pane, they are the pane). Story 20 folded into **19** (backend endpoint and its UI are one user-facing action). Story **14** stayed separate on purpose — see its own "Deliberately NOT consolidated" section: it is a new authenticated network surface with a five-step upgrade gate, and it shares only *regions* of `app.ts` with story 10, not functions.

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Widen the transcript event stream and render every kind, including diffs | microviber | L | — | **done** | [#37](https://github.com/yarivsnapir/MicroViber/issues/37) |
| 6 | Style code blocks with syntax highlighting and render GFM tables | microviber | M | — | todo | [#42](https://github.com/yarivsnapir/MicroViber/issues/42) |
| 7 | Mark phone-sent prompts and stop collapsing newlines in user turns | microviber | S | story-1 | todo | [#43](https://github.com/yarivsnapir/MicroViber/issues/43) |
| 8 | Follow the transcript bottom while pinned, without yanking the view | microviber | S | — | todo | [#44](https://github.com/yarivsnapir/MicroViber/issues/44) |
| 9 | Bound the /transcript response by bytes, not only by event count | microviber | M | story-1 | todo | [#54](https://github.com/yarivsnapir/MicroViber/issues/54) |
| 10 | Terminal foundation — the fence rule, a PTY registry, and the routes to drive it | microviber | L | — | todo | [#56](https://github.com/yarivsnapir/MicroViber/issues/56) |
| 14 | The control-plane WebSocket lands, with its upgrade gate and frame protocol | microviber | M | story-10 | todo | [#60](https://github.com/yarivsnapir/MicroViber/issues/60) |
| 15 | The terminal on the phone — pane, dropdown, key row, reattach | microviber | L | story-14 | todo | [#61](https://github.com/yarivsnapir/MicroViber/issues/61) |
| 19 | New Claude session from the phone — create it in a PTY, then jump to it | microviber | M | story-15 | todo | [#65](https://github.com/yarivsnapir/MicroViber/issues/65) |

## Dependency Graph

```
Feature C (transcript parity)
  story-1 (done) → story-7
  story-1 (done) → story-9
  story-6, story-8  (independent)

Features A + B (terminal pane, new session) — one straight chain
  story-10 → story-14 → story-15 → story-19
```

Feature A and B are deliberately a single chain rather than a fan-out: each
story needs the one before it to exist at all, and the daemon and PWA ship
together in one PR, so there is nothing to gain from parallel branches.

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

## Closed into story 10, 15 and 19 (2026-09-09)

| Was | Title | Issue | Into |
|---|---|---|---|
| 11 | A PTY session and registry in lib/terminal, with a bounded ring buffer | [#57](https://github.com/yarivsnapir/MicroViber/issues/57) | [#56](https://github.com/yarivsnapir/MicroViber/issues/56) |
| 12 | One known-folder set that both the spawn gate and the pickers use | [#58](https://github.com/yarivsnapir/MicroViber/issues/58) | [#56](https://github.com/yarivsnapir/MicroViber/issues/56) |
| 13 | Terminal REST routes — create, list, kill | [#59](https://github.com/yarivsnapir/MicroViber/issues/59) | [#56](https://github.com/yarivsnapir/MicroViber/issues/56) |
| 16 | Terminal dropdown — open terminals, and a new one in a known folder | [#62](https://github.com/yarivsnapir/MicroViber/issues/62) | [#61](https://github.com/yarivsnapir/MicroViber/issues/61) |
| 17 | Accessory key row — Esc, Tab, sticky Ctrl, arrows, Ctrl-C | [#63](https://github.com/yarivsnapir/MicroViber/issues/63) | [#61](https://github.com/yarivsnapir/MicroViber/issues/61) |
| 18 | Reopening the Terminal pane returns to the terminal you were in | [#64](https://github.com/yarivsnapir/MicroViber/issues/64) | [#61](https://github.com/yarivsnapir/MicroViber/issues/61) |
| 20 | New session from the picker — watch Claude boot, then jump to it | [#66](https://github.com/yarivsnapir/MicroViber/issues/66) | [#65](https://github.com/yarivsnapir/MicroViber/issues/65) |
