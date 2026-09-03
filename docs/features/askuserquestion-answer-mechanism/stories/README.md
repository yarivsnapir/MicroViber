# askuserquestion-answer-mechanism — Story Index

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Daemon: answer a pending AskUserQuestion as plain text, resolved from the transcript | microviber | L | — | todo | [#31](https://github.com/yarivsnapir/MicroViber/issues/31) |
| 2 | PWA: answer a pending AskUserQuestion from the phone with selectable options and Send answers | microviber | M | askuserquestion-answer-mechanism-1 | todo | [#32](https://github.com/yarivsnapir/MicroViber/issues/32) |

## Dependency Graph
story-1 → story-2

## Rollout safety
- **Only story 1 shipped:** the daemon accepts `{ text }` exactly as before (the old PWA sends nothing else) and additionally resolves a pending question on any later human turn — a strict improvement; no consumer reads `resolvedBy` yet.
- **Stories 1 + 2 shipped:** full feature.
- Story 2 before story 1 is prevented by `depends_on` (it needs `{ answer }` on `POST /prompt`).
