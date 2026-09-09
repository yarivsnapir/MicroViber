---
id: microviber-track-c-10
title: Reconcile the architecture spec with CLAUDE.md's existing no-spawn-outside-the-adapter rule
status: todo
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/56
---

## User Story
As a **maintainer**, I want **the architecture spec to say plainly whether launching the `claude` binary is quarantined behind the adapter**, so that **Feature A's new `lib/terminal/` module is built on a decided rule instead of a feature spec exempting itself from a repo-wide one**.

## Why this is a story and not a paragraph in another one
`spec.md` §2.1 asserts that `lib/terminal/` sits outside `lib/claude-adapter/` because "a shell is not a Claude Code internal, so the adapter quarantine does not cover it and FENCE 2 … does not apply." For a plain login shell that is correct and uncontroversial.

But `spec.md` §3.1 step 4 then has that same module spawn `<config.claudeBin> --dangerously-skip-permissions` — i.e. launch Claude Code itself. Whether *that* is a Claude Code internal is a question `docs/architecture-spec.md` §6 does not currently answer: its quarantine clause enumerates `~/.claude/sessions/`, `~/.claude/projects/`, the messaging socket, `peerProtocol`, and the transcript entry vocabulary. Process spawning is not on that list, and today it does not need to be — `daemon/src/lib/claude-adapter/node-spawner.ts` is the only file in the repo that imports `child_process`, so the adapter is the sole spawner by construction rather than by rule.

A feature spec deciding a repo-wide, lint-enforced fence "does not apply" to the module it is introducing is the wrong place for that call (code review, story-1). §6 is where the fence is defined, so §6 is where it gets settled — **before** Feature A's code lands, not during it.

**The rule already exists — it is just in the wrong document.** `microviber/CLAUDE.md` lines 37-38 state it outright:

> "All Claude Code internals live in `daemon/src/lib/claude-adapter/` behind a peerProtocol version gate. **Code outside that directory must not read `~/.claude/` or spawn `claude`.**"

So the repo's standing instruction to every contributor and every agent is already the *widen* reading, and `spec.md` §2.1 contradicts it. That reframes this story: it is **not an open design question** but a reconciliation. `docs/architecture-spec.md` §6's quarantine clause enumerates paths, socket, `peerProtocol` and transcript vocabulary but omits spawning, so the spec is silent where CLAUDE.md is explicit — and the feature spec then filled that silence the other way.

Note that §3.3 already settles the *other* half correctly and should not be disturbed: `lib/terminal/` must obtain the discovered session set from `services`, never by reading `~/.claude` itself, exactly as `lib/webpane/` does. Only the spawn question is open.

## Acceptance Criteria
1. `docs/architecture-spec.md` §6's adapter-quarantine clause states explicitly that **spawning the `claude` binary is inside the quarantine**, matching what `CLAUDE.md` already tells every contributor. The clause currently enumerates `~/.claude` paths, the socket, `peerProtocol` and the transcript vocabulary, and omits spawning; that omission is the defect.
2. It is recorded with its reasoning and dated, in the style of the section's existing amendments, and notes that `CLAUDE.md` already carried the rule — so a future reader sees this as a spec catching up, not a new restriction.
3. The spec names **where** Claude's argv is constructed, and that location is singular. Two places in the repo that know how to start Claude is the outcome this story exists to prevent.
4. §6 states that `lib/terminal/` may spawn a plain login shell freely — a shell is genuinely not a Claude Code internal — but must ask the adapter for a Claude session. The adapter gains, or is noted as needing, an exported entry point for that (story 19 implements it).
5. `docs/features/microviber-track-c/spec.md` §2.1's "the adapter quarantine does not cover it and FENCE 2 … does not apply" sentence is **corrected to scope it to shells only**, and §3.1 step 4 is reworded so Feature B obtains its invocation from the adapter. Today those two passages read as licence to build a second spawner.
6. Whether the FENCE 2 **lint rule** (`eslint.config.js`'s `no-restricted-syntax` selectors) should gain a selector for spawning is decided and recorded. The current selectors match only `~/.claude` and `cc-socks` string literals, so **nothing mechanically enforces the spawn half of the rule** — which is how a feature spec came to contradict it unnoticed. If a selector is impractical (the call is `spawn(config.claudeBin, …)`, not a literal), say so explicitly and note that this half stays review-enforced.
7. If a reviewer instead concludes the *narrow* reading is right — that a second spawner is acceptable — that is a change to `CLAUDE.md` as well as §6, and it must say how the two spawners are kept from drifting. Do not settle it in only one of the two documents.
8. `npm run typecheck && npm run lint && npm test` green from the repo root (a docs-only change should not move them, but `tsconfig.docs.json` typechecks `docs/**/*.ts` and lint covers `docs/`, so run the gate).

## Affected Files
- `docs/architecture-spec.md` — §6 quarantine clause; possibly a §3 FENCE 2 note.
- `docs/features/microviber-track-c/spec.md` — §2.1's fence sentence, §3.1 step 4's spawn description.
- `eslint.config.js` — only if AC6 decides a selector is practical.
- `CLAUDE.md` — only under AC7, i.e. only if the *narrow* reading wins.

## Technical Notes
**Facts to decide against, verified on `main` at the time of carving:**
- `config.claudeBin` is ordinary config (`daemon/src/config.ts:29`, from `MV_CLAUDE_BIN`) and already flows config → `services.ts:238` → the adapter. "Which binary" is therefore *already* a non-adapter concern that the adapter receives as a parameter — which is a real argument for the *narrow* reading.
- The argv itself, however, is adapter-owned today: `lib/claude-adapter/session-manager.ts` builds the takeover invocation, and `lib/claude-adapter/node-spawner.ts` is the only `child_process` importer in the repo.
- `lib/webpane/` is the standing precedent for a non-adapter `lib/` module, and it touches no Claude Code internals at all — which is why it is a clean precedent for a *shell* and a weaker one for spawning `claude`.

**Recommendation: widen — and note this is now the low-friction option, not the strict one.** `CLAUDE.md` already says it, so widening makes the architecture spec agree with the instructions the repo already gives; narrowing would mean *editing CLAUDE.md to loosen a security rule* in order to accommodate a feature spec, which is a much bigger claim than it first appeared. It also keeps "how a Claude session is started" in one file and costs Feature B a thin call into the adapter. The plumbing already exists, since `claudeBin` is passed in rather than hardcoded.

**Out of scope:** `--dangerously-skip-permissions` as a *choice*. That was offered, declined, and recorded in `spec.md` §3.5/§7, and takeover already runs that way. This story decides *where the flag is written*, not whether it is used.

**No code behaviour changes in this story.** It is a decision plus its record. Story 11 and story 19 implement against it.

## Manual Test Checklist
- [ ] Nothing to run and nothing to look at in the app — this story ships a decision. Read the §6 diff and confirm it answers, in one place, "where is Claude's argv built, and why there". If it leaves that ambiguous, it has not landed.
