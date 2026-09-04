---
id: microviber-track-b-9
title: "AskUserQuestion: awaiting-input state, takeover fix, notify-policy readiness"
status: superseded
project: microviber
depends_on: [microviber-track-b-8]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/16
---

> **Superseded (2026-09-02):** this story's scope was merged into
> [story-8](story-8.md) (GitHub issue [#15](https://github.com/yarivsnapir/MicroViber/issues/15)),
> which now covers the combined spike + detection + state-fix + PWA-UI work
> as a single story/PR. Issue #16 was closed as part of that merge. The
> content below is kept for historical reference only — do not implement it
> separately.

## User Story
As a **developer whose laptop session is blocked on an `AskUserQuestion`**, I want to be able to take that session over from my phone, so that I'm not stuck unable to respond until the tool call's turn eventually times out — up to an hour later, per the existing `OPEN_TURN_MAX_MS` window.

## Acceptance Criteria
1. **This is a real bug fix, not just new UI.** Today, `deriveState` treats any open turn (`turnOpen: true`, which an `AskUserQuestion` tool call produces since the assistant entry stops with `stop_reason: 'tool_use'`, not `'end_turn'`) as `working` for up to `OPEN_TURN_MAX_MS` (60 minutes) — and takeover is gated on `state === 'idle'`. Net effect before this story: **a session blocked on `AskUserQuestion` cannot be taken over at all** for up to an hour. Verify this bug reproduces against the actual pre-fix code before claiming it's fixed.
2. `SessionState` gains a fourth value, `'awaiting-input'`.
3. `deriveState` gains a `hasPendingQuestion: boolean` input; when true, the result is `'awaiting-input'` **unconditionally** — this is a structural override, checked immediately after the `!alive` check and before every timing-based rule (including `notify_idle` and the 20s/60min growth windows), not another heuristic layered alongside them.
4. `assertIdleForTakeover` accepts `'awaiting-input'` alongside `'idle'` — this is the actual fix that unblocks takeover.
5. `NotifyPolicy`'s own independent `State` type (not imported from `session-state.ts`) gains `'awaiting-input'` as a second value that counts as "waiting for you," alongside `'idle'`, for both the notify-on-transition and dismiss-on-leaving logic — verified to not double-notify a session moving directly between `idle` and `awaiting-input`.

## Affected Files
- `daemon/src/domain/session-state.ts` — `SessionState`, `deriveState`.
- `daemon/src/domain/ownership.ts` — `assertIdleForTakeover`.
- `daemon/src/domain/registry.ts` — threads `pendingQuestion`/`hasPendingQuestion` from story microviber-track-b-8's detection into `buildSummary`.
- `daemon/src/lib/claude-adapter/discovery.ts` — passes `pendingQuestion` through from `scanTranscriptMeta`'s output.
- `daemon/src/domain/notify-policy.ts` — `State` type extension, `isWaitingForYou` helper.
- `daemon/test/session-state.test.ts`, `daemon/test/ownership.test.ts`, `daemon/test/registry.test.ts`, `daemon/test/notify-policy.test.ts` — extended.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 19 and 20. Depends on story microviber-track-b-8 for the `pendingQuestion` field this story's `hasPendingQuestion` input is derived from.

**Explicit scope boundary, carried from the plan's Global Constraints — do not expand this story to cover it:** `NotifyPolicy` has zero call sites anywhere in the shipped app today (confirmed via workspace-wide grep — only its own unit test consumes it), and the daemon has **no push-dispatch mechanism of any kind** despite `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` existing in `config.ts`. This story makes `NotifyPolicy`'s logic correct and ready; it does **not** wire it into `app.ts`/`services.ts`, and does **not** build a `web-push`-based sender. That's a separate, larger pre-existing gap — file it as its own follow-up story rather than absorbing it here.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] **Before implementing**, reproduce the bug on the current `main`: get a real session to call `AskUserQuestion`, confirm the daemon reports it as `working` and that `POST /api/sessions/:id/takeover` 403s.
- [ ] **After implementing**, repeat the same real-session test: confirm the session now reports `awaiting-input` and takeover succeeds.
- [ ] Confirm a session with a genuinely open non-question tool call (e.g. mid-`Bash`) still correctly reports `working`, not `awaiting-input` — this story must not regress the existing open-turn heuristic for ordinary tool use.
