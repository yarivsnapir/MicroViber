---
id: microviber-track-c-15
title: A working terminal on the phone — third pane tab and xterm.js
status: todo
project: microviber
depends_on: [microviber-track-c-14]
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/61
---

## User Story
As a **developer away from my laptop**, I want **a real terminal on my phone that I can type into and read**, so that **I can run a command without walking back to the desk**.

## Acceptance Criteria
1. The pane switch goes from two tabs to three: **Claude, Terminal, Web**. `App.tsx`'s `pane` state widens from `'claude' | 'web'` to include `'terminal'`.
2. `components/TerminalPane.tsx` hosts an `@xterm/xterm` instance with `@xterm/addon-fit`.
3. It opens the `/ws?terminal=<id>` socket, sending the bearer in `Sec-WebSocket-Protocol` exactly as `pwa/src/lib/api.ts`'s `openStream` already does — that function stops being dead code here.
4. Keystrokes go out as `{ t: 'in' }`; `{ t: 'out' }` renders; `{ t: 'exit' }` shows the terminal has ended rather than silently freezing.
5. `addon-fit` drives a `{ t: 'resize' }` frame when the viewport changes, so the PTY's dimensions track the visible area — including on rotation and on keyboard show/hide, which are the two that actually happen on a phone.
6. ANSI colours render. `Ctrl-C` sent from the accessory row (story 17) or a hardware keyboard interrupts. A full-screen program (`vim`, `top`) draws correctly, which is the real test of replay plus resize.
7. A persistent header shows the current terminal's folder, using the **same `CaretButton`** the Web pane's address bar and the session picker already use. Chrome is borrowed, not invented.
8. On attach, the replayed ring buffer reconstructs the visible screen before live output resumes.
9. **No CSP change.** xterm.js is pure JavaScript with no `eval` and no WebAssembly, so `script-src 'self'` stands, and `connect-src` already permits `ws:`/`wss:`. A CSP edit in this story's diff is a finding — T7 makes that a hard requirement.
10. Terminal output is rendered into xterm's own canvas, never into `innerHTML`. OSC 8 hyperlink handling and clipboard-write handling are **disabled explicitly** rather than left at their defaults — terminal output is untrusted bytes and a hostile program can emit OSC sequences that set titles, write the clipboard, or inject links.
11. The existing two panes are unaffected: switching away and back does not disturb the Claude transcript's scroll position or the Web pane's target.
12. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/TerminalPane.tsx` — **new.** xterm instance, socket client, header.
- `pwa/src/App.tsx` — the third pane value and its tab.
- `pwa/src/lib/api.ts` — `openStream` gains its first production caller; extend for the terminal id.
- `pwa/src/lib/types.ts` — the frame types, mirrored by hand (FENCE 1).
- `pwa/package.json` — `@xterm/xterm`, `@xterm/addon-fit`.
- `pwa/src/index.css` — xterm's stylesheet.
- `pwa/test/terminal-pane.test.tsx` — **new.** Frame in/out, resize, exit, disabled OSC handlers.
- `pwa/test/pane-switch.test.tsx` — extend for the third tab.

## Technical Notes
**This is the first user-visible story in Feature A**, and the first that cannot be verified by a script alone. Stories 11–14 are all invisible; this is where they become a terminal.

**Complexity is L and splitting was considered.** The dropdown chrome (story 16), the accessory key row (story 17) and reattach (story 18) are deliberately carved out, leaving this story as "one terminal, attached by id, that works". If it still proves unwieldy, the natural next cut is to land the pane with a hardcoded/first-available terminal id and let story 16 introduce selection — but do not cut resize (AC5) or the disabled OSC handlers (AC10) out of it, since the first is what makes a phone terminal usable and the second is a security requirement.

**T21 is this story's threat row.** Terminal output is untrusted bytes rendered into the PWA. xterm.js interprets escape sequences as terminal *state*, never as code, and the CSP already forbids inline script and `eval`. AC10's explicit disabling of OSC 8 and clipboard-write is the part that is a *choice* rather than a property of the library — assert it in a test. If Feature A's threat rows are not yet in `docs/architecture-spec.md`, add T21 there in this story.

**Rollout:** the Terminal tab appears for the first time here, so stories 13 and 14 must already be deployed. Since the daemon and PWA ship together in one PR, that is satisfied by ordering, not by a runtime guard.

## Manual Test Checklist
- [ ] `story-15-check.sh` in the shape story-1 established: it runs the gate itself and prints PASS/FAIL, then starts the daemon and prints the phone URL. Everything checkable without eyes must be in Part 1 — do not hand over a list of commands.
- [ ] On the phone: open the Terminal tab. Type `ls` and confirm output with colours.
- [ ] Run `top`, then rotate the phone. Confirm the display re-fits rather than corrupting — that is AC5 and it is the one most likely to be subtly wrong.
- [ ] Open the keyboard and close it. Confirm the same.
- [ ] Run `vim`, move around, `:q`. Confirm a full-screen program draws and exits cleanly.
- [ ] Lock the phone, wait, unlock, reopen the pane. Confirm the screen is reconstructed from replay, not blank.
- [ ] Exit the shell with `exit`. Confirm it says the terminal ended rather than freezing.
- [ ] Switch to Claude and Web and back. Confirm neither lost its place.
