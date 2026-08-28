# MicroViber Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Spec: [production-readiness.md](production-readiness.md) · Product design: [spec.md](spec.md)

**Goal:** Make `yarivsnapir/MicroViber` a public, MIT-licensed, CI-green repo installable by any stranger (or their Claude Code session) from docs alone; finish the takeover-via-resume write path plus Track B features; and generalize every Syncounter SDLC skill to be project-aware via a shared project registry.

**Architecture:** Four sequential phases. Phase 1 bootstraps the repo (in-repo specs, license, Claude-Code-ready docs, fresh-root publish under the `yarivsnapir` GitHub identity). Phase 2 introduces `.claude/skills/_shared/projects.md` and rewrites each skill to resolve project context from it — Syncounter behavior stays byte-identical. Phase 3 runs the remaining stories *through* the generalized skills (dogfooding is the acceptance test). Phase 4 is the stranger test and the go-public flip.

**Tech Stack:** Node ≥22 npm workspaces (daemon: Fastify + TS; pwa: Vite + React 19 + Tailwind 4), GitHub CLI 2.87 multi-account via `GH_CONFIG_DIR`, GitHub Actions CI (exists: `.github/workflows/ci.yml`).

## Global Constraints

- **Two GitHub identities, never mixed:** MicroViber ops run as `yarivsnapir` via env prefix `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir` on every `gh` / `git push|pull|fetch` command; Syncounter repos keep the default keyring account `yariv-syncounter`. Never run `gh auth switch`.
- **MicroViber branch model:** default branch `main`, story branches `story/{story-id}`, PRs target `main` (no `qa`). Syncounter repos keep `qa` — unchanged.
- **Syncounter non-regression:** skill generalization must not change any resolved value for studio/audio-producer/scenario-creator (same PR base, same test commands, same spec paths).
- **MicroViber test gate:** `npm run typecheck && npm run lint && npm test` (run from `microviber/`), all green before any commit to `microviber/`.
- **Harness commits** (specs, stories, skills, registry) go on the current `feature/microviber` branch of the Harness repo; `microviber/` commits go on its own branches.
- **No personal/machine data** in any file tracked by `microviber/`: no absolute `/Users/...` paths, no real tailnet names, no ports from `CLAUDE.local.md`. Generic Tailscale references (`*.ts.net`, `100.64/10`) are fine.
- **The daemon stays off-by-default and never binds `0.0.0.0`** — no doc or code change may weaken spec §9 security posture.
- Working tree note: `microviber/` has uncommitted story-2 work. It must survive Phase 1 untouched (stash around the orphan commit, Task 5) and land later via story 2's own branch.

---

## Phase 1 — Repo bootstrap & publication

### Task 1: Second GitHub identity (`yarivsnapir`) + per-repo git identity

**Files:**
- Create: `$HOME/.config/gh-yarivsnapir/` (gh config dir, outside repos)
- Modify: `microviber/.git/config` (local `user.email`, `remote origin` comes in Task 5)

**Interfaces:**
- Produces: the env prefix `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir` (referred to as `{GH_ENV}` by every later task and by the Phase 2 registry).

- [ ] **Step 1: USER CHECKPOINT — interactive login.** `gh auth login` cannot be automated. Ask the user to run in their own terminal:

```bash
mkdir -p ~/.config/gh-yarivsnapir
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh auth login --hostname github.com --git-protocol https --web
```

and to authenticate the browser as **yarivsnapir** (not yariv-syncounter — check the avatar before authorizing). Wait for their confirmation.

- [ ] **Step 2: Verify the new account, isolated**

```bash
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh api user --jq .login
```
Expected: `yarivsnapir`

- [ ] **Step 3: Verify the default account is untouched**

```bash
gh api user --jq .login
```
Expected: `yariv-syncounter`

- [ ] **Step 4: Set per-repo git identity in microviber (noreply email of the yarivsnapir account)**

```bash
cd microviber && git config user.name "Yariv Snapir" && git config user.email "$(GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
cd microviber && git config user.email
```
Expected: `<numeric-id>+yarivsnapir@users.noreply.github.com`

- [ ] **Step 5: Verify credential helper resolves the right token under the prefix**

```bash
cd microviber && git config --get-all credential.helper; git config --global --get-all credential.helper
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh auth token | cut -c1-4
```
Expected: a `gh auth git-credential` helper is configured (globally or for github.com), and the token starts `gho_`. If no gh credential helper exists, run `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh auth setup-git` and re-verify.

*(No commit — nothing repo-tracked changed.)*

---

### Task 2: In-repo specs — `docs/architecture-spec.md` + `docs/functional-spec.md`

**Files:**
- Create: `microviber/docs/architecture-spec.md`
- Create: `microviber/docs/functional-spec.md`
- Source (read-only): `docs/features/microviber/spec.md`, `docs/features/microviber/findings.md`, `docs/features/microviber/stories/README.md`

**Interfaces:**
- Produces: the two spec paths that the Phase 2 registry binds as `{ARCH_SPEC}` / `{FUNC_SPEC}` for project `microviber`, and that code-review/brainstorming skills load as review criteria.

- [ ] **Step 1: Read the sources.** Read `docs/features/microviber/spec.md` in full (sections 1–15), `stories/README.md` (the v3 takeover model scope note), and skim `findings.md` for F13–F15/I6.

- [ ] **Step 2: Write `microviber/docs/architecture-spec.md`.** Derive from spec.md, **rewritten to the takeover-via-resume model** — the write path is `claude --resume <id>` takeover of idle sessions; the peer-socket send path and the separate "owned mode" are gone (mention them only in a short "superseded approaches" note citing I6). Required sections, in order:
  1. **System overview** — daemon (laptop) + PWA (phone) over a private tunnel; one shared history file per session; read-always / write-by-takeover (from spec §1, §4).
  2. **Claude Code integration contract** — the verified mechanics table condensed from spec §2 (F1–F3, F13–F15, I6), with the warning: *re-verify on every Claude Code version change; the adapter is quarantined in `daemon/src/lib/claude-adapter/` behind a `peerProtocol` version gate that degrades to read-only on unknown builds.*
  3. **Component architecture** — from spec §4 + §14 repo layout, matching the actual `daemon/src/` tree (api/, domain/, lib/claude-adapter/, server/, services/).
  4. **Event model & API surface** — from spec §5–6, corrected to the routes that exist in `daemon/src/api/app.ts` (read the file; do not copy spec routes blindly — takeover/handback routes may still be in-flight, mark them "story 2").
  5. **Transport & security (threat model T1–T12)** — from spec §9, verbatim threat IDs; two-factor posture (tunnel + bearer), bind-address whitelist, off-by-default.
  6. **Engineering standards** — testing gate (`typecheck`, `lint`, `test` all green), TS strictness as configured in `tsconfig.base.json`, adapter-quarantine rule (nothing outside `lib/claude-adapter/` touches Claude Code internals).

- [ ] **Step 3: Write `microviber/docs/functional-spec.md`.** Required sections: Problem & thesis (spec §1 incl. the WhatsApp-mirror quote), Modes — mirror & takeover (spec §3 as revised), UX flows (spec §7: session list, transcript view, composer gating on idle), Permissions & notifications (spec §8), Install & distribution summary (spec §15, pointing to `INSTALL.md` for the runbook). Every capability described must match the v3 takeover model.

- [ ] **Step 4: Verify no stale model or broken links**

```bash
cd microviber && grep -rn "owned mode\|attach mode\|attach-send\|peer socket send\|../features/" docs/ | grep -vi "superseded\|historical"
```
Expected: no output.

- [ ] **Step 5: Verify quality gate still green, then commit (to `main` of `microviber/`, pre-publish)**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
cd microviber && git add docs/ && git commit -m "docs: in-repo architecture + functional specs (takeover-via-resume model)"
```

---

### Task 3: LICENSE, README rewrite, repo CLAUDE.md

**Files:**
- Create: `microviber/LICENSE`
- Create: `microviber/CLAUDE.md`
- Modify: `microviber/README.md` (full rewrite)

**Interfaces:**
- Consumes: `docs/architecture-spec.md`, `docs/functional-spec.md` (Task 2 paths).
- Produces: the README security disclaimer and CLAUDE.md that Task 22's stranger test relies on.

- [ ] **Step 1: Write `LICENSE`** — standard MIT text, first line `MIT License`, second line `Copyright (c) 2026 Yariv Snapir`, followed by the canonical three MIT paragraphs (permission grant / inclusion-of-notice condition / AS-IS warranty disclaimer) verbatim from https://opensource.org/license/mit.

- [ ] **Step 2: Rewrite `README.md`.** Structure (all links repo-relative, none to `../features/`):
  1. Title + one-liner (keep the existing one: mirrors Claude Code sessions on your laptop, drive them from your phone, laptop never behind the phone).
  2. CI badge: `![CI](https://github.com/yarivsnapir/MicroViber/actions/workflows/ci.yml/badge.svg)`.
  3. **Security disclaimer, verbatim:**

  > **⚠️ Security disclaimer.** MicroViber's daemon can start and drive Claude Code sessions — which can execute commands on the machine it runs on. Only expose it over a private tunnel (Tailscale) to devices you own, keep the bearer token secret, and read the [threat model](docs/architecture-spec.md) before changing any network setting. The daemon is **off by default**, binds only to an explicitly configured private address, and refuses `0.0.0.0`. Provided as-is, without warranty, under the [MIT license](LICENSE).

  4. **How it works** — three bullets: reading is always on (transcript tail); writing is a deliberate takeover of an *idle* session via `claude --resume`; back on the laptop you `/resume` to catch up — one history file, two writers taking turns.
  5. **Install** — one line: "Follow [INSTALL.md](INSTALL.md) — it is written so you can paste it to a Claude Code session and let it drive."
  6. **Docs** — links to `docs/architecture-spec.md`, `docs/functional-spec.md`.
  7. **Development** — layout table (daemon/, pwa/, bin/) + `npm run typecheck && npm run lint && npm test`.
  8. **Status** — honest current state; updated again at Task 24.

- [ ] **Step 3: Write `microviber/CLAUDE.md`** with exactly this content:

```markdown
# MicroViber

Phone PWA that mirrors and drives Claude Code sessions running on a laptop.
Two components: `daemon/` (Node 22 + TypeScript + Fastify) and `pwa/`
(Vite + React 19 + Tailwind 4). `bin/microviberd` is the start|stop|status
runner — the daemon is OFF BY DEFAULT and must be started deliberately.

## Context docs (read before designing or reviewing changes)
- `docs/architecture-spec.md` — architecture, Claude Code integration
  contract, threat model T1–T12, engineering standards.
- `docs/functional-spec.md` — product behavior and UX flows.

## Commands (run from repo root)
- `npm run typecheck && npm run lint && npm test` — full quality gate; all
  three must pass before any commit.
- `npm run build` — build all workspaces.

## Installing / configuring
Follow `INSTALL.md` literally — every step has a **Verify** command with its
expected output. Do not improvise network or security settings.

## Security rules (non-negotiable)
- The daemon can drive Claude Code sessions that execute commands on this
  machine. Never weaken: bearer auth, Host allowlist, Origin checks, the
  bind-address whitelist (loopback / RFC-1918 / 100.64/10 only, never
  0.0.0.0), or off-by-default startup.
- All Claude Code internals live in `daemon/src/lib/claude-adapter/` behind a
  peerProtocol version gate. Code outside that directory must not read
  `~/.claude/` or spawn `claude`.
- Never commit `.env` or `~/.microviber/token`.
```

- [ ] **Step 4: Verify links resolve and no workspace leakage**

```bash
cd microviber && ls LICENSE CLAUDE.md docs/architecture-spec.md docs/functional-spec.md INSTALL.md
cd microviber && grep -rn "\.\./features\|Harness\|yariv_s\|/Users/" README.md CLAUDE.md LICENSE
```
Expected: first command lists all five files; second has no output.

- [ ] **Step 5: Commit**

```bash
cd microviber && git add LICENSE README.md CLAUDE.md && git commit -m "docs: MIT license, public README with security disclaimer, repo CLAUDE.md"
```

---

### Task 4: Claude-Code-ready INSTALL.md

**Files:**
- Modify: `microviber/INSTALL.md` (restructure; the existing 164-line Tailscale runbook is the raw material — keep its verified commands and facts, change its shape)

**Interfaces:**
- Produces: the runbook Task 22's stranger test executes literally.

- [ ] **Step 1: Read the current `microviber/INSTALL.md` in full.** Inventory which steps already have verify commands (e.g. line 58's `tailscale ip -4` check) and which are prose.

- [ ] **Step 2: Restructure to the agent-executable template.** Open with this preamble, verbatim:

```markdown
# Installing MicroViber

This runbook is written to be executed by a person **or by a Claude Code
session** ("install MicroViber by following INSTALL.md"). Rules for agents:
execute stages in order; after every step run its **Verify** command and
compare against the expected output; if a Verify fails, stop and report the
step number and actual output — do not improvise, especially around network
and security settings.
```

  Then restructure into stages, each step = one action, one fenced command block, one **Verify:** line with expected output:
  - **Stage 0 — Prerequisites:** Node ≥ 22 (`node --version` → `v22.x` or higher), Claude Code CLI present (`claude --version` → prints a version), git present. Per-OS notes: macOS and Linux only.
  - **Stage 1 — Clone & build:** `git clone https://github.com/yarivsnapir/MicroViber.git && cd MicroViber && npm ci && npm run build`. Verify: `npm run typecheck && npm run lint && npm test` all exit 0.
  - **Stage 2 — Tailscale:** explicit either/or branch: *already have Tailscale → skip to 2.3* / *install it* (macOS: `brew install --cask tailscale` or App Store; Linux: `curl -fsSL https://tailscale.com/install.sh | sh` — keep the official installer command the current INSTALL.md uses). Login, then get names: Verify `tailscale ip -4` → a `100.x.y.z` address; hostname ends `.ts.net`. Both phone and laptop join the same tailnet (phone: Tailscale app, same account).
  - **Stage 3 — Configure:** `cp .env.example .env`; then each variable as its own decision step with a default (bind address = the `100.x` tailnet IP; `MV_ALLOWED_HOSTS` = the `.ts.net` name only; token left empty to auto-generate). Keep the existing doc's security invariants verbatim (never `0.0.0.0`, HTTP fallback cannot install a PWA).
  - **Stage 4 — HTTPS + start:** `tailscale serve` forwarding, `./bin/microviberd start`. Verify: `./bin/microviberd status` reports running, and the health/pairing check the current INSTALL.md uses (reuse its exact curl/URL commands — do not invent new endpoints).
  - **Stage 5 — Pair the phone:** open the printed pairing URL on the phone, install the PWA. Mark clearly: **manual, phone-in-hand step.**
  - **Stage 6 — Uninstall/stop** (brief): `./bin/microviberd stop`, remove `~/.microviber/`.

- [ ] **Step 3: Verify template compliance**

```bash
cd microviber && grep -c "Verify:" INSTALL.md
cd microviber && grep -n "http://localhost\|/Users/\|yariv" INSTALL.md
```
Expected: first ≥ 12 (every actionable step has one); second: no output.

- [ ] **Step 4: Commit**

```bash
cd microviber && git add INSTALL.md && git commit -m "docs: restructure INSTALL.md as agent-executable runbook (stages + verify steps)"
```

---

### Task 5: Fresh initial commit → push to `yarivsnapir/MicroViber`

**Files:**
- Modify: `microviber/.git` refs only (orphan root, remote, push). No content changes.

**Interfaces:**
- Consumes: `{GH_ENV}` from Task 1; committed doc tasks 2–4 on local `main`.
- Produces: `origin` = `https://github.com/yarivsnapir/MicroViber.git`, remote `main` = single root commit, CI green. Local branch `archive/dev-history` preserves the old history (never pushed).

- [ ] **Step 1: Preserve in-flight story-2 work**

```bash
cd microviber && git stash push -u -m "story-2-wip (pre fresh-root)" && git status --porcelain
```
Expected: empty status.

- [ ] **Step 2: Archive old history, create the orphan root**

```bash
cd microviber && git branch archive/dev-history main
cd microviber && git checkout --orphan public-root && git add -A && git commit -m "MicroViber — initial public release

Phone PWA + laptop daemon that mirror and drive Claude Code sessions.
See README.md, INSTALL.md, and docs/ for architecture and threat model."
cd microviber && git branch -M public-root main
```

- [ ] **Step 3: Verify single-commit history and identical tree**

```bash
cd microviber && git log --oneline | wc -l && git diff main archive/dev-history --stat | tail -1
```
Expected: `1`, and an empty diff (no line output from the diff).

- [ ] **Step 4: Pre-push sanitization gate — tree-wide scan of the exact tree being published**

```bash
cd microviber && git grep -in "yariv\|snapir\|Harness-2\|/Users/" main -- . | grep -v "Yariv Snapir\|users.noreply\|yarivsnapir/MicroViber"
```
Expected: no output. (Allowed: the LICENSE/git-identity name, the noreply email, and the repo's own GitHub URL. Anything else — a real tailnet name, an absolute home path, a machine hostname — must be fixed and amended into the root commit before pushing.)

- [ ] **Step 5: Point at the GitHub repo and push (as yarivsnapir)**

```bash
cd microviber && git remote add origin https://github.com/yarivsnapir/MicroViber.git
cd microviber && GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir git push -u origin main
```

- [ ] **Step 6: Verify remote state + CI**

```bash
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh repo view yarivsnapir/MicroViber --json defaultBranchRef --jq .defaultBranchRef.name
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh run watch --repo yarivsnapir/MicroViber --exit-status
```
Expected: `main`; CI run completes with success (typecheck+lint+test on Node 22 via the existing `.github/workflows/ci.yml`).

- [ ] **Step 7: Restore in-flight work**

```bash
cd microviber && git stash pop && git status --porcelain | head
```
Expected: the story-2 modified files are back.

---

### Task 6: Visibility decision (USER CHECKPOINT)

The repo is **already public and was empty until Task 5**. Ask the user: keep it public now (README states honest status), or flip private until Phase 4? If they choose private:

- [ ] **Step 1 (only if user chooses private):**

```bash
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh repo edit yarivsnapir/MicroViber --visibility private --accept-visibility-change-consequences
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh repo view yarivsnapir/MicroViber --json visibility --jq .visibility
```
Expected: `PRIVATE`. Record the choice; Task 24 flips it back.

---

## Phase 2 — Skills generalization (project-aware)

Ground truth for this phase is the assumption catalog produced during planning (2026-08-26 scan). Per-skill line numbers below come from that scan; re-locate by content if lines have drifted.

### Task 7: Project registry + Harness CLAUDE.md row

**Files:**
- Create: `.claude/skills/_shared/projects.md` (Harness repo)
- Modify: `CLAUDE.md` (Harness root — add microviber to the Projects Overview table)

**Interfaces:**
- Produces: the registry every Task 8–16 edit points at, with the binding variables `{PROJECT_DIR}`, `{GH_REPO}`, `{GH_ENV}`, `{DEFAULT_BRANCH}`, `{PR_BASE}`, `{ARCH_SPEC}`, `{FUNC_SPEC}`, `{UIUX_SPEC}`, `{TEST_CMDS}`, flags (`graphify`, `rules_tests`, `i18n`, `firebase`), `{STORIES_DIR}`, `harness_companion_pr`.

- [ ] **Step 1: Write `.claude/skills/_shared/projects.md`** with exactly this content:

```markdown
# Project Registry — SDLC skill context resolution

Every SDLC skill resolves its target project here FIRST (its "Step 0.5"),
then uses ONLY these values — never a hardcoded repo name, branch, spec
path, test command, or GitHub account.

## Binding procedure (Step 0.5 of every SDLC skill)

1. Determine {PROJECT} from explicit user input, the story frontmatter
   `project:` field, or the files being worked on. Valid keys: the section
   names below. If ambiguous, ask (AskUserQuestion) — do not guess.
2. Bind the {VARIABLES} the skill uses from that project's table.
3. Prefix EVERY `gh` command and every `git push|pull|fetch` with {GH_ENV}
   (it may be empty). Example:
   `{GH_ENV} gh issue create --repo {GH_REPO} ...`
   Never run `gh auth switch`; account isolation is env-only.
4. Steps marked with a flag (graphify, rules_tests, i18n, firebase) run only
   when that flag is `yes` for the project.

## studio
| Variable | Value |
|---|---|
| PROJECT_DIR | `studio/` |
| GH_REPO | resolve: `gh repo view --json nameWithOwner -q .nameWithOwner` in PROJECT_DIR (SynKounter org) |
| GH_ENV | *(empty — default gh account, `yariv-syncounter`)* |
| DEFAULT_BRANCH | `main` |
| PR_BASE | `qa` |
| ARCH_SPEC | `architecture-spec-v2.md` (workspace root; §16 standards + Part B gap register §11–14) |
| FUNC_SPEC | `functional-specification.md` index → `functional-spec/NN-*.md` area files (workspace root); repo ledger: `studio/docs/functional-specs/*.md` routed by `studio/docs/functional-specifications.md` |
| UIUX_SPEC | `UI_UX_GUIDELINES.md` (workspace root) |
| TEST_CMDS | `npm test` |
| FLAGS | graphify=yes · rules_tests=yes · i18n=yes · firebase=yes |
| STORIES_DIR | `features/{feature}/stories/` (Harness repo) |
| harness_companion_pr | yes |

## audio-producer
| Variable | Value |
|---|---|
| PROJECT_DIR | `audio-producer/` |
| GH_REPO | resolve via `gh repo view` in PROJECT_DIR (SynKounter org) |
| GH_ENV | *(empty)* |
| DEFAULT_BRANCH | `main` |
| PR_BASE | `qa` |
| ARCH_SPEC | `architecture-spec-v2.md` (workspace root) |
| FUNC_SPEC | workspace-root index + `audio-producer/docs/functional-specifications.md` (monolith format) |
| UIUX_SPEC | none (service — no UI) |
| TEST_CMDS | *(no test script — skip with a note)* |
| FLAGS | graphify=no · rules_tests=no · i18n=no · firebase=yes |
| STORIES_DIR | `features/{feature}/stories/` (Harness repo) |
| harness_companion_pr | yes |

## scenario-creator
| Variable | Value |
|---|---|
| PROJECT_DIR | `scenario-creator/` |
| GH_REPO | resolve via `gh repo view` in PROJECT_DIR (SynKounter org) |
| GH_ENV | *(empty)* |
| DEFAULT_BRANCH | `main` |
| PR_BASE | `qa` |
| ARCH_SPEC | `architecture-spec-v2.md` (workspace root) |
| FUNC_SPEC | workspace-root index + `scenario-creator/docs/functional-specifications.md` (monolith format) |
| UIUX_SPEC | none (service — no UI) |
| TEST_CMDS | `npm run typecheck` |
| FLAGS | graphify=no · rules_tests=no · i18n=no · firebase=yes |
| STORIES_DIR | `features/{feature}/stories/` (Harness repo) |
| harness_companion_pr | yes |

## microviber
| Variable | Value |
|---|---|
| PROJECT_DIR | `microviber/` |
| GH_REPO | `yarivsnapir/MicroViber` |
| GH_ENV | `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir` |
| DEFAULT_BRANCH | `main` |
| PR_BASE | `main` (no qa stage — story PRs target main and are squash-merged when CI is green) |
| ARCH_SPEC | `microviber/docs/architecture-spec.md` (threat model T1–T12 + engineering standards; the review judge for microviber code) |
| FUNC_SPEC | `microviber/docs/functional-spec.md` (single file — no index/area split) |
| UIUX_SPEC | none — `microviber/docs/functional-spec.md` UX section is the reference |
| TEST_CMDS | `npm run typecheck && npm run lint && npm test` (run in PROJECT_DIR) |
| FLAGS | graphify=no · rules_tests=no · i18n=no · firebase=no |
| STORIES_DIR | `docs/features/microviber/stories/` (Harness repo) |
| harness_companion_pr | yes |

## harness (the workspace meta-repo itself)
| Variable | Value |
|---|---|
| PROJECT_DIR | workspace root (`git rev-parse --show-toplevel` from any workspace-root file) |
| GH_REPO | resolve via `gh repo view` at workspace root |
| GH_ENV | *(empty)* |
| DEFAULT_BRANCH | detect: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — do NOT assume `main` (currently `initial-import`) |
| PR_BASE | same as DEFAULT_BRANCH |
```

- [ ] **Step 2: Add microviber to the Harness `CLAUDE.md` Projects Overview table** — one row: `| microviber/ | Node daemon + PWA (own public repo: yarivsnapir/MicroViber) | e.g. story/microviber-2 |`, plus one sentence under the table: "MicroViber uses its own GitHub identity — see `.claude/skills/_shared/projects.md` for per-project SDLC context (repos, branches, accounts, spec paths)."

- [ ] **Step 3: Verify + commit (Harness repo)**

```bash
ls .claude/skills/_shared/projects.md && grep -c "^## " .claude/skills/_shared/projects.md
git add .claude/skills/_shared/projects.md CLAUDE.md && git commit -m "feat(skills): project registry for project-aware SDLC skills; add microviber to CLAUDE.md"
```
Expected: grep count `6` (heading + 5 project sections).

---

### Task 8: Retire the two legacy duplicate skills

**Files:**
- Delete: `.claude/skills/spec-to-stories/` (320-line legacy near-duplicate of syncounter-spec-to-stories)
- Delete: `.claude/skills/story-driven-development/` (429-line legacy near-duplicate of syncounter-story-development)

Both are registered with the **same trigger phrases** as their syncounter- successors ("split into stories", "implement story", …), creating ambiguous skill resolution, and both are staler (no qa logic, hardcoded `Claude Sonnet 4.6` co-author, `cd studio` unconditional). Stale cross-references in the surviving skills are fixed in Tasks 9 and 12.

- [ ] **Step 1: Confirm they are unreferenced by anything other than the known stale pointers**

```bash
grep -rn "story-driven-development\|/spec-to-stories" .claude/skills/ CLAUDE.md | grep -v "syncounter-"
```
Expected output: only `syncounter-spec-to-stories/SKILL.md:385` (`Next: run /story-driven-development…`), the deleted skills' own self-references, and possibly this plan/spec. No other consumer.

- [ ] **Step 2: Delete and commit**

```bash
git rm -r .claude/skills/spec-to-stories .claude/skills/story-driven-development
git commit -m "chore(skills): retire legacy spec-to-stories + story-driven-development duplicates (syncounter-* versions are canonical)"
```

---

### Task 9: Generalize `syncounter-spec-to-stories`

**Files:**
- Modify: `.claude/skills/syncounter-spec-to-stories/SKILL.md` (398 lines)

**Interfaces:**
- Consumes: registry variables from Task 7 (`{PROJECT}`, `{GH_REPO}`, `{GH_ENV}`, `{PR_BASE}`, `{STORIES_DIR}`).

- [ ] **Step 1: Insert Step 0.5 after the skill's input-collection step:** a short section titled `## Step 0.5 — Resolve project context` whose body is: *"Read `.claude/skills/_shared/projects.md` and follow its Binding procedure for the target project(s). Bind: {PROJECT_DIR}, {GH_REPO}, {GH_ENV}, {PR_BASE}, {STORIES_DIR}. All later steps use these bindings."*

- [ ] **Step 2: Replace the hardcoded repo list, all 4 sites** (catalog refs — `:28` input menu, `:167-177` rule 8, `:248` frontmatter template, `:286-289` repo-slug resolution):
  - `:28` → `- **target project(s)** — one or more project keys from the registry (studio, audio-producer, scenario-creator, microviber)`
  - rule 8 → "changes in more than one of the registry's project repos"; the split rule itself is unchanged.
  - template frontmatter → `project: {one registry project key | multiple}`
  - repo-slug resolution → replace the three per-repo bullets with: "resolve `{GH_REPO}` per the registry (explicit value, or `{GH_ENV} gh repo view --json nameWithOwner -q .nameWithOwner` in `{PROJECT_DIR}`). For `multiple`, use the primary project's repo."

- [ ] **Step 3: Generalize the qa premise** (`:111`): "merged separately to `{PR_BASE}` (for Syncounter projects that's `qa`, later promoted to `main`; for microviber, `{PR_BASE}` is `main` directly) on its own schedule."

- [ ] **Step 4: Prefix all `gh` commands** (`:297-338`: label create, issue create/edit/close) with `{GH_ENV} ` and ensure each carries `--repo {GH_REPO}`.

- [ ] **Step 5: Fix the stale chain pointer** (`:385`): `Next: run /story-driven-development…` → `Next: run /syncounter-story-development for the first todo story.`

- [ ] **Step 6: Verify + commit**

```bash
grep -n "studio\`, \`audio-producer\`, \`scenario-creator" .claude/skills/syncounter-spec-to-stories/SKILL.md; grep -c "GH_ENV" .claude/skills/syncounter-spec-to-stories/SKILL.md; grep -n "run /story-driven-development" .claude/skills/syncounter-spec-to-stories/SKILL.md
git add .claude/skills/syncounter-spec-to-stories && git commit -m "feat(skills): syncounter-spec-to-stories resolves project context from registry"
```
Expected: first grep no output; second ≥ 4; third no output.

---

### Task 10: Generalize `syncounter-story-development`

**Files:**
- Modify: `.claude/skills/syncounter-story-development/SKILL.md` (509 lines)

- [ ] **Step 1: Insert Step 0.5** (same wording as Task 9 Step 1; bindings: `{PROJECT_DIR}`, `{GH_REPO}`, `{GH_ENV}`, `{PR_BASE}`, `{ARCH_SPEC}`, `{TEST_CMDS}`, flags). Note in it: *for issue-number-only input, {PROJECT} comes from the story frontmatter after Step 1a resolves the story; when only an issue URL is given, parse owner/repo from the URL and match it to a registry project.*

- [ ] **Step 2: Fix the unconditional `cd studio`** (`:33-34`): the issue-resolution command becomes `cd {PROJECT_DIR} && {GH_ENV} gh issue view {issue-number} --json title,body,labels`, with the note that `{PROJECT_DIR}` comes from Step 0.5 (or, for a bare issue number with unknown project, ask which project rather than defaulting to studio).

- [ ] **Step 3: Generalize the org example** (`:24`): `https://github.com/SynKounter/studio/issues/72` → add `or https://github.com/yarivsnapir/MicroViber/issues/7`.

- [ ] **Step 4: Gate Syncounter-only process steps on registry flags:** graphify refresh + symbol-impact + code-map steps (`:152-162`, `:179-192`, `:238-245`) get their "(studio only)" qualifier replaced with "(only when the registry flags `graphify=yes` for the project)"; Firestore migration rule (`:175`) and Firebase manual-test guidance (`:292-325`) gated on `firebase=yes`; the i18n rule (`:176`) on `i18n=yes`; the `components/ui/` + Tailwind conventions (`:248-263`) on the project having a UI (studio, microviber — phrase as "UI projects; check {UIUX_SPEC}/functional spec for the project's design reference").

- [ ] **Step 5: Generalize test commands** (`:341-357`, `:385-386`): replace literal `npm test` / `npm run typecheck` enumerations with "`{TEST_CMDS}` from the registry (plus any story-specific commands)"; keep the examples as *examples*, marked as such.

- [ ] **Step 6: Fix the `qa` mention** (`:454`): "branch off `{PR_BASE}` to land it separately, or".

- [ ] **Step 7: Verify + commit**

```bash
grep -n "cd studio" .claude/skills/syncounter-story-development/SKILL.md; grep -c "registry\|{GH_ENV}\|{PROJECT_DIR}" .claude/skills/syncounter-story-development/SKILL.md
git add .claude/skills/syncounter-story-development && git commit -m "feat(skills): syncounter-story-development is project-aware (registry bindings + flag-gated steps)"
```
Expected: first grep no output; second ≥ 10.

---

### Task 11: Generalize `syncounter-code-review`

**Files:**
- Modify: `.claude/skills/syncounter-code-review/SKILL.md` (489 lines)

- [ ] **Step 1: Insert Step 0.5** (bindings: `{PROJECT_DIR}`, `{GH_REPO}`, `{GH_ENV}`, `{PR_BASE}`, `{ARCH_SPEC}`, `{FUNC_SPEC}`, flags).

- [ ] **Step 2: Make the review judge project-relative.** Every `architecture-spec-v2.md` site (`:11`, `:64-67`, `:171-179`) becomes `{ARCH_SPEC}`. Keep the §16/Part-B/gap-ID instructions (`:69-76`, `:132-135`) but scope them: *"For Syncounter projects, {ARCH_SPEC} is architecture-spec-v2.md — apply §16 + the Part B gap register (record matched gap IDs, e.g. S16, A3′). For microviber, {ARCH_SPEC} is microviber/docs/architecture-spec.md — apply its threat model (T1–T12) and engineering-standards sections; there is no gap register."*

- [ ] **Step 3: Gate the Firestore review checklist** (`:83-96` projection/N+1 + fabricated defaults, `:136-143` security focus list): wrap under "firebase=yes projects only", and add the microviber counterpart list: *"For microviber: bearer-auth on every route, Host/Origin allowlists intact, no path outside `lib/claude-adapter/` touching `~/.claude/` or spawning `claude`, peerToken never serialized to clients, audit-log append on every injected prompt."* Gate graphify blast-radius steps (`:98-110`, `:163`) on `graphify=yes`.

- [ ] **Step 4: Fix the branch-model contradiction** (`:242`): `git diff main...story/{story-id}` → `git diff {PR_BASE}...story/{story-id}`. Update the `Closes`-keyword note (`:416-417`) to: "on microviber, PRs merge to `main` directly so `Closes #N` fires; on Syncounter's qa→main flow it gets lost — close issues explicitly either way."

- [ ] **Step 5: Make functional-spec update steps project-relative** (`:272-292`, `:342-363`): the repo-ledger location table keys off the registry `FUNC_SPEC` row (studio split format / services monolith / microviber single file `microviber/docs/functional-spec.md` — for microviber, Step 15a2's "workspace-root index" bullet is replaced by updating that single file, and Step 15b's architecture update targets `microviber/docs/architecture-spec.md`; both live in the **microviber repo**, so they're committed on the story branch, not a Harness branch).

- [ ] **Step 6: Account-safe issue close** (`:427`): `{GH_ENV} gh issue close {github_issue_number} --repo {GH_REPO} --comment "Story approved and merged on story/{story-id}"`. Keep the re-read-frontmatter guard (`:419-424`) unchanged.

- [ ] **Step 7: Verify + commit**

```bash
grep -n "architecture-spec-v2" .claude/skills/syncounter-code-review/SKILL.md | grep -v "Syncounter projects"; grep -n "diff main\.\.\." .claude/skills/syncounter-code-review/SKILL.md
git add .claude/skills/syncounter-code-review && git commit -m "feat(skills): syncounter-code-review judges against per-project specs; account-safe gh"
```
Expected: both greps no output.

---

### Task 12: Generalize `create-qa-pr`

**Files:**
- Modify: `.claude/skills/create-qa-pr/SKILL.md` (432 lines)

The name stays `create-qa-pr` (trigger phrases and chain references depend on it); its description gains "…or to the project's PR base branch (`main` for microviber)".

- [ ] **Step 1: Insert Step 0.5** (bindings: `{PROJECT_DIR}`, `{GH_REPO}`, `{GH_ENV}`, `{PR_BASE}`, `{TEST_CMDS}`, flags) and fix the scrub artifact at `:18` (dangling "multi-repo workspace at \`\`.") to "multi-repo workspace at the workspace root (the directory containing `CLAUDE.md` and `features/`)."

- [ ] **Step 2: Replace the project menu** (`:20`, `:48`, `:52`, description `:4-5`): valid projects = the registry's project keys; the AskUserQuestion fallback stays.

- [ ] **Step 3: Replace the per-repo test-command table** (`:67-79`) with: "Run `{TEST_CMDS}` from the registry for the project; if the registry marks no test script, skip with a note." Gate Step 2b Firestore-rules tests (`:90-113`) on `rules_tests=yes` and Step 16 graphify refresh (`:394-413`) on `graphify=yes`.

- [ ] **Step 4: Replace every literal `qa`** (12 sites: `:132-133`, `:147-149`, `:154`, `:156`, `:162-164`, `:189`, `:194`, `:247`, `:258`, `:295`, `:384`) with `{PR_BASE}`: rev-list/log comparisons against `origin/{PR_BASE}`, preconditions ("CURRENT_BRANCH is not {PR_BASE} or {DEFAULT_BRANCH}", "remote origin/{PR_BASE} exists", "BEHIND_{PR_BASE} is small"), `git checkout -b {NEW_BRANCH} origin/{PR_BASE}`, `gh pr create --base {PR_BASE}`, and the close-comment wording ("merged to {PR_BASE}").

- [ ] **Step 5: Generalize issue-URL parsing** (`:378-379`): "Extract owner/repo and issue number from the `github_issue:` URL (works for any host org — SynKounter/studio, yarivsnapir/MicroViber)". Prefix all `gh` commands (`:294-307`, `:325`, `:336`, `:383-385`) with `{GH_ENV}`.

- [ ] **Step 6: Add the microviber merge rule to the post-PR step:** for projects where `PR_BASE == DEFAULT_BRANCH` (microviber), after the PR is opened wait for CI (`{GH_ENV} gh pr checks {pr} --watch`) and squash-merge it (`{GH_ENV} gh pr merge {pr} --squash --delete-branch`); Syncounter qa PRs keep their existing no-merge behavior.

- [ ] **Step 7: Verify + commit**

```bash
grep -n "base qa\|origin/qa" .claude/skills/create-qa-pr/SKILL.md; grep -c "{PR_BASE}" .claude/skills/create-qa-pr/SKILL.md
git add .claude/skills/create-qa-pr && git commit -m "feat(skills): create-qa-pr targets the project's PR base from the registry"
```
Expected: first grep no output; second ≥ 10.

---

### Task 13: Fix `syncounter-harness-pr` (absolute-path bug + registry)

**Files:**
- Modify: `.claude/skills/syncounter-harness-pr/SKILL.md` (233 lines)

This skill hardcodes `/Users/yariv_s/Harness` in 20 places (`:15`, `:19-23`, `:48-76`, `:122-131`, `:145-146`, `:169`, `:183`, `:196-203`) — and this workspace is `Harness-2`, so its Step 1 assertion **fails today**. This is a bug fix as much as a generalization.

- [ ] **Step 1: Replace the absolute path everywhere** with a resolved `{HARNESS_ROOT}`: add to Step 1 — *"Resolve `HARNESS_ROOT` = the workspace root: the git toplevel (from any tracked workspace file, e.g. `git -C "$(dirname CLAUDE.md path)" rev-parse --show-toplevel`) whose tree contains `CLAUDE.md` and `features/`. Every subsequent command is prefixed `cd {HARNESS_ROOT} && `."* The `:52-53` assertion becomes: toplevel must contain `CLAUDE.md` + `features/` (not a literal path); drop the `SynKounter/Harness` remote expectation to "remote SHOULD be a Harness workspace repo".

- [ ] **Step 2: Generalize the gitignored-nested-repos safety list** (`:16-17`, `:149-152`): "the nested project repos listed in the registry (`studio/`, `audio-producer/`, `scenario-creator/`, `microviber/`) — confirm none of these path prefixes appear in the staged diff."

- [ ] **Step 3: Verify + commit**

```bash
grep -n "/Users/yariv_s" .claude/skills/syncounter-harness-pr/SKILL.md
git add .claude/skills/syncounter-harness-pr && git commit -m "fix(skills): syncounter-harness-pr resolves workspace root instead of hardcoded absolute path"
```
Expected: grep no output.

---

### Task 14: Generalize `syncounter-brainstorming`

**Files:**
- Modify: `.claude/skills/syncounter-brainstorming/SKILL.md` (145 lines)
- Modify: `.claude/skills/syncounter-brainstorming/spec-document-reviewer-prompt.md` (line 7 stale path)

- [ ] **Step 1: Insert Step 0.5** (bindings: `{ARCH_SPEC}`, `{FUNC_SPEC}`, `{UIUX_SPEC}`, `{PROJECT_DIR}`; note that brainstorming may span projects — bind per the feature's primary project, defaulting to the Syncounter set when the topic is a Syncounter feature).

- [ ] **Step 2: Make the required-context files project-relative** (`:26-31`, `:49`, `:63`, `:124`): required reading = `{ARCH_SPEC}` and `{FUNC_SPEC}` per registry. Keep the Syncounter specifics (Part B gap register, `Last reconciled:` ledger check against `studio/docs/functional-specs/*.md`, §16 flagging at `:47-48`) as a "Syncounter projects" block; add the microviber block: *"For microviber: `microviber/docs/architecture-spec.md` (threat model + integration contract — any feature touching transport, auth, or the claude-adapter must extend T1–T12) and `microviber/docs/functional-spec.md`."* The missing-file hard-stop (`:31`) stays, pointed at the registry paths.

- [ ] **Step 3: Gate the UI/UX requirement** (`:42`): "if `{UIUX_SPEC}` is `none`, the project's functional-spec UX section fills this role."

- [ ] **Step 4: Fix the reviewer-prompt stale path** (spec-document-reviewer-prompt.md:7): `docs/superpowers/specs/` → `features/<topic>/spec.md` (matching SKILL.md:100).

- [ ] **Step 5: Verify + commit**

```bash
grep -n "architecture-spec-v2" .claude/skills/syncounter-brainstorming/SKILL.md | grep -v Syncounter
git add .claude/skills/syncounter-brainstorming && git commit -m "feat(skills): syncounter-brainstorming loads per-project context from registry"
```
Expected: grep no output.

---

### Task 15: Generalize `syncounter-feature-status` + `syncounter-retrospective`

**Files:**
- Modify: `.claude/skills/syncounter-feature-status/SKILL.md` (239 lines)
- Modify: `.claude/skills/syncounter-retrospective/SKILL.md` (213 lines)

- [ ] **Step 1 (feature-status): registry-driven repo loop.** Replace both hardcoded loops (`:93-98` issues, `:142-146` PRs) with iteration over the registry's projects that have a GH_REPO, each command prefixed with that project's `{GH_ENV}` and carrying `--repo {GH_REPO}`; e.g. `{GH_ENV} gh issue list --repo {GH_REPO} --state all --limit 500 --json number,state,title,url > {scratchpad}/feature-status-{project}.json` (also moves the `/tmp` output to the session scratchpad). Update the prose sites (`:8`, `:76`, `:85-87`, `:136-137`, sample table `:188-189`) from "all three repos" to "all registry projects"; `qa` mentions (`:24`, `:219-220`) become `{PR_BASE}`. Fix the scrub artifact at `:234-235` (dangling ``(`{repo}`)``) to reference registry `{PROJECT_DIR}` values.

- [ ] **Step 2 (retrospective): widen the owning-skill map.** Add `create-qa-pr`, `syncounter-harness-pr`, and `syncounter-feature-status` to the owning-skill candidates (`:29-32`, `:88-91`) so PR-chain friction has an owner; fix the legacy supporting-skill aliases (`:92`) to the invoked names (`test-driven-development`, `verification-before-completion`, `systematic-debugging`, `requesting-code-review`, `receiving-code-review`, `superpowers:writing-plans`, `subagent-driven-development`); change "Syncounter workspace" (`:16`) to "this workspace (any registry project)".

- [ ] **Step 3: Verify + commit**

```bash
grep -n "studio audio-producer scenario-creator" .claude/skills/syncounter-feature-status/SKILL.md
git add .claude/skills/syncounter-feature-status .claude/skills/syncounter-retrospective && git commit -m "feat(skills): feature-status iterates registry projects; retrospective owns the PR chain"
```
Expected: grep no output.

---

### Task 16: Syncounter non-regression check (Phase 2 gate)

No files — a verification task. **Do not proceed to Phase 3 until all three pass.**

- [ ] **Step 1: Resolution dry-run.** For each of studio / scenario-creator / microviber, walk the edited `create-qa-pr` + `syncounter-code-review` texts and write down (in the task report) the resolved values of {PROJECT_DIR}, {GH_REPO}, {GH_ENV}, {PR_BASE}, {TEST_CMDS}, {ARCH_SPEC}. Expected: studio → `qa`, empty GH_ENV, `npm test`, `architecture-spec-v2.md`; scenario-creator → `qa`, `npm run typecheck`; microviber → `main`, `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir`, the triple test gate, `microviber/docs/architecture-spec.md`. Any deviation = fix the skill before continuing.

- [ ] **Step 2: Live read-only run.** Invoke `/syncounter-feature-status` and confirm: (a) it lists Syncounter features exactly as before (compare a couple of rows against `features/modular-encounter-studio/stories/README.md` statuses), (b) it now also reports the `microviber` feature, (c) the microviber `gh issue list` call ran with the GH_CONFIG_DIR prefix and did not error.

- [ ] **Step 3: Registry self-check.** `grep -rn "SynKounter/\|studio\`, \`audio-producer" .claude/skills/*/SKILL.md | grep -v "_shared\|example\|e.g."` — remaining hits must be inside explicitly-marked "Syncounter projects" conditional blocks or examples; anything operative = fix now.

---

## Phase 3 — Stories

Phase 3 tasks are **orchestration**: each story runs through the generalized skills, which produce their own story-level plans, tests, and reviews. A skill tripping on a leftover Syncounter assumption is a Phase 2 bug — fix the skill, then resume the story.

### Task 17: Reconcile stories 2–4 to the current code + create GitHub issues

**Files:**
- Modify: `docs/features/microviber/stories/story-2.md`, `story-3.md`, `story-4.md`, `stories/README.md`

- [ ] **Step 1: Establish the actual delta.** In `microviber/`: `git stash list`, `git status`, `git diff` (the story-2 WIP restored by Task 5), and `git log --oneline archive/dev-history -15`. For each of stories 2–4, list which acceptance criteria are already met by merged or WIP code (story 1 merged takeover-via-resume + HTTPS pairing; the WIP touches `api/app.ts`, `domain/registry.ts`, claude-adapter files and both test suites — likely story-2 routes).

- [ ] **Step 2: Rewrite the story files to the remaining delta.** Story 4 shrinks explicitly: Phase 1 already moved specs in-repo and rewrote README/INSTALL — story 4 becomes "final reconciliation of docs against the *shipped* stories 2–3 behavior + close out spec §13 open checkpoints." Update `stories/README.md`: drop the "no GitHub repo backs microviber" note; note that issues live on `yarivsnapir/MicroViber`.

- [ ] **Step 3: Create the issues (as yarivsnapir)**

```bash
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh label create "user-story" --repo yarivsnapir/MicroViber --color 5319E7 --description "SDLC user story" || true
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh issue create --repo yarivsnapir/MicroViber --label user-story --title "microviber-2: <story 2 title>" --body-file docs/features/microviber/stories/story-2.md
```
(repeat for stories 3 and 4), then write each returned URL into the story's `github_issue:` frontmatter and the README index table.

- [ ] **Step 4: Verify + commit (Harness)**

```bash
grep -c "github.com/yarivsnapir/MicroViber/issues" docs/features/microviber/stories/*.md
git add docs/features/microviber/stories && git commit -m "docs(microviber): reconcile stories 2-4 to shipped code; sync to GitHub issues"
```
Expected: 3 story files carry issue URLs.

### Task 18: Develop story 2 (daemon takeover/handback routes)

- [ ] **Step 1:** Invoke the `syncounter-story-development` skill with story-id `microviber-2`. It runs its own plan → TDD → implementation → review → `create-qa-pr` chain; the PR targets `main` of `yarivsnapir/MicroViber` and squash-merges on green CI (Task 12 Step 6 behavior). The existing WIP diff is the starting point — the story plan must triage it (keep/finish/drop), not blindly commit it.
- [ ] **Step 2:** After the chain completes, verify: story file `status: done`, issue closed, `{GH_ENV} gh pr list --repo yarivsnapir/MicroViber --state merged` shows the story PR, CI green on `main`.

### Task 19: Develop story 3 (PWA takeover composer gate)

- [ ] **Step 1:** Invoke `syncounter-story-development` with story-id `microviber-3`. Its manual-test checklist includes the physical-phone walkthrough — that pause is a genuine **USER CHECKPOINT** (phone in hand).
- [ ] **Step 2:** Same completion verification as Task 18 Step 2, for story 3.

### Task 20: Develop story 4 (docs reconciliation)

- [ ] **Step 1:** Invoke `syncounter-story-development` with story-id `microviber-4` (as reconciled in Task 17 — docs-only, reads shipped 2–3 behavior, updates `microviber/docs/*` + README status + spec §13 checkpoint closure).
- [ ] **Step 2:** Same completion verification, for story 4.

### Task 21: Track B — spec amendments (installability, dev-server browser, UX polish)

**Files:**
- Modify: `microviber/docs/functional-spec.md` (three new feature sections)
- Modify: `microviber/docs/architecture-spec.md` (dev-proxy threat-model extension)

- [ ] **Step 1: Invoke `syncounter-brainstorming`** for the Track B bundle (it now loads the microviber docs via the registry). The design constraints below are **already decided** (production-readiness spec §5) and are inputs, not open questions:
  - **PWA installability:** complete manifest (`display: standalone`, maskable 192/512 icons, `start_url`, `theme_color`/`background_color`), real app icon, service-worker installability criteria audited (start from the existing `pwa/public/manifest.webmanifest` + `sw.js`), in-app install button on `beforeinstallprompt`, iOS Add-to-Home-Screen guidance fallback. Acceptance: Chrome/Android installs a standalone app, not a bookmark.
  - **Embedded dev-server browser:** daemon reverse-proxy route to laptop-local dev servers; **port discovery = explicit per-folder mapping in daemon config** (e.g. `MV_DEV_SERVERS="<abs-folder>=<port>,..."`), **allowlist-only** (a request for an unmapped folder/port is rejected — never "any port the phone asks"); new threat entries (T13 proxy abuse, T14 untrusted dev-server content in the embedded pane — sandboxed iframe + CSP) added to the architecture spec; PWA gets a per-session "open dev server" pane for sessions whose cwd is mapped.
  - **UX polish:** app title bar, in-app icon, session list grouped by project folder (folder list → tap → that folder's sessions).
- [ ] **Step 2:** The brainstorm's design lands as amendments to the two docs files above (committed to `microviber` on a feature branch by the skill flow).

### Task 22: Track B — carve and develop the stories

- [ ] **Step 1:** Invoke `syncounter-spec-to-stories` for the Track B amendments → new `story-5.md`+ files under `docs/features/microviber/stories/` with issues on `yarivsnapir/MicroViber` (the skill's Step 0.5 handles repo + account).
- [ ] **Step 2:** For each new story in dependency order, invoke `syncounter-story-development` (same completion verification as Task 18 Step 2). Installability and dev-browser stories both end with physical-phone checks — **USER CHECKPOINTS**.

---

## Phase 4 — Production pass & go-public

### Task 23: Stranger test (fresh clone, agent-driven install)

- [ ] **Step 1: Fresh clone into the session scratchpad**

```bash
git clone https://github.com/yarivsnapir/MicroViber.git {scratchpad}/stranger-test/MicroViber
```
(If the repo is private per Task 6, prefix with `GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir` and clone via `gh repo clone`.)

- [ ] **Step 2: Dispatch a general-purpose subagent** with this brief: *"You are a brand-new MicroViber user. Working ONLY inside `{scratchpad}/stranger-test/MicroViber`, follow its INSTALL.md literally, stage by stage. Machine-safe scope: run Stages 0–4 but skip actual Tailscale installation if `tailscale status` shows it already configured (take the 'already have Tailscale' branch), and use `127.0.0.1` as the bind address for this test. STOP before Stage 5 (phone pairing). Report: every Verify that failed, every step where you had to guess or improvise, every ambiguity — with step numbers."*

- [ ] **Step 3: Fix every reported gap** in INSTALL.md/README (commit via a `docs/stranger-test-fixes` branch + PR to main per the normal flow), then re-run Steps 1–2 with a fresh subagent. Repeat until a run reports zero guesses and zero failed Verifies.

- [ ] **Step 4: Cleanup:** stop any daemon the test started (`./bin/microviberd stop` in the clone), delete the clone.

### Task 24: Physical-phone verification (USER CHECKPOINT) and go-public

- [ ] **Step 1: USER CHECKPOINT — phone walkthrough.** Ask the user to run INSTALL.md Stage 5 on their phone against their real daemon: pair, install the PWA (must install as a standalone app with the new icon — Track B acceptance), mirror a live session, take over an idle one, verify the laptop catches up via `/resume`. Wait for their pass/fail report; failures route back to the owning story.

- [ ] **Step 2: Go public + tag** (skip the visibility edit if Task 6 kept it public):

```bash
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh repo edit yarivsnapir/MicroViber --visibility public --accept-visibility-change-consequences
cd microviber && git checkout main && git pull && git tag -a v0.1.0 -m "MicroViber v0.1.0 — first public release" && GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir git push origin v0.1.0
GH_CONFIG_DIR=$HOME/.config/gh-yarivsnapir gh release create v0.1.0 --repo yarivsnapir/MicroViber --title "MicroViber v0.1.0" --generate-notes
```

- [ ] **Step 3: Final README status** — update the Status section to "v0.1.0 — installable, see INSTALL.md" (PR to main per the normal flow).

- [ ] **Step 4: Verify anonymous availability**

```bash
curl -s -o /dev/null -w "%{http_code}" https://github.com/yarivsnapir/MicroViber
curl -s https://raw.githubusercontent.com/yarivsnapir/MicroViber/main/LICENSE | head -1
```
Expected: `200` and `MIT License`.

- [ ] **Step 5: Close the loop in Harness:** update `docs/features/microviber/stories/README.md` statuses, run `/syncounter-retrospective` over this program, and open the Harness companion PR (`syncounter-harness-pr`) carrying the spec/plan/stories/skills changes.

---

## Task order & checkpoints summary

Sequential: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → (9, 10, 11, 12, 13, 14, 15 — independent, any order) → 16 (gate) → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24.

**USER CHECKPOINTS:** Task 1 (interactive `gh auth login`), Task 6 (visibility choice), Task 19 (phone manual test), Task 22 (Track B phone checks), Task 24 Step 1 (final phone walkthrough).
