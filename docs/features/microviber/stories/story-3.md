---
id: microviber-3
title: PWA — Take-over composer gate replaces broken attach/owned UI
status: done
project: microviber
depends_on: [microviber-2]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/2
---

## User Story
As the **phone user**, I want the **composer to show a state-driven gate** — disabled while the laptop session is working, an enabled "Take over" button once it's idle, and a live composer with a "hand back" affordance after taking over — so that sending a prompt from my phone always actually reaches the session instead of hitting the broken attach path ("couldn't reach the session").

> **Reconciled 2026-08-26, then re-reconciled the same day** after the working tree in
> `microviber-2`'s note was absorbed and committed at `59c355c "feat: takeover write path +
> live-testing fixes"`. Same PWA files as before, now on `main`. Re-verified every "still
> open" item below directly against that commit: `pwa/test/` still holds the same 5 files
> (`auth`, `markdown-safety`, `prompt-display`, `relative-time`, `text`) — no new component
> test was added for the composer-gate states (AC 8 unchanged); `grep -rn "handback"
> pwa/src` still returns nothing (AC 6 unchanged); `pwa/src/lib/api.ts` still defines
> `startOwned` (AC 7 unchanged). Committing the WIP didn't finish any of the items below —
> `npm run typecheck --prefix pwa` and `npm test --prefix pwa` are both green (19/19) at
> HEAD, same as before.

## Acceptance Criteria — already shipped in the WIP (verify + keep on pickup)
1. Three of the composer's four states are implemented in `App.tsx`: **working** → disabled bar, "still working" message, no takeover offered; **idle** (not yet taken over) → enabled **"Take over — send from phone"** button that calls `POST …/takeover` and, on success, refreshes and hands off to the live composer; **stale** → disabled "session has ended" message. The **taken over** state renders the live `<Composer>` — but see AC 4 below, its "hand back" control is missing.
2. All four `PromptStatus` values (`accepted`/`queued`/`expired`/`failed`) render via the pre-existing `pwa/src/lib/prompt-display.ts` (Task 20, unchanged) — `Composer.tsx` consumes it via `promptDisplay(status)`; `expired`/`failed` retain typed text and offer Resend (`disp.showResend`). Covered by the pre-existing `pwa/test/prompt-display.test.ts`. Also newly wired in the WIP: `App.tsx` now polls `sendPrompt` again while a record is `queued` (idempotent re-submit by the same key) so `status` actually transitions to `accepted`/`expired` instead of getting stuck — this wasn't in the original AC but is a real fix worth keeping (`pendingPrompt` state + effect in `App.tsx`).
3. `SessionPicker.tsx` no longer offers "＋ start phone session" (the `onStartOwned` prop and button are removed) and shows each row's `mode`/`writable` badge.
4. `mode: 'attach' | 'owned'` → `'readonly' | 'owned'` — this was actually already done as part of `microviber-1`'s absorbed pairing-URL commit (`7fc1468 fix(pwa): update SessionMode/attach-check literals to match daemon's readonly rename`), not new in this story's WIP. `pwa/src/lib/types.ts` already reads `export type SessionMode = 'readonly' | 'owned'`.
5. No separate mode-toggle UI exists anywhere in the composer — the take-over gate is still the only write-mode control (once "hand back" is added per AC below, it stays that way — it's part of the same gate, not a second control).

## Acceptance Criteria — still open
6. **No "hand back" control exists.** Neither `Composer.tsx` nor `App.tsx`'s taken-over branch renders one, and `pwa/src/lib/api.ts` has no `handback()` call. Blocked on `microviber-2` AC 4 (`POST /api/sessions/:id/handback`) shipping first. Once it does: add `api.ts#handback(id)`, a "hand back" affordance in the taken-over composer state, and have it return the row to idle/stale in the picker per the original AC.
7. **`pwa/src/lib/api.ts` still defines `startOwned`**, even though nothing in the UI calls it anymore (the fresh-start button is gone per AC 3 above). Remove the dead function once `microviber-2` removes the daemon's `/owned` route it calls, so the two repos' dead code is deleted together rather than the client silently pointing at a route the server no longer serves.
8. **No component tests exist for the state-driven gate itself.** `pwa/test/` has `prompt-display.test.ts` (covers the four `PromptStatus` renderings, pre-existing) but no `Composer.test.tsx` / `App.test.tsx` covering the four composer *gate* states (working/idle/stale/taken-over) named in AC 1. Add them.

## Affected Files
- `pwa/src/components/Composer.tsx` — add the "hand back" control for the taken-over state (AC 6)
- `pwa/src/App.tsx` — wire `handback()` into the taken-over branch (AC 6)
- `pwa/src/lib/api.ts` — add `handback(id)`; remove dead `startOwned` (AC 6, 7)
- `pwa/src/lib/types.ts` — no further change expected; `mode` is already `'readonly' | 'owned'`
- `pwa/test/**` — new component tests for the four composer-gate states (AC 8); `prompt-display.test.ts` already covers the four post-send `PromptStatus` renderings, no change needed there

## Technical Notes
This is plan.md Task 21 (the key UX delta) plus the PWA-side "Delta from built code" items 7–9, and Task 19's delta (remove fresh-start action, done). It depends on `microviber-2`'s routes existing — `microviber-2`'s `/takeover` already exists so most of this story could proceed, but the "hand back" half genuinely cannot land until `microviber-2`'s `/handback` route does.

Task 20 (transcript renderer, sanitized markdown, T7 security-critical) and Task 17/18 (shell/SW/pairing) remain unchanged by this delta, as originally noted. The WIP additionally touches `Transcript.tsx` (auto-scroll-once-on-session-load) and adds `lib/text.ts` (`firstSentence`, used for the session subtitle preview) — both unplanned scope-adds bundled into the same branch, not required by this story's ACs, and not blocking; no action needed unless review flags them.

**Rollout assumption:** requires `microviber-2` shipped, specifically the `/handback` route for AC 6. The read/takeover half of this story can otherwise ship and be reviewed independently of that gap. Once this story fully ships, the full write path (phone → daemon → same transcript file, including handing it back) is usable end-to-end for the first time under the v3 model.

## Manual Test Checklist
Task 23's end-to-end walkthrough (plan.md) applies here since this is the story that makes takeover usable in the UI — these are genuine human-only checks (physical phone, live sessions):
- [ ] Start a session in VS Code, run a long command, watch it appear in the phone list as **working**.
- [ ] Watch the turn stream live without taking over (read-only mirror).
- [ ] Session goes **idle** → push notification arrives; the **Take over** button lights up; takeover is refused while it was still working.
- [ ] Tap **Take over** → composer becomes live; send a prompt (including one that answers a question) → it lands in the **same** transcript file, visible in both the phone and the laptop's VS Code tab.
- [ ] Send again while it's busy processing → shows **queued**, then **accepted** once it drains.
- [ ] Back at the laptop: `/resume` the session → it reloads with the phone's turns; the frozen tab is abandoned; the phone's notification disappears.
- [ ] **Hand back** from the phone → session returns to read-only in the picker. (Blocked until AC 6 ships.)
- [ ] Repeat against a **terminal**-hosted session (not just VS Code) to confirm host-agnostic behavior (F14).
- [ ] `npm run typecheck --prefix pwa` and `npm test --prefix pwa` → both green (already true on the current WIP; re-run after finishing AC 6–8, run these yourself before the human walkthrough — only the physical-phone steps above are human-only).
