---
id: microviber-track-c-8
title: Follow the transcript bottom while pinned, without yanking the view
status: todo
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/44
---

## User Story
As a **developer watching a session work from my phone**, I want **new output to scroll into view while I am at the bottom, and the view to stay put while I am reading further up**, so that **I can watch progress live without the page fighting me**.

## Acceptance Criteria
1. When the user is already at the bottom of the transcript, new events scroll into view.
2. When the user has scrolled up, new events do **not** move the view.
3. Selecting a different session still jumps to the bottom of that session's transcript on first load.
4. A small slack of about 24 pixels counts as "at the bottom", so a partially scrolled last line still follows.
5. `npm run typecheck && npm run lint && npm test` is green from the repo root.

## Affected Files
- `pwa/src/components/Transcript.tsx` — replace the two scroll effects with a pinned-tracking scroll handler.
- `pwa/test/transcript-scroll.test.tsx` — **new.**

## Technical Notes
Implements **plan task 12**. PWA only; the daemon is untouched.

**Rollout assumption: none.** Independent of every other story in this track and can ship in any order.

**The current behaviour is one-shot.** `Transcript.tsx` scrolls to the bottom exactly once per newly-selected session and never again, so events arriving during a live turn do not follow and the view appears frozen mid-task. The opposite failure would be just as bad: scrolling on every poll would yank the reader back down while they read up-thread. Both directions must be tested.

**Testing note, worth knowing before writing the test.** jsdom performs no layout, so it reports `scrollHeight` and `clientHeight` as zero and clamps a real `scrollTop` assignment back to zero. The test must redefine all three as plain properties and **record** what the component assigns, rather than trusting jsdom to store it. jsdom also fires no scroll events on its own, so the handler must be triggered with an explicit dispatch. The implementation plan carries a working harness for this.

## Manual Test Checklist
- [ ] Start the daemon and open the PWA on a session, then give it a task that produces output over some time.
- [ ] Stay scrolled at the bottom and confirm new output scrolls into view as it arrives.
- [ ] Scroll up into the history while the session is still working, and confirm the view does **not** jump back down as new output arrives.
- [ ] Scroll back to the bottom and confirm following resumes.
- [ ] Switch to a different session and confirm it opens at the bottom of its own transcript.
- [ ] Switch back and confirm the behaviour is still correct.
