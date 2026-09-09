---
id: microviber-track-c-17
title: Accessory key row — Esc, Tab, sticky Ctrl, arrows, Ctrl-C
status: todo
project: microviber
depends_on: [microviber-track-c-15]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/63
---

## User Story
As a **developer typing into a shell on a phone**, I want **the keys a phone keyboard cannot produce**, so that **the terminal is actually usable instead of technically present**.

## Acceptance Criteria
1. A single row sits **above the keyboard** and supplies: `Esc`, `Tab`, a **sticky** `Ctrl` modifier, the four arrow keys, and a dedicated `Ctrl-C`.
2. `Ctrl` is sticky: tapping it arms the modifier, the next key press is sent as a control character, and the modifier then disarms. Its armed state is visible.
3. A dedicated `Ctrl-C` exists **in addition to** sticky-`Ctrl`-then-`c`, because it is the one people reach for most and two taps for it is one too many.
4. Each key sends the correct byte sequence as a `{ t: 'in' }` frame: `Esc` → `\x1b`, `Tab` → `\x09`, `Ctrl-C` → `\x03`, and the arrows → their ANSI sequences (`\x1b[A`/`B`/`C`/`D`).
5. A test asserts the exact bytes for every key, including a sticky-`Ctrl` combination — this is the acceptance evidence, since "the arrow key works" is otherwise only checkable by hand.
6. The row does not obscure the terminal's last line while the keyboard is open — the viewport calculation accounts for both.
7. The row is present only on the Terminal pane, not on Claude or Web.
8. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `pwa/src/components/transcript/../TerminalAccessoryRow.tsx` — **new** (place it beside `TerminalPane.tsx`, not under `transcript/`).
- `pwa/src/components/TerminalPane.tsx` — render the row, own the sticky-modifier state, feed frames.
- `pwa/test/terminal-accessory-row.test.tsx` — **new.** The exact byte sequences, sticky arm/disarm.

## Technical Notes
**This is new UI with no precedent in the app, and that is a deliberate deviation.** `spec.md` §6 records it against the minimalism rule: every other surface in MicroViber borrows an existing idiom, and this one cannot, because nothing in the app has ever needed a modifier key. Do not try to force it into an existing component's shape.

**Byte sequences are the specification.** AC4's list is not illustrative — an arrow key that sends the wrong sequence looks like a working button and produces garbage in `vim`. Get them from a real terminal (`showkey -a`, or `cat -v` and press the key) rather than from memory, and pin them in the test.

**Sticky rather than held.** A phone cannot hold a modifier while pressing another key, so the modifier has to latch. Disarming after one key press (rather than staying latched) is the choice that matches how people use `Ctrl` — a burst of `Ctrl-R`, not a run of control characters.

**Rollout:** additive UI on story 15's pane.

## Manual Test Checklist
- [ ] `story-17-check.sh`: gate + PASS/FAIL (the byte-sequence assertions are unit tests and run here), then start the daemon and print the phone URL.
- [ ] On the phone, in a terminal: press each arrow key at a shell prompt with history and confirm it walks history / moves the cursor, rather than printing `^[[A`.
- [ ] `Tab`-complete a path.
- [ ] Run `top`, tap the dedicated `Ctrl-C`, confirm it exits.
- [ ] Tap sticky `Ctrl`, confirm it looks armed, then press `c` and confirm it interrupts and the modifier disarms.
- [ ] Press `Esc` in `vim` insert mode and confirm it leaves insert mode.
- [ ] With the keyboard open, confirm the row does not cover the terminal's last line.
