---
id: microviber-track-b-3
title: Web pane UI — dropdown address bar + sandboxed iframe
status: todo
project: microviber
depends_on: [microviber-track-b-2]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/10
---

## User Story
As a **developer using MicroViber**, I want to tap the "Web" tab and browse the resolved dev server for my current session's folder right on my phone, so that I can check whether a change actually rendered without needing my laptop.

## Acceptance Criteria
1. The bottom pane switch's "Web · coming soon" placeholder is replaced with a real, tappable tab.
2. The Web pane shows a single persistent address bar with a dropdown (opened via the shared `CaretButton` — same style as the session picker's caret), listing: a client-side **Recent** history of full URLs/paths actually visited (capped at 10, most-recent-first, `localStorage`-backed), then a **Dev servers** list (one row per folder with a resolved port, format `<folder> · localhost:<port>`), deduped by folder, sourced from `/api/sessions`'s `devServerPort` field.
3. Tapping a "Dev servers" row mints a webpane token (`POST /api/webpane-token`) **before** navigating, then loads `/api/webpane/devserver/<port>/` in an iframe.
4. The iframe has `sandbox="allow-scripts allow-forms"` and explicitly **no** `allow-same-origin` — verified by inspecting the actual rendered DOM attribute, not just the source code. This is threat T15's mitigation: without it, a proxied dev server's own script would run with full same-origin access to this app's own bearer token and control-plane API.
5. A folder with no resolved dev server shows a clear empty state ("nothing configured") rather than a broken/blank pane.
6. Whichever server was last selected is remembered and shown collapsed the next time the Web pane is reopened.

## Affected Files
- `pwa/src/components/CaretButton.tsx` — new: the shared dropdown-trigger button (also consumed by story microviber-track-b-6).
- `pwa/src/components/WebPane.tsx` — new: address bar, dropdown, sandboxed iframe.
- `pwa/src/lib/api.ts` — adds `mintWebpaneToken`.
- `pwa/src/App.tsx` — wires `WebPane` into the pane switch.
- `pwa/src/components/states.tsx` — removes the "coming soon" label from the Web tab.
- `pwa/test/caret-button.test.tsx`, `pwa/test/webpane.test.tsx` — new.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 8 and 10. `CaretButton`'s exact signature (`{ open: boolean; onClick: () => void }`) must not change here — story microviber-track-b-6 depends on it being stable. This story does not yet wire transcript-link taps into the pane (that's story microviber-track-b-4) — the `navigateWebPane` module-level function this story exports exists specifically so that later story can call it without prop-drilling.

**Flagged by microviber-track-b-2's final review — verify before building the pane, not after a silent failure:** `mv_webpane`'s cookie attribute is `SameSite=Strict` (spec §7, T14 mitigation). A `sandbox="allow-scripts allow-forms"` iframe with no `allow-same-origin` forces the framed document into a unique **opaque** origin, so its "site for cookies" is null and every request it initiates is treated as cross-site. The iframe's own initial navigation (initiated by the parent) still carries the cookie, but any subresource that framed page requests itself — `/api/webpane/devserver/<port>/app.js`, `.css`, images, its own `fetch()` calls — will NOT carry a `SameSite=Strict` cookie and will 401 at the daemon's auth hook. Net effect if unaddressed: a single self-contained local HTML file (AC/§3 "Local file viewing") likely still works, but a real proxied dev server (React/Vite/etc. with separate JS/CSS bundle requests) renders blank or badly broken — indistinguishable from AC5's "nothing configured" empty state unless you check the network tab. **Verify this on a real device against a real multi-asset dev server before considering AC3/AC4 done.** If it reproduces, the fix likely belongs in spec §7's T14 mitigation itself (e.g. relaxing to `SameSite=None; Secure`, whose CSRF exposure is still bounded by the existing `Path=/api/webpane/` scoping, the single-resource capability, and the 5-minute TTL) — treat that as a spec amendment to flag during this story's brainstorming/planning, not a silent workaround.

**Also flagged by microviber-track-b-2's code review — deliberately deferred, not fixed there, but load-bearing once this story puts a real browser on the path:** `services.ts`'s `listResolvedDevServerPorts()` calls `listSessions()`, which runs a full synchronous session-discovery scan (stat + read of every `~/.claude/sessions/*.json`, liveness checks, transcript-meta reads, plus per-session dev-server-port resolution — up to ~7 sync file ops each). This now runs once per proxied request through `/api/webpane/devserver/:port/*`, not once per poll cycle. A real dev-server page load is dozens of asset requests in a couple of seconds, so this story is the first to actually exercise that hot path with a real multi-asset app instead of a single stubbed test request. If the pane feels sluggish or the daemon's CPU spikes while a dev server is open, this is the first thing to check — a short-TTL (e.g. ~200ms) memo on `listResolvedDevServerPorts()`'s result would collapse an asset burst into one scan. Not required for this story's own ACs, but worth a quick real-device check before closing it out.

**Also flagged: frame-control headers and relative redirects from the proxied dev server are not yet handled.** The proxy currently forwards a dev server's response as-is (after stripping hop-by-hop and encoding headers). Two things worth checking once real dev servers are proxied: (1) a dev server that sends `X-Frame-Options: DENY` or a restrictive `frame-ancestors` CSP will render this story's iframe blank — indistinguishable from AC5's "nothing configured" empty state unless the network tab is checked; consider stripping these on the daemon side if it turns out to be common. (2) a dev server's `Location` redirect header (e.g. after a login flow, or Vite's dev-server redirects) will contain a `http://127.0.0.1:<port>/...` URL that the phone's browser cannot follow directly — it would need rewriting to go back through `/api/webpane/devserver/<port>/...` before being relayed.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] On a phone (or a narrow browser window) paired to a real daemon, open a session whose folder has a resolved dev server, tap the Web tab, tap the caret, confirm the dev server row appears and tapping it loads real content in the pane.
- [ ] Inspect the loaded iframe's `sandbox` attribute in devtools — confirm it reads exactly `allow-scripts allow-forms` with no `allow-same-origin`.
- [ ] Confirm a folder with nothing configured shows the empty state, not a blank/broken pane.
- [ ] Close and reopen the Web pane — confirm the last-selected server is shown again automatically.
