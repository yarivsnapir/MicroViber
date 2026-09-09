---
id: microviber-track-c-18
title: Reopening the Terminal pane returns to the terminal you were in
status: todo
project: microviber
depends_on: [microviber-track-c-16]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/64
---

## User Story
As a **developer switching between panes**, I want **the Terminal pane to come back to the terminal I was using**, so that **I am not re-picking a folder every time I glance at the Claude tab**.

## Acceptance Criteria
1. The last-attached terminal id is remembered in `localStorage` under `mv_terminal_last`, mirroring the Web pane's existing `mv_webpane_last`.
2. Reopening the pane reattaches to it **if it is still alive**.
3. If it is not alive — reaped, closed, or lost to a daemon restart — the pane falls back to the folder picker rather than showing a dead or blank terminal.
4. Liveness is confirmed against `GET /api/terminals` before attaching, so a stale id never produces a failed socket the user has to interpret.
5. A `localStorage` read that throws or returns nothing is handled: the pane opens on the folder picker, never crashes.
6. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/TerminalPane.tsx` — persist on attach, restore on mount, fall back.
- `pwa/test/terminal-pane.test.tsx` — extend: restore-alive, restore-dead-falls-back, unreadable-storage.

## Technical Notes
**Mirror the Web pane, do not invent a second pattern.** `mv_webpane_last` already exists and does the same job for the Web pane's target, including its auto-open-on-mount behaviour. Read that code first; the key name in AC1 is chosen to sit alongside it.

**Note the asymmetry with the Web pane, deliberately.** The Web pane's restore auto-mints a token and opens the target with no further gesture, which T16's amendment flags as a real widening for *local files*. A terminal id is not a filesystem path and minting nothing, so restoring one grants no read the user has not already had — but do not copy the auto-mint shape along with the storage shape.

**Rollout:** additive, and self-healing. A `mv_terminal_last` written by this story is meaningless to any earlier build, and an absent one is the normal first-run case.

## Manual Test Checklist
- [ ] `story-18-check.sh`: gate + PASS/FAIL, then start the daemon and print the phone URL.
- [ ] On the phone: open a terminal, run something so it is identifiable, switch to the Claude tab, switch back. Confirm you land in the same terminal with its scrollback, not on the picker.
- [ ] Close that terminal from the dropdown, switch away, switch back. Confirm you get the folder picker, not a dead terminal.
- [ ] Restart the daemon on the laptop, then reopen the pane on the phone. Confirm the same graceful fallback — terminals die with the daemon by design (story 11 AC4), so this is the expected path, not an error.
