---
id: microviber-track-b-7
title: Composer action-row alignment
status: in-progress
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/14
---

## User Story
As a **developer sending a prompt or hand-back action from the composer**, I want the primary action (Send, or Resend when a prompt failed) to always sit at the far right with any secondary action to its left, so that the composer's controls follow one consistent, predictable layout.

## Acceptance Criteria
1. In every composer state that shows action buttons, actions are right-aligned within their row.
2. The primary CTA — **Send** normally, **Resend** in the failed state — is the rightmost element.
3. **Hand back** (secondary), when shown, sits immediately to the left of the primary CTA, not in a separate row above it.
4. Any status label (e.g. a "failed" indicator) stays left-aligned within the same row, visually separated from the action group.

## Affected Files
- `pwa/src/components/Composer.tsx` — merges the previously-separate Hand-back row into the same row as Send, right-aligned.
- `pwa/test/composer-gate.test.tsx` — extended.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Task 16. Purely a visual/DOM-order change — no prop signature change, no new state.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Take over a session, confirm Hand back and Send appear in one row, Send rightmost.
- [ ] Trigger a failed send, confirm the failed indicator sits on the left and Resend is the rightmost action.
