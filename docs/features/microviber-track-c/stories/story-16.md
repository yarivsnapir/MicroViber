---
id: microviber-track-c-16
title: Terminal dropdown — open terminals, and a new one in a known folder
status: todo
project: microviber
depends_on: [microviber-track-c-15, microviber-track-c-12]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/62
---

## User Story
As a **developer with more than one project**, I want **to pick which terminal I am looking at and start a new one in a folder I choose**, so that **I am not stuck with whichever shell happened to exist**.

## Acceptance Criteria
1. The terminal header's `CaretButton` opens a dropdown whose default view lists the **open terminals** plus a single **New terminal** row.
2. Tapping **New terminal** swaps the **same panel in place** to the known-folder list, with a back row. This is the two-level in-place swap `SessionPicker.tsx` already uses for "Browse by folder" — **not** a second sheet.
3. The folder list is `GET /api/folders` (story 12), so every row offered is one the spawn gate will accept.
4. Picking a folder calls `POST /api/terminals`, then attaches to the new id.
5. Picking an open terminal attaches to it, displacing whatever client was attached — the displaced-client behaviour story 14 built.
6. A terminal that has died is either absent from the list or visibly marked dead, never silently offered as live.
7. Closing a terminal is reachable from the dropdown and calls `DELETE /api/terminals/:id`.
8. Hitting the session cap surfaces the daemon's `403` as a readable message, not a silent no-op — the cap is a deliberate rejection and the user should see why.
9. `hasSession` from `GET /api/folders` is used to distinguish folders that already host a Claude session, so the list is informative rather than a flat list of paths.
10. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/TerminalPane.tsx` — the dropdown and its two views.
- `pwa/src/lib/api.ts` — `listFolders`, `createTerminal`, `listTerminals`, `closeTerminal`.
- `pwa/src/lib/types.ts` — the folder and terminal record shapes (hand-mirrored, FENCE 1).
- `pwa/test/terminal-pane.test.tsx` — extend: both dropdown views, the in-place swap, the cap error.

## Technical Notes
**Reuse, do not invent.** The two-level in-place swap and `CaretButton` both already exist and are used by the session picker and the Web pane address bar. Introducing a sheet, a modal, or a second `CaretButton` variant here would be a UI regression against `spec.md` §2.5's explicit instruction to borrow the established idiom. Read `SessionPicker.tsx` before writing this, not after.

**The folder list is deliberately not `GET /api/sessions`.** See story 12's notes: a child directory with no session of its own is the common case and is exactly what neither the session list nor `devServerPorts` can supply.

**Rollout:** purely additive UI on top of story 15's working pane.

## Manual Test Checklist
- [ ] `story-16-check.sh`: gate + PASS/FAIL, then start the daemon and print the phone URL.
- [ ] On the phone: open the dropdown, confirm it lists the terminal you already have plus **New terminal**.
- [ ] Tap **New terminal**. Confirm the panel swaps **in place** to folders, with a back row that returns you — not a second sheet stacking on top.
- [ ] Confirm a child directory with no Claude session of its own is offered (that row is why this endpoint exists).
- [ ] Start a terminal in it, run `pwd`, confirm the folder is what you picked.
- [ ] Create terminals up to the cap, then one more. Confirm you get a readable message, not a dead tap.
- [ ] Close a terminal from the dropdown and confirm it leaves the list.
