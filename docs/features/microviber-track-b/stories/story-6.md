---
id: microviber-track-b-6
title: Session picker dropdown + folder browsing
status: todo
project: microviber
depends_on: [microviber-track-b-3]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/13
---

## User Story
As a **developer working on several sessions across different project folders in parallel**, I want a "Recent" list showing my most active sessions regardless of folder, with folder-browsing available as a secondary option, so that I can flip between parallel sessions without navigating folder-first every time.

## Acceptance Criteria
1. The session header's trigger becomes the shared `CaretButton` (same style as the Web pane's address-bar caret), opening a top-anchored dropdown panel directly below the header — not the old bottom sheet.
2. The default view, **Recent**, shows the 5 most-recently-active sessions (or fewer) across **all** folders, sorted newest-user-prompt-first (unchanged sort key from the original picker), each row showing its folder name inline.
3. A "Browse by folder ›" link appears **only** when more than one distinct folder exists across all sessions; tapping it swaps the panel's content in place (same panel, not a new sheet) to a folder-grouped list — folder name, session count, and an aggregated state dot (amber if any session in it is `working`, else emerald if any `idle`/`awaiting-input`, else grey).
4. Tapping a folder swaps the panel again to that folder's sessions, with a "‹ Projects" back row; a "‹ Recent" back row returns from the folder list to Recent.
5. Tapping a session row in any view calls the existing `onPick` callback and closes the panel.

## Affected Files
- `pwa/src/components/SessionPicker.tsx` — rewritten: props change from `{ sessions, onPick, onClose }` to `{ open, onOpenChange, sessions, onPick }`; internal view state machine (`recent | folders | folder`).
- `pwa/src/App.tsx` — swaps the header's plain circle trigger for `CaretButton`, updates the `SessionPicker` call site to the new props.
- `pwa/test/session-picker.test.tsx` — new (covers both the dropdown restructure and the folder drill-down).

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 14 and 15. Depends on story microviber-track-b-3 for the `CaretButton` component — do not duplicate that component here. Per `docs/features/microviber-track-b/spec.md` §9, this deliberately keeps Recent as the *default*, cross-folder view rather than replacing the flat list with folder-first navigation as `production-readiness.md` originally scoped — the reason recorded there: working multiple sessions across folders in parallel is the common case, and folder-first navigation would add a tap to it every time.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] With sessions running in at least two different folders, tap the session header's caret: confirm the dropdown opens directly below the header (not a bottom sheet) and shows Recent by default with folder names inline.
- [ ] Tap "Browse by folder", confirm the folder list shows correct session counts and a sensible aggregated dot per folder.
- [ ] Drill into a folder, confirm only that folder's sessions show, then use both back rows to return to Recent.
- [ ] With sessions in only one folder, confirm "Browse by folder" is not shown at all.
