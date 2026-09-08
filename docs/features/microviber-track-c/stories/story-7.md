---
id: microviber-track-c-7
title: Mark phone-sent prompts and stop collapsing newlines in user turns
status: todo
project: microviber
depends_on: [microviber-track-c-1]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/43
---

## User Story
As a **developer who drives one session from both my laptop and my phone**, I want **my multi-line prompts to keep their line breaks and phone-sent turns to be visibly marked**, so that **I can read back what I actually sent and always know which turns came from where**.

## Acceptance Criteria
1. A user prompt renders with `whitespace-pre-wrap`, so newlines the user typed survive. Today the text is a plain React child with no whitespace handling, so **every multi-line prompt collapses into one wrapped run**.
2. A turn this daemon sent is marked `injected: true` and renders with the amber "From phone" treatment. That treatment already exists in the code and is currently unreachable, because `injected` is hardcoded `false`.
3. `injected` is decided in the **services** layer, not in the adapter, by correlating against the prompt lifecycle's own records.
4. A laptop-typed turn is not marked.
5. `PromptLifecycle` gains `wasInjected(sessionId, text)` with unit tests, including that it does not match across sessions.
6. `npm run typecheck && npm run lint && npm test` is green from the repo root.

## Affected Files
- `daemon/src/domain/prompt-lifecycle.ts` — add `wasInjected`.
- `daemon/src/services/services.ts` — stamp `injected` in `getTranscript` after the existing observe loop and before the event slice.
- `daemon/test/prompt-lifecycle.test.ts` — new cases.
- `daemon/test/services.test.ts` — new case asserting a sent prompt comes back marked.
- `pwa/src/components/transcript/UserTurn.tsx` — **new.**
- `pwa/src/components/Transcript.tsx` — dispatch `UserTurn`.
- `pwa/test/transcript-user-turn.test.tsx` — **new.**

## Technical Notes
Implements **plan tasks 6 and 7**.

**Rollout assumption: story 1 has shipped.** `injected` already exists on the wire as a field; this story only starts setting it truthfully, so a cached older PWA is unaffected.

**Why this cannot be fixed in the adapter, which is the whole reason it was never done.** `injected` requires the daemon's record of prompts it sent, which lives in `daemon/src/domain/prompt-lifecycle.ts`. The layering fence forbids `lib/claude-adapter/` importing from `domain/`, so the adapter genuinely cannot compute it and hardcodes `false`. `services/` is the one layer that sees both sides. This matches what the architecture spec already says: the flag is set by daemon-side correlation, not by unwrapping anything on the wire. A takeover prompt lands in the transcript as a **plain** user entry, indistinguishable from a laptop-typed one, which is the entire point of the takeover write path.

**Known and accepted imprecision, to be stated in the code comment.** Correlation is by exact text. If the same text is typed at the laptop *and* sent from the phone, both render as "From phone". Marking a laptop turn as phone-sent is the harmless direction, and de-duplicating would need per-entry identity the transcript does not carry.

**This closes a false claim in the functional spec**, which states that phone-injected prompts stay visually distinct. That has never been true in shipped code.

## Manual Test Checklist
- [ ] Start the daemon and open the PWA.
- [ ] Take over an idle session from the phone.
- [ ] Send a prompt from the phone containing several lines, including a blank line between paragraphs.
- [ ] Confirm the prompt renders with its line breaks intact, not collapsed onto one run.
- [ ] Confirm that same prompt carries the amber "From phone" marker.
- [ ] Type a prompt directly into the session on the laptop and confirm it appears in the phone's transcript **without** the marker.
- [ ] Hand the session back and confirm both turns still render correctly after the reload.
