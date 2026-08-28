---
id: microviber-track-b-1
title: Dev-server port resolution & devports.json config
status: done
project: microviber
depends_on: []
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/8
---

## User Story
As the **MicroViber daemon**, I want to resolve a dev-server port for each known session folder through a best-effort, explicit-first chain (project `.env` → `microviber/devports.json` → static config scan), so that later stories can offer a "Web pane" for browsing that folder's dev server without guessing blindly or requiring a running-process scan.

## Acceptance Criteria
1. `loadDevportsConfig(path)` returns `{}` when `microviber/devports.json` doesn't exist (it's optional), and throws on malformed JSON or a schema violation (fail closed — a typo must not silently resolve to "no config").
2. `resolveDevServerPort(cwd, devports)` resolves in this precedence, first match wins: (1) a `PORT=<n>` line in `<cwd>/.env`, read as plain text — never imported/executed; (2) `devports[cwd].port` from the full-absolute-path-keyed config; (3) a non-executing regex scan of `vite.config.*` / `angular.json` / `webpack.config.*` / `package.json` scripts for a `port:` field or `--port` flag.
3. A config file that would throw if imported/executed does not crash resolution when scanned as tier 3 — the scan is provably text-only.
4. Every currently-discovered `SessionSummary` gains a `devServerPort: number | null` field, populated once per `listSessions()` call using the resolver above.
5. `pwa/src/lib/types.ts`'s `SessionSummary` is corrected to match the daemon's shape exactly: adds `devServerPort: number | null`, and also adds the previously-missing `takenOver: boolean` (a pre-existing drift from Track A — the daemon's `SessionSummary` already had it, the PWA type never did).

## Affected Files
- `daemon/src/lib/webpane/devports-config.ts` — new: `devports.json` loader/validator.
- `daemon/src/lib/webpane/port-resolver.ts` — new: the 3-tier resolver.
- `daemon/src/domain/registry.ts` — `SessionSummary`/`buildSummary` gain `devServerPort`.
- `daemon/src/services/services.ts` — loads `devports.json` once at `createServices` time, calls the resolver per folder inside `listSessions`.
- `pwa/src/lib/types.ts` — `SessionSummary` gains `devServerPort` and the missing `takenOver`.
- `daemon/test/webpane/devports-config.test.ts`, `daemon/test/webpane/port-resolver.test.ts` — new.
- `daemon/test/registry.test.ts` — extended.

## Technical Notes
Full implementation detail (real code, TDD steps) lives in `docs/features/microviber-track-b/plan.md` Tasks 1-3. This is a deliberate, documented deviation from `production-readiness.md`'s original "explicit config only, no auto-detection" constraint — spec.md §9 records why (tiers 1/3 read project-controlled content; accepted as threat T13's residual risk, since a fourth "runtime verification" tier was considered and explicitly dropped).

This story is backend-only — no PWA UI reads `devServerPort` yet (that's story microviber-track-b-3). Per spec-to-stories rule 4, verify manually via script rather than the UI (there is none yet).

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Verification script: with the daemon running against a real project folder that has a `.env` with `PORT=9005`, call `GET /api/sessions` (with a valid bearer token) and confirm the matching session's `devServerPort` is `9005`.
- [ ] Add an entry to a scratch `microviber/devports.json` for a folder with no `.env` PORT line, confirm `devServerPort` resolves from it instead.
- [ ] Confirm a folder with neither `.env` PORT nor a `devports.json` entry nor a recognizable `vite.config`/`package.json` port shows `devServerPort: null`.
