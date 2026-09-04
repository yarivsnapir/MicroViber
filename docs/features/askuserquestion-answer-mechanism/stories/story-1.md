---
id: askuserquestion-answer-mechanism-1
title: "Daemon: answer a pending AskUserQuestion as plain text, resolved from the transcript"
status: done
project: microviber
depends_on: []
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/31
---

## User Story
As a **developer whose laptop session is blocked on an `AskUserQuestion`**, I want the daemon to accept an answer from my phone and send it in a form Claude actually acts on, and to recognise on its own — from the transcript alone — that the question has been answered, so that the session continues normally and never shows a stale "awaiting input" state, even after a daemon restart.

## Acceptance Criteria

**Gating spike (first — plan Task 1):**
1. Row **F18** is added to `docs/architecture-spec.md` §2 recording (a) the resume handshake is conditional on a dangling `tool_use` (no handshake on a clean resume), (b) `AskUserQuestion` is hard-disabled in `-p` mode, (c) a killed headless CLI writes its own `tool_result`, and (d) the **addendum**: on real transcripts a laptop-typed user turn and a phone-injected user turn both have `isMeta !== true` and no `origin` field. The grep is run by the user (transcripts live outside the repo); the implementer records the pasted evidence. If (d) fails, criterion 3's `origin` exclusion is narrowed to an explicit denylist of the observed kinds and the row says so.

**Adapter (plan Tasks 2–3):**
2. New module `daemon/src/lib/claude-adapter/ask-user-question.ts` exports `detectAskUserQuestion`, `isResolvingUserEntry`, `composeAnswerText`, `parseAnswerText`, `ANSWER_TEXT_MAX_CHARS` (= 4000); `schemas.ts` adds `isMeta: z.boolean().optional()` to the `user` line and exports `UserTranscriptLine`.
3. A pending question is resolved by the first later user entry that either (a) carries a `tool_result` with its `tool_use_id`, or (b) is a human turn: has text (string content or a `text` block), `isMeta !== true`, and `origin.kind` (if present) is not in the known-synthetic denylist. **Amended (F18 addendum, 2026-09-04):** the spike FAILed the original "no `origin` field" hypothesis — a real human turn carries `origin: {kind: "human"}` — so the rule uses an explicit denylist (`task-notification`, `auto-continuation`) instead; see `spec.md` §4.1. The `isMeta: true` handshake turn and denylisted-`origin.kind` entries never resolve a question. The interruption marker does.
4. Both `tail.ts` and `transcript-meta.ts` use the shared module; their `SYNC:` comments are deleted; a shared-fixture test asserts `pendingQuestion === null` exactly when `tail.ts` reports `resolved`.
5. `TranscriptEvent`'s `askUserQuestion` variant gains `resolvedBy?: 'tool_result' | 'text'`. A text-resolved question keeps the resolving user turn in the event stream; a tool_result resolution still drops its blank bubble. `selectedLabels` for a text resolution are parsed from the composed format (`undefined` for free text); for a tool_result they are `undefined` when content is non-string, empty, or starts with `<tool_use_error>` — never an empty array.

**Removal (plan Task 4):**
6. `toolResultFrame`, `PromptSender.sendAnswer`, `OwnedSessionHandle.sendAnswer`, `PromptLifecycle.submitAnswer/observeAnswer`, `PromptRecord.toolUseId`, `SendPromptBody.toolUseId`, and the `toolUseId` parameter of `AppDeps.sendPrompt` are deleted, with their tests. `startTakeoverSession`'s argv is unchanged.
7. `PromptRecord` gains `answerBody?: string`; `PromptLifecycle.findReplay({ key, sessionId, text?, answerBody? })` returns the existing record for the same request and throws `INVALID_INPUT` on a different body or a text/answer kind mismatch; `submit()` accepts `answerBody` and stores it atomically with the record.

**API + services (plan Task 5):**
8. `POST /api/sessions/:id/prompt` body is exactly one of `{ text }` or `{ answer: { toolUseId, selections: string[][] } }` (both `.strict()`); anything else is 400 `INVALID_INPUT`. `Idempotency-Key` stays required.
9. Answer order in `services.sendPrompt`: ownership check (403, audited, no record) → same-key replay via `findReplay` on the canonical body (`JSON.stringify({ toolUseId, selections })`) **before any transcript access** → only for a new key: re-derive `pendingQuestion` from the live transcript, validate (`domain/answer.ts`: `question is no longer pending` / `answer must cover every question` / `question <header> accepts one option` / `unknown option for <header>`), compose, `submit({ text, answerBody })`.
10. Regression test: a same-key replay **after the answer turn has landed** (pending question gone) returns the original record instead of 400.
11. Every rejection is audited with `outcome: 'rejected'` and the canonical body as the hashed prompt; an accepted answer is audited with the composed text. No `PromptRecord` is persisted for a rejected answer.
12. The composed text is `Answering your question:` (one) / `Answering your questions:` (several) followed by one `- <header>: <label>, <label>` line per question, sent through the unchanged `submit()` → `send()` → `userFrame()` path, and becomes `accepted` only when `getTranscript` observes that exact text as a user turn.

**Docs (plan Task 8, daemon-side parts):**
13. `docs/architecture-spec.md`: F17 row gets the forward pointer; §3's adapter list gains `ask-user-question.ts`; §4's `/prompt` row describes the body union and validation messages; T11 gets the narrowing note.

## Affected Files
- `daemon/src/lib/claude-adapter/ask-user-question.ts` — new shared module (detection, rule, compose/parse).
- `daemon/src/lib/claude-adapter/schemas.ts` — `isMeta`, `UserTranscriptLine`.
- `daemon/src/lib/claude-adapter/tail.ts`, `transcript-meta.ts` — consume the helper; rule (b); `resolvedBy`.
- `daemon/src/lib/claude-adapter/prompt-sender.ts`, `session-manager.ts` — delete the tool_result write path.
- `daemon/src/domain/prompt-lifecycle.ts` — `answerBody`, `findReplay`, delete answer methods.
- `daemon/src/domain/answer.ts` — new: `canonicalAnswerBody`, `validateAnswer`.
- `daemon/src/schemas/api.ts` — `AnswerBody`, `SendPromptBody` union.
- `daemon/src/services/services.ts` — answer path, audit.
- `daemon/src/api/app.ts` — `AppDeps.sendPrompt({ body })`, route pass-through.
- `daemon/test/ask-user-question.test.ts`, `answer.test.ts` — new; `tail`, `transcript-meta`, `prompt-lifecycle`, `services`, `app`, `session-manager`, `schemas` tests — updated.
- `docs/architecture-spec.md` — F18 row + addendum, F17 pointer, §3/§4/T11.

## Technical Notes
Full TDD steps with real code: `docs/features/askuserquestion-answer-mechanism/plan.md` Tasks 1–5 and the daemon parts of Task 8. Spec: `../spec.md` §2, §4, §5, §6, §9.

**Rollout assumption:** none — purely additive on the wire. The shipped PWA only ever sends `{ text }`, which the new `.strict()` union accepts, and never reads `PromptRecord.toolUseId` (the field was never populated for real traffic because options were inert). With only this story shipped, the app behaves exactly as today except that a question resolves on any later human turn — which is the desired fix on its own.

**Threat model:** no change to T1–T12 mitigations; no new endpoint/header/cookie/env; the takeover argv in `session-manager.ts` is untouched. T11 narrowing note only (labels validated against the pending question's own options; explicit tap; fixed format; length cap).

**Backend-only story — verification script required (spec-to-stories rule 4):** besides the unit/integration tests, prepare a script that, against a running daemon with a taken-over session that has a pending question, POSTs `{ answer }` and then polls the same key until `accepted`, printing each `PromptStatus`; and one that POSTs a stale `toolUseId` and shows the 400 + audit line. Story 2 does the on-device end-to-end check.

**Spike policy note:** the implementer must not read `~/.claude/projects/*` itself (outside the workspace); Task 1 hands the user a one-liner and records what they paste.

## Manual Test Checklist
- [ ] Task 1 spike recorded as F18 (+ addendum with pasted evidence) before any other code.
- [ ] `cd microviber && npm run typecheck && npm run lint && npm test` — all green.
- [ ] Verification script: with a real pending question in a taken-over session, `POST {answer}` → `queued` → `accepted` once the composed text lands; the laptop's transcript shows `Answering your question:` as a plain user turn and the model's next reply acts on it.
- [ ] Verification script: `POST {answer}` with a stale/unknown `toolUseId` → 400 `question is no longer pending`; the audit log gained a `rejected` line; a retry with the same key is re-evaluated (still 400), proving no record was persisted.
- [ ] Same-key replay of a successful answer after the question resolved → 200 with the original record (criterion 10) — check via the script's polling loop.
- [ ] `GET /api/sessions` shows the session leaving `awaiting-input` after the answer lands; restart the daemon and confirm it does not come back as `awaiting-input`.
- [ ] Confirm the `tool_result` frame is gone: `grep -rn "tool_result" daemon/src/lib/claude-adapter/prompt-sender.ts daemon/src/lib/claude-adapter/session-manager.ts` returns nothing.
