---
id: microviber-track-c-20
title: New session from the picker — watch Claude boot, then jump to it
status: todo
project: microviber
depends_on: [microviber-track-c-19, microviber-track-c-16]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/66
---

## User Story
As a **developer away from my laptop**, I want **to start a new Claude session from the session picker and land in it once it is ready**, so that **starting new work from my phone is one flow rather than two disconnected ones**.

## Acceptance Criteria
1. The Claude pane's session picker gains a **New session** row.
2. Tapping it shows the **same known-folder list** Feature A uses — the same `GET /api/folders` data and the same in-place two-level swap, not a parallel picker.
3. Picking a folder calls `POST /api/sessions/new` with `{ cwd }`.
4. The PWA then **switches to the Terminal pane**, so the user watches Claude boot rather than staring at a spinner.
5. The PWA polls `GET /api/terminals` **on its existing session-poll cadence** until that terminal's `claudeSessionId` resolves from `null`. **No new polling loop is introduced** — reuse the loop that is already running.
6. Once resolved, the terminal header offers a **one-tap jump** to the Claude pane, focused on the new session.
7. If the id never resolves, the header **simply never offers the jump**. No error toast, no retry prompt — the user sees why in the terminal itself (Claude's own output), which is more informative than anything the PWA could synthesise.
8. Hitting the session cap surfaces the `403` as a readable message.
9. The jump focuses the *new* session specifically, not merely the Claude pane's last selection.
10. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/SessionPicker.tsx` — the **New session** row and the folder view.
- `pwa/src/components/TerminalPane.tsx` — the conditional jump affordance in the header.
- `pwa/src/App.tsx` — the pane switch on create, the session focus on jump, and threading `claudeSessionId` off the existing poll.
- `pwa/src/lib/api.ts` — `createSession`.
- `pwa/test/session-picker.test.tsx` — extend: the new row, the folder view.
- `pwa/test/terminal-pane.test.tsx` — extend: jump appears on resolve, stays absent when it never resolves.

## Technical Notes
**Reuse the existing poll — this is an acceptance criterion, not an optimisation.** `App.tsx` already polls sessions on a cadence, and `GET /api/terminals` is cheap. Adding a second loop for this one transition would be the third polling loop in the app, and issue [#48](https://github.com/yarivsnapir/MicroViber/issues/48) already tracks the notify loop and the PWA poll each running their own full scan. Do not add a fourth thing to that pile.

**The picker's folder view is shared with story 16, not copied.** Both need "the known-folder list, in place, with a back row". If story 16's implementation is not reusable as-is, factor it out in this story rather than writing a second one — two folder pickers that can drift is exactly the divergence story 12 exists to prevent, one layer up.

**Silence is the designed failure mode (AC7).** Claude failing to start is visible in the PTY output, in Claude's own words. A PWA-level error message would be a worse, second-hand account of something the user is already looking at.

**Rollout:** last story in Feature B. Needs story 19's endpoint and story 16's folder view deployed; both are satisfied by ordering since the daemon and PWA ship together.

## Manual Test Checklist
- [ ] `story-20-check.sh`: gate + PASS/FAIL, then start the daemon and print the phone URL.
- [ ] On the phone: open the session picker, tap **New session**, pick a folder with no existing session.
- [ ] Confirm you land on the Terminal pane and can watch Claude start up.
- [ ] Wait. Confirm the header offers a jump once Claude is ready, and that tapping it lands you in the Claude pane **on that new session** — check the folder and title, not just that the pane changed.
- [ ] Send it a prompt from the composer and confirm it behaves like any other session, including that an `AskUserQuestion` card can appear (that is the whole reason this is a PTY and not a headless process — story 19's F18(2) note).
- [ ] Pick a folder where Claude cannot start (or stop the binary from resolving) and confirm the jump never appears and nothing errors — you just see why in the terminal.
