# askuserquestion-answer-mechanism — Story Index

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Daemon: answer a pending AskUserQuestion as plain text, resolved from the transcript | microviber | L | — | done | [#31](https://github.com/yarivsnapir/MicroViber/issues/31) |
| 2 | PWA: answer a pending AskUserQuestion from the phone with selectable options and Send answers | microviber | M | askuserquestion-answer-mechanism-1 | done | [#32](https://github.com/yarivsnapir/MicroViber/issues/32) |
| 3 | Daemon+PWA: per-question selectedLabels so two questions sharing an option label don't cross-highlight | microviber | S | askuserquestion-answer-mechanism-2 | done | [#36](https://github.com/yarivsnapir/MicroViber/issues/36) |

## Dependency Graph
story-1 → story-2 → story-3

## Rollout safety
- **Only story 1 shipped:** the daemon accepts `{ text }` exactly as before (the old PWA sends nothing else) and additionally resolves a pending question on any later human turn — a strict improvement; no consumer reads `resolvedBy` yet.
- **Stories 1 + 2 shipped:** full feature, with one documented known limitation (see story 3).
- **Story 3** fixes a pre-existing bug (cross-question option-label highlighting) found during story 2's own code review — not a new capability, a correctness fix. Depends on story 2 since it changes the `selectedLabels` shape story 2 introduced to the PWA. **Grew during implementation (2026-09-08):** its AC2 empirical check disproved its own premise — the laptop's answer stub *is* per-question, and the daemon had been matching the wrong format (9 of 308 single-question stubs, 0 of 50 multi-question). AC7 was added with the user's approval to parse the real format, which also closed a critical DoS the new parser introduced.
- Story 2 before story 1 is prevented by `depends_on` (it needs `{ answer }` on `POST /prompt`).
