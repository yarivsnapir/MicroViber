# askuserquestion-answer-mechanism — Story Index

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Daemon: answer a pending AskUserQuestion as plain text, resolved from the transcript | microviber | L | — | done | [#31](https://github.com/yarivsnapir/MicroViber/issues/31) |
| 2 | PWA: answer a pending AskUserQuestion from the phone with selectable options and Send answers | microviber | M | askuserquestion-answer-mechanism-1 | done | [#32](https://github.com/yarivsnapir/MicroViber/issues/32) |
| 3 | Daemon+PWA: per-question selectedLabels so two questions sharing an option label don't cross-highlight | microviber | S | askuserquestion-answer-mechanism-2 | todo | [#36](https://github.com/yarivsnapir/MicroViber/issues/36) |

## Dependency Graph
story-1 → story-2 → story-3

## Rollout safety
- **Only story 1 shipped:** the daemon accepts `{ text }` exactly as before (the old PWA sends nothing else) and additionally resolves a pending question on any later human turn — a strict improvement; no consumer reads `resolvedBy` yet.
- **Stories 1 + 2 shipped:** full feature, with one documented known limitation (see story 3).
- **Story 3** fixes a pre-existing bug (cross-question option-label highlighting) found during story 2's own code review — not a new capability, a correctness fix. Depends on story 2 since it changes the `selectedLabels` shape story 2 introduced to the PWA.
- Story 2 before story 1 is prevented by `depends_on` (it needs `{ answer }` on `POST /prompt`).
