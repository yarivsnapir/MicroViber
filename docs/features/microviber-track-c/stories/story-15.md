---
id: microviber-track-c-15
title: The terminal on the phone — pane, dropdown, key row, reattach
status: todo
project: microviber
depends_on: [microviber-track-c-14]
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/61
---

## User Story
As a **developer away from my laptop**, I want **a real terminal on my phone that I can type into, pick, and come back to**, so that **I can run a command without walking back to the desk**.

## Consolidated
This story is the merge of what were originally stories 15, 16, 17 and 18 (issues [#62](https://github.com/yarivsnapir/MicroViber/issues/62), [#63](https://github.com/yarivsnapir/MicroViber/issues/63), [#64](https://github.com/yarivsnapir/MicroViber/issues/64), now closed into this one).

**Why these four merged.** All four edit `pwa/src/components/TerminalPane.tsx`, and three of them also edit `pwa/test/terminal-pane.test.tsx` and `pwa/src/lib/api.ts`. This is the same shared-file argument that folded stories 2–5 into story 1, and here it is the stronger form: the dropdown, the key row and reattach are not independent features layered on the pane — they are the pane. Shipping them separately would produce three sequential rebases on one growing component for no rollout benefit, since the daemon and PWA ship together in a single PR anyway.

## Acceptance Criteria

### A working terminal
1. The pane switch goes from two tabs to three: **Claude, Terminal, Web**. `App.tsx`'s `pane` state widens from `'claude' | 'web'` to include `'terminal'`.
2. `components/TerminalPane.tsx` hosts an `@xterm/xterm` instance with `@xterm/addon-fit`.
3. It opens the `/ws?terminal=<id>` socket, sending the bearer in `Sec-WebSocket-Protocol` exactly as `pwa/src/lib/api.ts`'s `openStream` already does — that function stops being dead code here.
4. Keystrokes go out as `{ t: 'in' }`; `{ t: 'out' }` renders; `{ t: 'exit' }` shows the terminal has ended rather than silently freezing.
5. `addon-fit` drives a `{ t: 'resize' }` frame when the viewport changes, so the PTY's dimensions track the visible area — including on rotation and on keyboard show/hide, which are the two that actually happen on a phone.
6. ANSI colours render. A full-screen program (`vim`, `top`) draws correctly, which is the real test of replay plus resize.
7. On attach, the replayed ring buffer reconstructs the visible screen before live output resumes.
8. The existing two panes are unaffected: switching away and back does not disturb the Claude transcript's scroll position or the Web pane's target.

### Security posture of the render path
9. **No CSP change.** xterm.js is pure JavaScript with no `eval` and no WebAssembly, so `script-src 'self'` stands, and `connect-src` already permits `ws:`/`wss:`. A CSP edit in this story's diff is a finding — T7 makes that a hard requirement.
10. Terminal output is rendered into xterm's own canvas, never into `innerHTML`. OSC 8 hyperlink handling and clipboard-write handling are **disabled explicitly** rather than left at their defaults — terminal output is untrusted bytes and a hostile program can emit OSC sequences that set titles, write the clipboard, or inject links. Assert the disabling in a test: it is a choice, not a property of the library.

### Picking a terminal
11. The header shows the current terminal's folder, using the **same `CaretButton`** the Web pane's address bar and the session picker already use. Chrome is borrowed, not invented.
12. Tapping it opens a dropdown whose default view lists the **open terminals** plus a single **New terminal** row.
13. Tapping **New terminal** swaps the **same panel in place** to the known-folder list, with a back row. This is the two-level in-place swap `SessionPicker.tsx` already uses for "Browse by folder" — **not** a second sheet.
14. The folder list is `GET /api/folders` (story 10), so every row offered is one the spawn gate will accept.
15. Picking a folder calls `POST /api/terminals`, then attaches to the new id. Picking an open terminal attaches to it, displacing whatever client was attached.
16. A dead terminal is either absent from the list or visibly marked dead, never silently offered as live.
17. Closing a terminal is reachable from the dropdown and calls `DELETE /api/terminals/:id`.
18. Hitting the session cap surfaces the daemon's `403` as a readable message, not a silent no-op.
19. `hasSession` from `GET /api/folders` distinguishes folders that already host a Claude session, so the list is informative rather than a flat list of paths.

### The keys a phone cannot produce
20. A single row sits **above the keyboard** supplying `Esc`, `Tab`, a **sticky** `Ctrl` modifier, the four arrow keys, and a dedicated `Ctrl-C`.
21. `Ctrl` is sticky: tapping it arms the modifier, the next key press is sent as a control character, and the modifier then disarms. Its armed state is visible.
22. A dedicated `Ctrl-C` exists **in addition to** sticky-`Ctrl`-then-`c`, because it is the one people reach for most and two taps for it is one too many.
23. Each key sends the correct byte sequence as a `{ t: 'in' }` frame: `Esc` → `\x1b`, `Tab` → `\x09`, `Ctrl-C` → `\x03`, arrows → `\x1b[A`/`B`/`C`/`D`. **A test pins the exact bytes for every key**, including a sticky-`Ctrl` combination — an arrow key that sends the wrong sequence looks like a working button and produces garbage in `vim`.
24. The row does not obscure the terminal's last line while the keyboard is open — the viewport calculation accounts for both.
25. The row is present only on the Terminal pane.

### Coming back to it
26. The last-attached terminal id is remembered in `localStorage` under `mv_terminal_last`, mirroring the Web pane's existing `mv_webpane_last`.
27. Reopening the pane reattaches **if it is still alive**, confirmed against `GET /api/terminals` before attaching so a stale id never produces a failed socket the user has to interpret.
28. If it is not alive — reaped, closed, or lost to a daemon restart — the pane falls back to the folder picker rather than a dead or blank terminal.
29. A `localStorage` read that throws or returns nothing opens the folder picker and never crashes.
30. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/TerminalPane.tsx` — **new.** xterm instance, socket client, header, dropdown, sticky-modifier state, reattach.
- `pwa/src/components/TerminalAccessoryRow.tsx` — **new.** The key row.
- `pwa/src/App.tsx` — the third pane value and its tab.
- `pwa/src/lib/api.ts` — `openStream` gains its first production caller; `listFolders`, `createTerminal`, `listTerminals`, `closeTerminal`.
- `pwa/src/lib/types.ts` — the frame types plus the folder and terminal record shapes, mirrored by hand (FENCE 1).
- `pwa/package.json` — `@xterm/xterm`, `@xterm/addon-fit`.
- `pwa/src/index.css` — xterm's stylesheet.
- `pwa/test/terminal-pane.test.tsx` — **new.** Frames in/out, resize, exit, disabled OSC handlers, both dropdown views, the cap error, reattach alive/dead/unreadable.
- `pwa/test/terminal-accessory-row.test.tsx` — **new.** The exact byte sequences, sticky arm/disarm.
- `pwa/test/pane-switch.test.tsx` — extend for the third tab.

## Technical Notes
**This is the first user-visible story in Feature A**, and the first that cannot be verified by a script alone. Story 10 and story 14 are both invisible; this is where they become a terminal.

**Suggested internal order:** one attached terminal that works (AC1–AC10), then the dropdown (AC11–AC19), then the key row (AC20–AC25), then reattach (AC26–AC29). Each is a commit; do not interleave them.

**Reuse, do not invent.** The two-level in-place swap and `CaretButton` already exist and are used by the session picker and the Web pane address bar. Introducing a sheet, a modal, or a second `CaretButton` variant would be a regression against `spec.md` §2.5's explicit instruction to borrow the established idiom. Read `SessionPicker.tsx` before writing the dropdown, not after.

**The key row is the one deliberate deviation.** `spec.md` §6 records it against the minimalism rule: every other surface borrows an existing idiom, and this one cannot, because nothing in the app has ever needed a modifier key. Do not force it into an existing component's shape. Sticky rather than held, because a phone cannot hold a modifier while pressing another key; disarming after one key press matches how people use `Ctrl` — a burst of `Ctrl-R`, not a run of control characters.

**Get the byte sequences from a real terminal**, not from memory — `showkey -a`, or `cat -v` and press the key — then pin them in the test (AC23).

**Mirror the Web pane for reattach, but not its auto-mint.** `mv_webpane_last` does the same storage job, including auto-open-on-mount. Note the asymmetry deliberately: the Web pane's restore auto-mints a token and opens a target, which T16's amendment flags as a real widening for local files. A terminal id is not a filesystem path and mints nothing, so restoring one grants no read the user has not already had — copy the storage shape, not the auto-mint shape.

**T21 is this story's threat row.** Terminal output is untrusted bytes rendered into the PWA. xterm.js interprets escape sequences as terminal *state*, never as code, and the CSP already forbids inline script and `eval`. AC10's explicit disabling of OSC 8 and clipboard-write is the part that is a choice. Add T21 to `docs/architecture-spec.md` here if it is not already present.

**Rollout:** the Terminal tab appears for the first time here, so story 10 and story 14 must already be deployed. Since the daemon and PWA ship together in one PR, ordering satisfies that — no runtime guard is needed.

**If this proves unwieldy in review**, the natural cut is to lift the accessory key row (AC20–AC25) back out. It is the most separable block: its own new component, its own test file, and it only *feeds* frames into the pane rather than changing how the pane works. Do **not** cut resize (AC5) or the disabled OSC handlers (AC10) — the first is what makes a phone terminal usable and the second is a security requirement.

## Manual Test Checklist
- [ ] `story-15-check.sh` in the shape story-1 established: everything checkable without eyes runs in Part 1 with PASS/FAIL — including the byte-sequence assertions, which are unit tests — then it starts the daemon and prints the phone URL. Do not hand over a list of commands.
- [ ] Open the Terminal tab. Type `ls` and confirm output with colours.
- [ ] Run `top`, then rotate the phone. Confirm the display re-fits rather than corrupting — that is AC5 and the one most likely to be subtly wrong. Open and close the keyboard; confirm the same.
- [ ] Run `vim`, move around with the arrow keys, `:q`. Confirm a full-screen program draws, the arrows move the cursor rather than printing `^[[A`, and `Esc` leaves insert mode.
- [ ] `Tab`-complete a path. Run `top` and tap the dedicated `Ctrl-C`. Then tap sticky `Ctrl`, confirm it looks armed, press `c`, and confirm it interrupts and disarms.
- [ ] With the keyboard open, confirm the key row does not cover the terminal's last line.
- [ ] Open the dropdown: confirm it lists your terminal plus **New terminal**. Tap that and confirm the panel swaps **in place** to folders with a working back row — not a second sheet stacking on top. Confirm a child directory with no Claude session of its own is offered, start a terminal in it, and `pwd`.
- [ ] Create terminals up to the cap, then one more. Confirm a readable message, not a dead tap. Close one from the dropdown and confirm it leaves the list.
- [ ] Lock the phone, wait, unlock, reopen the pane. Confirm the screen is reconstructed from replay, not blank.
- [ ] Switch to Claude and back. Confirm you land in the same terminal with its scrollback, and that the transcript did not lose its place. Close that terminal, switch away and back, and confirm you get the folder picker instead of a dead terminal.
- [ ] Restart the daemon, then reopen the pane. Confirm the same graceful fallback — terminals die with the daemon by design (story 10 AC9), so this is expected, not an error.
- [ ] Exit a shell with `exit`. Confirm it says the terminal ended rather than freezing.
