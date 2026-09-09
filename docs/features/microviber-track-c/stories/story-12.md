---
id: microviber-track-c-12
title: One known-folder set that both the spawn gate and the pickers use
status: todo
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/58
---

## User Story
As a **developer picking where to start a terminal or a new session from my phone**, I want **the folder list I am offered to be exactly the set the daemon will accept**, so that **no row I can tap fails with a 403**.

## Acceptance Criteria
1. `listKnownFolders(): string[]` on the services layer returns every live session's `cwd` **plus** the immediate child directories `lib/webpane/port-resolver.ts` already scans for dev servers.
2. It is **re-derived per request, never cached** — modelled on T14's `listResolvedDevServerPorts()` gate.
3. It introduces **no new configuration** and **no filesystem reach beyond what the Web pane already has**. It reuses the port resolver's existing one-level child scan rather than adding a second walker.
4. `GET /api/folders` returns `{ path, name, hasSession }[]` derived from `listKnownFolders()`, bearer-authenticated on the control plane, using the existing error envelope.
5. `hasSession` is true when the folder is itself a live session's `cwd`, false for a child directory that merely exists.
6. **The route and the future spawn gate call the same function.** A test asserts that, so a picker can never offer a folder the gate would reject. Divergence between the two is the defect this story exists to prevent.
7. The reader follows T13/T14 discipline, since it walks directories the user's own projects control: `readdirSync` with `withFileTypes`, symlinked entries excluded rather than followed, and a bounded child count.
8. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/services/services.ts` — `listKnownFolders()`.
- `daemon/src/api/app.ts` — `GET /api/folders`.
- `daemon/src/schemas/api.ts` — the response shape.
- `daemon/test/services.test.ts` — the shared-source assertion (AC6), `hasSession` derivation.
- `daemon/test/app.test.ts` — route auth, envelope, shape.

## Technical Notes
**Why a new endpoint rather than reusing what exists.** Both pickers need folders with **no** existing session — a child directory like `studio/` under a workspace-root session is the common case. Neither existing source can supply that:
- `GET /api/sessions` cannot: `SessionPicker.tsx`'s "Browse by folder" view groups session `cwd` values client-side, so by construction it only shows folders that already *have* a session.
- `SessionSummary.devServerPorts` cannot: it lists only folders that resolved a port.

**What this bounds, stated honestly.** It bounds where a shell *starts*. It does not bound where it can *go* — `cd /` is the first thing anyone can type. This is a guard against a malformed or hostile `cwd` reaching `spawn`, not a containment boundary, and it must not be described as one anywhere in the code or docs. `spec.md` §2.4 and threat row T18 both say so; keep it that way.

**No `SessionSummary` change.** T9 makes that an explicit field allowlist. This is a separate endpoint, not a new field on an existing response.

**Independent of the terminal core.** This story touches no PTY code and can ship before or after story 11. It is a dependency of story 13 (the spawn gate) and story 19 (Feature B's picker), not of story 11.

## Manual Test Checklist
- [ ] `story-12-check.sh`: runs the gate, then curls `GET /api/folders` with a real bearer (loaded from the token file, never printed) and prints the returned rows in a table with `hasSession`. Assert the folder you are actually working in appears, and that at least one child directory with no session of its own appears — that second row is the whole point of the endpoint.
- [ ] The script must also assert the negative: an unauthenticated request gets the standard 401 envelope.
