# Daemon: answer a pending AskUserQuestion as plain text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Story:** `askuserquestion-answer-mechanism-1` — `docs/features/askuserquestion-answer-mechanism/stories/story-1.md` (issue [#31](https://github.com/yarivsnapir/MicroViber/issues/31))

**Goal:** The daemon accepts a phone answer to a pending `AskUserQuestion`, sends it as a plain user turn Claude actually acts on, and recognises the question as resolved purely by re-reading the transcript — no daemon-side answer state, so a restart never leaves a session stuck `awaiting-input`.

**Architecture:** A new adapter module `daemon/src/lib/claude-adapter/ask-user-question.ts` owns detection of the `AskUserQuestion` tool_use, the two-clause resolution rule (a matching `tool_result`, or any later human turn — text present, `isMeta !== true`, no `origin`), and the fixed answer-text format with its parser. `tail.ts` and `transcript-meta.ts` both call it instead of duplicating the rule. `services.sendPrompt` accepts a discriminated body (`{text}` | `{answer}`), replays same-key requests on the canonical answer body before touching the transcript, re-derives the pending question and validates a new answer against it, composes the text, and pushes it through the unchanged `PromptLifecycle.submit()` → `send()` → `userFrame()` path. The story-8 `tool_result` write plumbing (F16) is deleted entirely.

**Tech Stack:** Node 22 + TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Fastify, zod, vitest.

**This is a scoped extraction, not a rewrite.** This story's tasks are Tasks 1–5, plus Task 8 Step 1 (the `docs/architecture-spec.md` updates only — Task 8 Steps 2–3 are `functional-spec.md` and cross-doc pointers, which belong to story 2), of the already-written and reviewed feature plan at `docs/features/askuserquestion-answer-mechanism/plan.md`. That file has the full code for every step (failing test → run → implementation → run → commit) and has already passed its own self-review (spec coverage, placeholder scan, type consistency — see its "Self-Review" section at the end). **Read those tasks verbatim from `plan.md` and follow them exactly; nothing here supersedes them.** This file exists only to scope the story-development skill's per-task review loop to the right slice and to state the story-1-only global constraints and file list.

## Global Constraints

(Copied from `plan.md`'s Global Constraints — apply to every task below.)

- **Testing gate** (architecture-spec §6): `cd microviber && npm run typecheck && npm run lint && npm test` must be green before every commit. Per-workspace shortcut while iterating: `cd microviber/daemon && npx vitest run test/<file>.test.ts`.
- **Adapter quarantine** (§6, lint FENCE 2): only `daemon/src/lib/claude-adapter/**` may model transcript vocabulary (`isMeta`, `origin`, `tool_result`, the answer text format). `domain/`, `services/`, `api/` consume only the adapter's exported types/functions.
- **Layering fence:** `schemas/ → domain/ → services/ → api/`, no upward imports.
- **zod at every boundary; no `any`** (`@typescript-eslint/no-explicit-any` is an error). No non-null assertions (`!`) — use narrowing or `?? default`.
- **Threat model:** no change to T1–T12 mitigations; `session-manager.ts`'s `startTakeoverSession` argv is untouched. Task 5 adds a T11 narrowing note only (in Task 8's architecture-spec update). No new endpoint, header, cookie, or env var.
- **Fail closed:** any malformed or stale answer is rejected (400) before any write; rejected attempts are still audited.
- **Copy (verbatim):** answer heading `Answering your question:` (one question) / `Answering your questions:` (several); per-question line `- <header>: <label>, <label>`.
- **Commit style:** conventional, scoped, e.g. `feat(claude-adapter): …`, `refactor(daemon): …`, `docs(architecture-spec): …`; every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Branch:** `story/askuserquestion-answer-mechanism-1` (cut from `feature/askuserquestion-answer-mechanism`, which is cut from `story/microviber-track-b-8`).

## File Structure (this story's slice)

| File | Action | Task |
|---|---|---|
| `docs/architecture-spec.md` | Modify | Task 1 (F18 row); Task 8 Step 1 (F17 pointer, §3 list, §4 `/prompt` row, §5 T11 note) |
| `daemon/src/lib/claude-adapter/ask-user-question.ts` | Create | Task 2 |
| `daemon/src/lib/claude-adapter/schemas.ts` | Modify | Task 2 |
| `daemon/src/lib/claude-adapter/tail.ts` | Modify | Task 3 |
| `daemon/src/lib/claude-adapter/transcript-meta.ts` | Modify | Task 3 |
| `daemon/src/lib/claude-adapter/prompt-sender.ts` | Modify | Task 4 |
| `daemon/src/lib/claude-adapter/session-manager.ts` | Modify | Task 4 |
| `daemon/src/domain/prompt-lifecycle.ts` | Modify | Task 4 |
| `daemon/src/domain/answer.ts` | Create | Task 5 |
| `daemon/src/schemas/api.ts` | Modify | Task 5 |
| `daemon/src/services/services.ts` | Modify | Task 4 (minimal), Task 5 (full) |
| `daemon/src/api/app.ts` | Modify | Task 5 |
| `daemon/test/ask-user-question.test.ts` | Create | Task 2 |
| `daemon/test/answer.test.ts` | Create | Task 5 |
| `daemon/test/{schemas,tail,transcript-meta,prompt-lifecycle,session-manager,services,app}.test.ts` | Modify | Tasks 2–5 |

**Not in this story's scope** (story 2, PWA): `pwa/src/lib/types.ts`, `pwa/src/lib/api.ts`, `pwa/src/components/AskUserQuestionCard.tsx`, `pwa/src/components/Transcript.tsx`, `pwa/src/App.tsx`, `pwa/test/*`, `docs/functional-spec.md`, `docs/features/microviber-track-b/stories/story-8.md`, `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md`.

## Tasks

- [ ] **Task 1 — Gating spike, F18 addendum.** Follow `plan.md` lines 56–105 exactly (`### Task 1: Gating spike — F18 addendum`). This is a real human-input step: ask the user to run the one-liner and paste the output before writing anything else. Do not skip ahead — every later task assumes this row exists.

- [ ] **Task 2 — Adapter helper `ask-user-question.ts` + `isMeta` in the schema.** Follow `plan.md` lines 108–405 (`### Task 2`) exactly — full test file, schema edit, and helper implementation are given verbatim there.

- [ ] **Task 3 — `tail.ts` and `transcript-meta.ts` consume the helper.** Follow `plan.md` lines 409–667 (`### Task 3`) exactly.

- [ ] **Task 4 — Remove the `tool_result` write plumbing; `PromptLifecycle` gains `answerBody` + `findReplay()`.** Follow `plan.md` lines 672–856 (`### Task 4`) exactly. Note Step 5 of this task makes a minimal, temporary edit to `services.ts` — Task 5 below replaces it fully.

- [ ] **Task 5 — API body union, answer validation, composition, audit (daemon end-to-end).** Follow `plan.md` lines 861–1206 (`### Task 5`) exactly.

- [ ] **Task 6 (= feature plan's Task 8, Step 1 only) — `docs/architecture-spec.md` updates.** Follow `plan.md` lines 1725–1744 only (the "Step 1: architecture-spec.md" subsection under `### Task 8`): the F17 pointer, the §3 `ask-user-question.ts` module-list entry, the §4 `/prompt` API-table row, and the §5 T11 narrowing note. **Do not do Task 8 Steps 2–3** (`functional-spec.md`, `story-8.md`/brief pointers) here — those are story 2's, since they describe PWA-visible behaviour this story does not yet expose. Commit this doc update on its own:
  ```bash
  git add docs/architecture-spec.md
  git commit -m "docs(architecture-spec): F17 forward pointer, ask-user-question.ts module entry, /prompt body union, T11 narrowing note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  ```

- [ ] **Task 7 — Backend-only verification scripts (story AC, "Backend-only story" note).** Write and run two scripts (place under `docs/features/askuserquestion-answer-mechanism/stories/story-1-manual-test.ts`, using `tsx`, reusing the daemon's existing bearer-token/idempotency-key conventions from `daemon/README.md` or `INSTALL.md`):
  1. Against a running daemon with a taken-over session that has a real pending question: `POST /api/sessions/:id/prompt` with `{ answer }`, then poll the same `Idempotency-Key` until the `PromptStatus` reaches `accepted`, printing each intermediate status.
  2. `POST` the same endpoint with a stale/unknown `toolUseId`, print the 400 body, and confirm (via the daemon's audit log) a `rejected` line was written and a retry under the same key is still 400 (proving no record was persisted).

  This script is what Step 10b of `syncounter-story-development` runs for real before the manual-test checkpoint — it is not optional scaffolding.

## Self-Review (scoped to story 1)

**Coverage against story-1.md's 13 acceptance criteria:** AC1 → Task 1. AC2 → Task 2. AC3 → Task 2 (`isResolvingUserEntry`) + Task 3 (wiring). AC4 → Task 3. AC5 → Task 3. AC6 → Task 4. AC7 → Task 4. AC8 → Task 5 (schema). AC9 → Task 5 (`services.sendPrompt` order). AC10 → Task 5 (regression test). AC11 → Task 5 (audit). AC12 → Task 5 (compose + `accepted` semantics, unchanged `submit()`). AC13 → Task 6. The "backend-only verification script" requirement → Task 7.

**Placeholder scan:** `<DATE>` and the F18 addendum's `<PASS or FAIL …>` in Task 1 are filled from the real evidence the user pastes — not a plan placeholder, a data placeholder the task itself explains how to fill.

**Type consistency:** verified in `plan.md`'s own self-review (matches `detectAskUserQuestion`/`isResolvingUserEntry`/`composeAnswerText`/`parseAnswerText`/`ANSWER_TEXT_MAX_CHARS` across Tasks 2/3/5; `findReplay`/`submit({answerBody})` across Tasks 4/5; `AnswerBody`/`SendPromptBody`/`AppDeps.sendPrompt({body})` across Task 5's schema/services/app/tests). Story-1-plan.md introduces no new symbols, so nothing here can drift from that review.
