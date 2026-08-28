---
id: microviber-4
title: Docs — final reconciliation to shipped takeover behavior + close spec §13 checkpoints
status: done
project: microviber
depends_on: [microviber-3]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/3
---

## User Story
As a **future reader of this repo (including future-me)**, I want **`microviber/README.md` and the in-repo/workspace specs to describe the shipped read-only-mirror + takeover model precisely**, including any last-mile gaps between what's documented and what `microviber-2`/`microviber-3` actually ship, so that the docs match what the code actually does.

> **Scope rewritten 2026-08-26, then re-reconciled the same day** after `microviber-2`/
> `microviber-3`'s working tree was absorbed and committed at `59c355c "feat: takeover
> write path + live-testing fixes"`. That commit's message claims "Docs updated to match"
> and does touch `docs/architecture-spec.md` — but re-reading it at HEAD shows it
> introduced a **new inaccuracy**, not a fix: see AC 7. Every other item below (spec.md
> §13/§14, the fixture) is a Harness-workspace or `daemon/test/fixtures/` file the
> live-fix commit never touched, so all remain exactly as first found — re-verified
> directly against HEAD `59c355c`, not assumed unchanged.
>
> The original version of this story ("reconcile README and spec to the takeover-via-resume
> model") is **largely already done**: a prior phase moved `docs/architecture-spec.md` and
> `docs/functional-spec.md` in-repo, rewrote `README.md`/`INSTALL.md`/`CLAUDE.md` for the
> takeover model, and published the repo publicly as `yarivsnapir/MicroViber`. `README.md`
> still has no "attach mode" or two-mode explanation to remove. What's left is narrower:
> final reconciliation once `microviber-2`/`microviber-3` actually ship, fixing the
> `architecture-spec.md` regression found below, closing out the still-open `spec.md` §13
> checkpoints as far as they honestly can be closed without a live spike, and a
> fixture-sanitization cleanup found along the way.

## Acceptance Criteria
1. **README re-verification (mostly already true, confirm on pickup).** `README.md` already explains what MicroViber is, install (Tailscale via `INSTALL.md`), the read-only-mirror + takeover model, and links to `docs/architecture-spec.md` for the threat model. Re-read it once `microviber-2`/`microviber-3` are actually `done` and confirm it still matches: specifically, that it mentions **hand-back** (not just takeover) once `microviber-3` ships it, and that it doesn't imply `POST /api/sessions/owned` (fresh-start) is available once `microviber-2` removes it.
2. **`docs/features/microviber/spec.md` §13, checkpoint 7 ("Takeover ownership lifecycle") can be closed now**, independent of `microviber-2`/`microviber-3` landing — the answer is already implemented and commented in `microviber/daemon/src/domain/ownership.ts`: ownership is tracked **in-memory only**; a daemon restart is *not* specially parented through — it simply reverts every owned session to read-only, and the phone can take it over again. Record this as the resolved safe default in spec.md §13 (change its status from "OPEN — daemon spike" to "RESOLVED").
3. **Checkpoints 3 and 6 stay genuinely open — do not mark them resolved.** Both are explicitly gated on a live daemon spike with a real subscriber (`findings.md` Investigation 3 and 4: "best done once the daemon holds a real subscription", "to be confirmed in the daemon spike"). Nothing in the `microviber-2`/`microviber-3` WIP touches idle-notification one-shot semantics or `peerToken` re-read behavior. This is a **docs-only story with no code changes** (per the original story's own technical note) — closing these two would require running that spike, which is out of scope here. Leave them `OPEN`, and add one sentence to each noting they were re-checked as part of this story and remain open pending that spike, so a future reader doesn't have to re-derive that from `findings.md`.
4. **`docs/features/microviber/spec.md` §14 ("Repo Layout") is stale and contradicts reality.** It currently reads: *"Local repo is initialized on `main`. **No GitHub remote** — the user chose local-only... MicroViber is a personal tool rather than a Syncounter product."* The repo has since been published (`yarivsnapir/MicroViber`, public, with `github_issue:`-tracked stories). Update this paragraph to state the repo is published and issues live there — this was found during this reconciliation pass, not part of the original AC list, but is a direct instance of "docs not matching shipped state."
5. **Sanitize `daemon/test/fixtures/session-cli.json`.** It currently contains a real product name and path: `"cwd":"/Users/dev/Syncounter-local/billing-agent"` and `"name":"billing-agent-8a"`. This is a test fixture in a now-public repo. Replace both with a generic placeholder (e.g. `cwd: "/Users/dev/example-project"`, `name: "example-project-1a"`) that doesn't reference a real Syncounter product or path. Grep the rest of `daemon/test/fixtures/` and any other committed fixtures for the same pattern before considering this done — this may not be the only instance.
6. `findings.md` is **not** duplicated into the README, but not for the originally-stated reason ("avoid parallel docs surfaces") — `findings.md` lives only in the private Harness workspace (`docs/features/microviber/findings.md`), not in the public `microviber/` repo at all, so there is nothing to link to from a public reader's perspective. `docs/architecture-spec.md` already cites it correctly as an internal provenance note ("this document is derived from... corrected against the code actually committed"), which is fine as-is. No action needed — recorded here so the original AC's premise (README should link to `findings.md`) isn't silently carried forward as still-true.
7. **New, found in the 59c355c re-reconciliation pass: `docs/architecture-spec.md` now understates what's shipped.** Around its API-surface table it reads: *"Takeover and handback — story 2 (in progress). The design's write path (`POST /api/sessions/:id/takeover`, `POST /api/sessions/:id/handback`)... are **not yet wired to HTTP routes** in the committed `app.ts` — only `POST /api/sessions/owned` (fresh-session creation) exists today."* That's false at HEAD: `daemon/src/api/app.ts` has had `POST /api/sessions/:id/takeover` wired (idle-gated, tested) since before this doc update, and still does. Only `/handback` is genuinely missing — the doc conflates the two. Fix the paragraph to say takeover is live and only handback remains, once `microviber-2` closes AC 4 (or, if picked up before then, correct it to reflect the true current state rather than leave stale text in a docs commit that claims to be "updated to match").

## Note on this story's git-blame footprint
This story's `spec.md`/README/fixture items were all re-verified directly against
`daemon/test/fixtures/session-cli.json` and `docs/features/microviber/spec.md` at `59c355c` —
none were touched by that commit, so nothing here changed as a result of it landing. AC 7
above is the one item that *did* change because of `59c355c`: the doc commit meant to
close this gap instead added a new one.

## Affected Files
- `microviber/README.md` — re-verify per AC 1 once `microviber-2`/`microviber-3` ship
- `docs/features/microviber/spec.md` — close §13 checkpoint 7 (AC 2); annotate checkpoints 3/6 as re-checked-still-open (AC 3); fix the stale §14 "no GitHub remote" paragraph (AC 4)
- `microviber/daemon/test/fixtures/session-cli.json` (and any sibling fixtures with the same issue) — sanitize (AC 5)
- `microviber/docs/architecture-spec.md` — fix the takeover-vs-handback paragraph (AC 7)

## Technical Notes
This is plan.md Task 26, narrowed as above. It still depends on `microviber-3` shipping first for AC 1's re-verification to describe final, shipped behavior rather than an in-progress state — but AC 2, 3, 4, and 5 do **not** depend on `microviber-2`/`microviber-3` landing and can be done independently/first if useful.

No code changes in this story (AC 5's fixture edit is data, not logic — the fixture's shape is unchanged, only its content strings). Per the skill's rule 4 (backend-only stories ship a verification script), the "script" here is a plain read-through diff check plus the greps named in the Manual Test Checklist.

**Rollout assumption:** none for AC 2/3/4/5 (pure docs/data, no user-facing behavior change). AC 1 assumes `microviber-3` shipped so the README's walkthrough describes real, working, hand-back-included behavior instead of aspirational behavior.

## Manual Test Checklist
- [ ] Read `microviber/README.md` end-to-end; confirm no reference to "attach mode" or the old owned/fresh-start flow remains (already true today — re-confirm after `microviber-2`/`microviber-3` land, and check hand-back is mentioned).
- [ ] `grep -n "§13" docs/features/microviber/spec.md` and check each hit: checkpoint 7 reads `RESOLVED`; checkpoints 3 and 6 read `OPEN` with the re-checked note from AC 3.
- [ ] `grep -n "No GitHub remote" docs/features/microviber/spec.md` → no hits (AC 4 fixed it).
- [ ] `grep -rn "Syncounter-local\|billing-agent" microviber/daemon/test/fixtures/ microviber/pwa/test/` → no hits (AC 5).
- [ ] Confirm `README.md` does not restate `findings.md`'s content inline (it doesn't today) — no link is expected either, per AC 6.
- [ ] `grep -n "not yet wired to HTTP routes" microviber/docs/architecture-spec.md` → no hits (AC 7 fixed it).
