---
id: askuserquestion-answer-mechanism-2
title: "PWA: answer a pending AskUserQuestion from the phone with selectable options and Send answers"
status: done
project: microviber
depends_on: [askuserquestion-answer-mechanism-1]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/32
---

## User Story
As a **developer who has taken over a session blocked on an `AskUserQuestion`**, I want to pick the options on my phone and send them with one tap, see honestly whether the answer landed, and see the question marked as answered afterwards, so that I can unblock the laptop session without walking back to it.

## Acceptance Criteria

**Card (plan Task 6):**
1. New `pwa/src/components/AskUserQuestionCard.tsx` renders every `askUserQuestion` event; `Transcript.tsx` delegates to it and takes `canAnswer: boolean`, `answerInFlight: AnswerInFlight | null`, `onAnswer?(toolUseId, selections)` instead of the old `onAnswerQuestion`.
2. Pending + `canAnswer` false (not taken over): options inert, no button — unchanged from story-8; the bottom bar's **Take over** remains the only action.
3. Pending + `canAnswer` true: options render as radio buttons (single-select) or checkboxes (`multiSelect: true`) — matching the VS Code chat UI's own `AskUserQuestion` rendering, not chip/pill buttons — each showing its label AND its `description` text; a **Send answers** button is disabled until every question has ≥ 1 pick and calls `onAnswer(toolUseId, selections)` with selections in question order; the line *or type a reply below* is shown. **Amended 2026-09-04** (see `spec.md` §7.1) — supersedes the original "chips with `aria-pressed`" design.
4. In flight (an `answerInFlight` whose `toolUseId` matches): selections lock showing what was sent, the button disappears, and the prompt state renders via `promptDisplay` (`Sending…`, `Waiting for the session to finish`, `Couldn't reach the session` + **Retry**, `Never picked up` + **Retry**); **Retry** re-submits the same selections. An in-flight answer for a different `toolUseId` does not lock this card.
5. Resolved with labels (`resolvedBy` either kind): dimmed, selected labels highlighted (amber), nothing interactive even when `canAnswer`. Resolved without labels: dimmed, no highlight, caption *no longer pending*, no hint line.
6. `pwa/src/lib/types.ts` mirrors the daemon: `askUserQuestion` gains `resolvedBy?`, options gain `multiSelect?`, `PromptRecord` drops `toolUseId` and gains `answerBody?`. `api.ts` gains `postAnswer(id, toolUseId, selections, idemKey)` posting `{ answer: { toolUseId, selections } }`; `sendPrompt` loses its `toolUseId` parameter.

**App wiring (plan Task 7):**
7. The in-flight prompt slot becomes a union with `kind: 'text' | 'answer'` (+ `toolUseId`, `selections` for answers); the status poll re-POSTs by kind (`sendPrompt` or `postAnswer`) under the same key; `status` is shown by the composer for text prompts and by the matching card for answers.
8. `sendAnswer(toolUseId, selections)` mints a fresh `crypto.randomUUID()` key on every call — Retry never replays a failed record's key.
9. `canAnswer` is `current.mode === 'owned' && current.writable`; the composer stays rendered and usable while a question is pending (free-text path).
10. Selecting another session or taking over clears the slot and its kind (no stale status leaks across sessions).

**Docs and pointers (plan Task 8):**
11. `docs/functional-spec.md` §3 gains dated `**Changed**` entries under **Transcript view** and **Composer gating on idle**; `story-8.md`'s AC15 note and the brief get their pointers.

## Affected Files
- `pwa/src/components/AskUserQuestionCard.tsx` — new.
- `pwa/src/components/Transcript.tsx` — delegate; new props.
- `pwa/src/lib/types.ts`, `pwa/src/lib/api.ts` — mirror + `postAnswer`.
- `pwa/src/App.tsx` — slot by kind, `sendAnswer`, poll, call sites.
- `pwa/test/ask-user-question-card.test.tsx`, `app-answer.test.tsx` — new; `transcript-askuserquestion.test.tsx`, `api.test.ts` — updated.
- `docs/functional-spec.md`, `docs/features/microviber-track-b/stories/story-8.md`, `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md`.

## Technical Notes
Full TDD steps with real code: `docs/features/askuserquestion-answer-mechanism/plan.md` Tasks 6–7 and the PWA/functional-spec parts of Task 8. Spec: `../spec.md` §7, §8, §10, §11.

**Rollout assumption:** assumes story `askuserquestion-answer-mechanism-1` has shipped — `POST /api/sessions/:id/prompt` accepts `{ answer }` and emits `resolvedBy`. Until the PWA is rebuilt, the old PWA keeps working against the new daemon (it only sends `{ text }`).

**Verbatim copy:** `Send answers`, `or type a reply below`, `no longer pending`. UI rule: minimalism — one new contextual control; `accepted` only when observed; nothing picked is lost on failure.

**Known, not fixed here:** `injected` is hardcoded `false` in `tail.ts`, so the answer turn renders like any laptop turn (pre-existing gap, spec §10). Right after takeover the model's "No response requested." reply to the resume handshake is visible above the answer — real transcript content, deliberately not hidden (spec §7.3).

**Deferred from story 1's code review (both are this story's own scope, not story 1's):**
- `pwa/src/lib/api.ts`'s `sendPrompt` still builds `{ text, ...(toolUseId ? { toolUseId } : {}) }` and threads a dead 4th `toolUseId` parameter through `App.tsx`. It's inert today (the daemon's `SendPromptBody` union is `.strict()` so a body carrying both `text` and `toolUseId` now 400s, but nothing currently calls `sendPrompt` with one — `Transcript.tsx`'s answer wiring is what this story adds). Delete the parameter as part of this story's `api.ts`/`App.tsx` rewrite rather than re-arming it against a shape the daemon no longer accepts.
- `tail.ts`'s `normalizeLine` renders an `isMeta: true` user turn (the "Continue from where you left off." handshake) as an ordinary `kind: 'user'` event, so it displays in the transcript as if the user typed it. Now that `isMeta` is modelled in the adapter, suppressing it is a one-line guard in the user branch — worth doing as part of this story's card work since it directly serves "never show a confusing state." Harmless today (`lifecycle.observe` matches on exact text, so the handshake string never accidentally marks an answer accepted).

## Manual Test Checklist
- [ ] `cd microviber && npm run typecheck && npm run lint && npm test` — all green (this is where Task 6's deferred PWA typecheck must pass).
- [ ] Real laptop session → `AskUserQuestion` → phone shows `awaiting-input` and the inert card → **Take over** → "No response requested." appears → card becomes interactive.
- [ ] Pick an option → **Send answers** → status waiting → clears; `Answering your question:` appears as a user turn; the model's next reply acts on it; card dims with the pick highlighted; session leaves `awaiting-input`.
- [ ] **Restart the daemon and reload the PWA** → card still resolved, state not `awaiting-input`.
- [ ] Fresh question → answer by typing free text in the composer → card dims with *no longer pending*; model acts on the text.
- [ ] Fresh question → take over on the phone → answer **on the laptop** → phone card resolves with the laptop's pick highlighted.
- [ ] Two-question call (one multi-select) → **Send answers** disabled until both have picks; composed message lists both lines; both highlighted afterwards.
- [ ] Kill the daemon mid-send to force `failed` → selections stay highlighted, **Retry** appears; restart daemon; Retry succeeds under a new key (check the audit log shows two distinct request ids).
