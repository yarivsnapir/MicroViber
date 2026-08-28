# Story microviber-3 Implementation Plan — PWA takeover composer gate completion

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.
> Story: [story-3.md](story-3.md) · Issue: yarivsnapir/MicroViber#2 · Branch: `story/microviber-3` (microviber repo, from main b907ce8)

**Goal:** Close the story's three open ACs: a "hand back" affordance in the taken-over composer state (AC 6), removal of the dead `startOwned` client (AC 7), and component tests for the four composer-gate states (AC 8).

**Architecture:** ACs 1–5 already shipped; this is a completion pass over `pwa/src/lib/api.ts`, `pwa/src/App.tsx`, `pwa/src/components/Composer.tsx`, plus new component tests. Test infra exists (`@testing-library/react` 16 + jsdom 25 + vitest 4; `markdown-safety.test.tsx` is the .tsx precedent — copy its setup pattern). The daemon side is live on main: `POST /api/sessions/:id/handback` → `{success:true, data:{id, mode:'readonly'}}`, idempotent.

## Global Constraints
- Gate: `npm run typecheck && npm run lint && npm test` from `microviber/`, green before the commit.
- No new dependencies. Follow the existing component/styling conventions in `pwa/src/components/` (dark theme, existing button classes — read `states.tsx` and `Composer.tsx` before rendering anything new).
- The hand-back control is part of the same take-over gate (story AC 5) — one affordance in the taken-over state, no separate mode toggle.
- PWA never imports daemon internals (lint FENCE 1).

### Task 1 (only task): handback UI + dead-code removal + gate-state tests (TDD)

**Files:** Modify `pwa/src/lib/api.ts`, `pwa/src/App.tsx`, `pwa/src/components/Composer.tsx` (only if the affordance belongs inside it — judge from the existing taken-over branch); Create `pwa/test/composer-gate.test.tsx` (or `App.test.tsx` — pick what the existing component structure makes natural).

- [ ] Read `App.tsx` (the four-state gate + `takeoverSession()` + `pendingPrompt` effect), `Composer.tsx`, `states.tsx`, `SessionPicker.tsx`, `lib/api.ts`, and `markdown-safety.test.tsx` (test setup pattern).
- [ ] Write failing tests first — component tests rendering the gate in all four states from mocked session data: **working** → composer disabled, "still working" visible, no Take-over button; **idle** → Take-over button enabled, tap calls the takeover api fn; **stale** → disabled "session has ended"; **taken-over** → live composer AND a visible "Hand back" control, tap calls `api.handback(id)` then triggers refresh (assert the mocked api fns were called; mock at the api-module boundary with `vi.mock`). Plus: `api.ts` unit assertions that `handback(id)` POSTs to `/api/sessions/{id}/handback` with the bearer header, and that `startOwned` no longer exists (type-level: the import fails → covered by its removal + typecheck).
- [ ] Run tests → new ones fail (no handback fn/control yet).
- [ ] Implement: `api.ts#handback(id)` mirroring the existing `takeover(id)` fetch shape; remove `startOwned` entirely; render the Hand-back affordance in the taken-over state (wire: call handback → `refresh()` → row returns to `readonly` per the daemon contract); keep working/idle/stale branches untouched.
- [ ] Run the failing tests → pass; then full gate.
- [ ] Verify: `grep -rn "startOwned\|sessions/owned" pwa/` → empty; `grep -rn "handback" pwa/src` → api fn + call site(s).
- [ ] Commit on `story/microviber-3`: `feat(pwa): hand-back control completes the takeover gate; drop dead startOwned (microviber-3 AC6-8)` + footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push.
