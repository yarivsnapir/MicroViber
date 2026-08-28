# MicroViber — Production Readiness Spec

> Status: design approved 2026-08-26 · Branch: `feature/microviber` (Harness)
> Companion to [spec.md](spec.md) (product design) and [plan.md](plan.md) (build plan).
> This spec covers making the app **publicly installable** and the **SDLC skills
> project-aware** — not new product behavior, except the Track B features in §5.

---

## 1. Goal & End State

`yarivsnapir/MicroViber` is a public GitHub repo that a stranger — or a stranger's
Claude Code session — can clone and install from its docs alone. Concretely:

- **Repo:** MIT license, fresh single-root history (no development history published),
  CI green (`typecheck + lint + test` on every PR and push to `main`).
- **Docs:** architecture + functional specs live **inside the repo**
  (`docs/architecture-spec.md`, `docs/functional-spec.md`), updated to the
  takeover-via-resume model. README + INSTALL are **Claude-Code-ready** (§3).
- **Features:** takeover-via-resume write path finished (stories 2–4), plus Track B:
  PWA installability + app icon, embedded dev-server browser, UX polish (§5).
- **Skills:** every `syncounter*` SDLC skill (and the SDLC-adjacent skills they chain
  into) works on MicroViber by resolving per-project context from a **project
  registry** instead of hardcoded Syncounter assumptions (§4).
- **Identity:** the MicroViber repo is owned and pushed as GitHub user **yarivsnapir**;
  Syncounter repos keep using `yariv-syncounter`. Per-repo git identity + a second
  `gh` account handle the split.

### Decisions taken during design

| Decision | Choice |
|---|---|
| Scope | Include finishing stories 2–4, reconciled to current code first |
| Docs home | Inside the MicroViber repo (`docs/`); Harness `docs/features/microviber/` stays as design archive with a pointer |
| Skills strategy | Generalize existing skills to project-aware via a registry; no `microviber-*` duplicates |
| Git history | Fresh initial commit (squash); development history stays local |
| License | MIT (as-is / no-warranty clause is the legal protection wanted) |
| Distribution | Clone + install docs; npm packaging is out of scope |
| Dev-server proxy | Explicit per-folder port config, allowlist-only; no auto-detection |

### Facts established (2026-08-26)

- `yarivsnapir/MicroViber` exists, is **empty** (no default branch) and **already
  PUBLIC** — created 2026-08-26. Phase 1 must either flip it private until Phase 4
  (user's one-click action, recommended) or accept early-public with honest status.
- `gh` on this machine is authenticated **only** as `yariv-syncounter`. Adding the
  `yarivsnapir` account (`gh auth login`) is interactive → **user checkpoint**.
- CI workflow already exists (`.github/workflows/ci.yml`: Node 22, npm ci,
  typecheck/lint/test on push-to-main + PRs) — reuse, don't rewrite.
- `microviber/` local repo: branch `main`, no remote, uncommitted daemon changes that
  look like in-flight story-2 work. Personal/machine strings grep-hit in
  `daemon/src/config.ts`, `daemon/src/server/pairing.ts`, `README.md`, `INSTALL.md`.
- Stories: 1 done; 2–4 todo, tracked local-only (no GitHub issues yet).

---

## 2. Phase 1 — Repo bootstrap & publication

1. **Sanitization scan.** Genericize machine-specific values in tracked files
   (config defaults, pairing examples, README/INSTALL sample values). Legitimate
   Tailscale product references stay. Verify `.env` is ignored and no tracked file
   carries personal data. Fresh-commit publishing means git history is not a leak
   vector.
2. **In-repo specs.** Write `docs/architecture-spec.md` and `docs/functional-spec.md`
   derived from Harness `docs/features/microviber/spec.md`, **rewritten to
   takeover-via-resume** (the source spec still describes superseded attach-send in
   places). These are the context files the SDLC skills load for MicroViber work.
   Harness `docs/features/microviber/README` gains a pointer: "specs now live in the repo."
3. **Public-repo hygiene.** `LICENSE` (MIT, © Yariv Snapir), README rewrite
   (standalone links — no `../features/...`; honest status; explicit security
   disclaimer: the daemon can execute commands on the host), reuse existing CI.
4. **Claude-Code-ready install docs** (§3).
5. **Fresh initial commit & push.** Orphan branch from the current tree → single
   initial commit → push as `yarivsnapir` to `yarivsnapir/MicroViber`; set per-repo
   `git config user.name/email`. The uncommitted story-2 work stays in the working
   tree (not in the initial commit) and lands later via its story PR.
6. **Visibility:** recommend flipping the repo private until Phase 4 (user action).

## 3. Claude-Code-ready install docs

README + INSTALL.md are written so a user can tell a fresh Claude Code session
"install MicroViber" and it succeeds end-to-end:

- Every step is an exact copy-runnable command followed by an explicit **verify**
  command whose expected output is stated (so an agent can confirm progress).
- The Tailscale section covers install → login → `tailscale serve` → obtaining the
  tailnet IP, per-OS, as explicit either/or branches.
- Decision points (bind address, port, token handling) are phrased as branches with
  defaults, never open prose.
- The repo ships a `CLAUDE.md`: project layout, where the install runbook is, test
  commands, security posture, and the rule that the daemon is off by default.
- Acceptance test is Phase 4's stranger test (§6), executed by a fresh Claude Code
  session in a scratch clone.

## 4. Phase 2 — Skills generalization (project-aware)

1. **Scan scope:** `syncounter-brainstorming`, `syncounter-spec-to-stories`,
   `syncounter-story-development`, `syncounter-code-review`,
   `syncounter-feature-status`, `syncounter-retrospective`, `syncounter-harness-pr`,
   plus SDLC-adjacent: `create-qa-pr`, `spec-to-stories`, `story-driven-development`.
   Catalog every Syncounter-specific assumption: three-repo list, `qa` branch model,
   `architecture-spec-v2.md` / `functional-spec/` paths, GitHub org + account, test
   commands, MSTUDIO specifics, port conventions.
2. **Project registry:** one shared file, `.claude/skills/_shared/projects.md`
   (Harness), mapping each project to: local repo path, GitHub `owner/repo`,
   gh account, default branch, PR target branch (`qa` for Syncounter apps, `main`
   for MicroViber), spec/docs paths, test commands, stories directory. Skills
   resolve "which project" first, then read everything else from the registry.
   **Syncounter behavior must stay byte-identical** — generalization, not change.
3. **Story tracking:** MicroViber stories keep living in Harness
   `docs/features/microviber/stories/` (workspace convention) and gain `github_issue`
   sync against `yarivsnapir/MicroViber` issues.
4. **gh account handling:** skills must run `gh` as the project's account. Mechanism
   (e.g. `GH_CONFIG_DIR`, `gh auth switch`, or per-invocation `GH_TOKEN`) is decided
   in the plan after testing multi-account `gh` on this machine.

## 5. Phase 3 — Stories (two tracks, both before go-public)

### Track A — takeover conversion (existing stories 2–4)

Reconcile first (explicit requirement): diff stories 2–4 against actual code —
story 1 merged; uncommitted changes suggest story 2 partially done; story 4 shrinks
because Phase 1 rewrites the docs (it becomes final reconciliation, not a rewrite).
Update story files to the real remaining delta, create GitHub issues, then develop
each through the generalized skills (`story-development` → `code-review` → PR to
`main`). Track A doubles as Phase 2's acceptance test.

### Track B — new feature stories (spec-first)

Written as amendments to the in-repo specs, carved via generalized
`spec-to-stories`, then developed like Track A:

1. **PWA installability + app icon.** Complete web-app manifest
   (`display: standalone`, maskable 192/512 icons, `start_url`, theme colors), real
   app icon, service-worker installability criteria, in-app install button on
   `beforeinstallprompt`, iOS "Add to Home Screen" guidance fallback. Acceptance:
   Chrome/Android installs a real standalone app, not a bookmark.
2. **Embedded dev-server browser.** A pane inside MicroViber showing the local dev
   server of the session's project folder, tunneled through the daemon (phone can't
   reach laptop `localhost`). Daemon grows a reverse-proxy route. Constraints locked
   at this level: **port discovery = explicit per-folder mapping in daemon config**
   (no auto-detection); **proxy is allowlist-only** — never "any port the phone
   asks for"; threat model T1–T12 must be extended for this route in
   `docs/architecture-spec.md`.
3. **UX/UI polish.** App title bar, app icon in UI, session loading via folder list
   (group sessions by project cwd → tap folder → its sessions), replacing the flat
   session list.

## 6. Phase 4 — Production pass & go-public

1. **Stranger test:** fresh clone in a scratch directory; a fresh Claude Code session
   follows README/INSTALL literally; daemon builds and starts from docs alone. Every
   gap found is fixed and re-tested. Phone-side steps are a manual user checkpoint.
2. Physical-phone verification (story 3 + Track B checklists) — user checkpoint.
3. Flip repo public (if it was made private), tag `v0.1.0`, final README status.

## 7. Verification

- CI green on every PR; the 108-test suite stays green and grows with stories.
- Stranger test (§6.1) defines "installable by anyone."
- Dogfooded Track A + B stories define "skills aligned"; any Syncounter-assumption
  trip found mid-story is fixed in the skill, not worked around.
- Syncounter non-regression: after Phase 2, spot-run `syncounter-feature-status`
  and dry-run path resolution of `create-qa-pr` against a Syncounter repo to confirm
  byte-identical behavior.

## 8. Out of scope

npm packaging (`npx microviber`), multi-user/multi-machine support, hosted service,
session creation from the phone (spec.md Phase 2), any change to Syncounter app code.
