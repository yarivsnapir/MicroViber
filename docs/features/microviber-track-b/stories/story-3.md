---
id: microviber-track-b-3
title: Web pane UI — dropdown address bar + sandboxed iframe
status: in-progress
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

## Design Change (2026-08-30, approved during manual testing) — supersedes AC3/AC4's literal text

Real-device testing proved the original design (same-origin iframe src, `sandbox="allow-scripts allow-forms"`, no `allow-same-origin`) structurally cannot render a real app: the opaque origin it creates is banned by the browser from `localStorage`/`sessionStorage`/IndexedDB (Firebase auth crashes on init) and treats every subresource and `fetch` as cross-site. After the SameSite, Origin-allowlist, and Origin-forwarding fixes each peeled off one layer, the storage ban remained — it is browser behavior, not fixable server-side.

**Shipped model — origin separation instead of opaque-origin sandboxing:** dev-server content loads from a dedicated CONTENT origin (same hostname, second tailscale-served HTTPS port, `MV_WEBPANE_CONTENT_PORT` default 8443 — INSTALL.md Step 4.3b) in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin"`. The daemon proxies **every** path on that origin to the port the `mv_webpane` cookie is bound to (the cookie is the routing key), so absolute asset paths, the framed app's own `/api/*`, and redirects all work; the daemon's own API is structurally unreachable there. Local files keep the original opaque-origin sandbox (plus the server-side `CSP: sandbox` backstop) — an arbitrary file must never run same-origin with anything. Full rationale and residual-risk analysis: `docs/architecture-spec.md` T15.

- **AC3 (amended):** tapping a Dev servers row mints the token first, then loads `https://<host>:8443/` (the content origin root) — not `/api/webpane/devserver/<port>/`.
- **AC4 (amended):** the dev-server iframe's sandbox is exactly `allow-scripts allow-forms allow-same-origin`, safe because the src is the separate content origin; the localfile iframe (a later story's surface) keeps `allow-scripts allow-forms` with no `allow-same-origin`.

## Implementation Follow-ups (from this story's own final review)

Recorded here rather than silently dropped, per this workspace's SDLC process. Neither blocks this story's ACs; both are candidates for a future story/task, not this one:

- **Minor, dev-only:** `WebPane`'s mount effect can double-mint a webpane token under React 19 `StrictMode`'s dev-only double-invoke (mount → cleanup → mount) when restoring a last-selected/pending target. Functionally harmless — the daemon's `WebpaneTokenStore.mint` issues a fresh, independent token per call with no invalidation of prior ones — and stripped entirely in production builds. Not exercised by any test (RTL's `render` doesn't wrap in `StrictMode`).
- **Important, deferred as a follow-up, not fixed here:** there are three independent, currently indistinguishable causes of a blank/broken Web pane iframe — this story's own AC5 "nothing configured" empty state, a dev server sending `X-Frame-Options`/a restrictive CSP `frame-ancestors` (already flagged above, pre-existing), and an expired `mv_webpane` cookie on restore (this story now re-mints on restore per AC6, but a mint can still fail e.g. if the port left the live allowlist between visits). An `onLoad`/`onError` handler on the iframe with a visible "couldn't load — tap to retry" overlay was recommended by final review to make these distinguishable without needing devtools on a phone. Worth a small follow-up story/task.
- Task 5 below (the `SameSite=Strict`/opaque-origin verification) was amended after final review to require testing over the project's Tailscale HTTPS name specifically, not `localhost` or a bare LAN IP — see `docs/features/microviber-track-b/stories/story-3-plan.md` Task 5 for the reasoning (a plain-HTTP/LAN test can't distinguish the `SameSite` question from an unrelated `Secure`-cookie/transport mismatch).

### Deferred from code review (2026-08-30)

Raised during the consolidated code-review + security-review pass; each is a candidate for its own future story, not fixed in this security-hardening pass:

- **Streaming proxy:** the content plane buffers whole responses via `arrayBuffer()` (`proxyToLoopback`) before relaying. Fine for normal apps, but an SSE/long-poll endpoint a framed app opens will hang the request and grow the buffer unboundedly (the 10MB cap is request-side only). Follow-up: stream upstream → `reply.raw`, reconciled with the body cap.
- **De-hardcode the content port:** `8443` is hardcoded in three places — `config.ts` (default), `WebPane.tsx` (`WEBPANE_CONTENT_PORT`), and `pwa/index.html` (`frame-src`). Follow-up: expose the resolved content port via `/api/health` and consume it in the PWA; then narrow `pwa/index.html`'s `frame-src https://*.ts.net:8443` (any tailnet host) to the specific host.
- **WebPane cosmetics:** the `activeSessionCwd` prop is accepted but unused; the empty state says "this folder" while the dev-server list actually spans all sessions; and there's a brief empty-state flash before the async last-target restore completes on first paint.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] On a phone (or a narrow browser window) paired to a real daemon **over the project's Tailscale HTTPS name, not `localhost`** (see `story-3-plan.md` Task 5 for why), open a session whose folder has a resolved dev server, tap the Web tab, tap the caret, confirm the dev server row appears and tapping it loads real content in the pane.
- [ ] Inspect the loaded iframe in devtools — confirm its `src` is on the content origin (`https://<host>:8443/...`, NOT the main origin) and its `sandbox` reads exactly `allow-scripts allow-forms allow-same-origin` (see the Design Change section above — `allow-same-origin` is safe only because the src is the separate content origin).
- [ ] Confirm a folder with nothing configured shows the empty state, not a blank/broken pane.
- [ ] Close and reopen the Web pane — confirm the last-selected server is shown again automatically, and that a valid session actually re-renders content (not just the address-bar label) after a few minutes' gap (this exercises the AC6 restore-and-re-mint path added during this story's final review).
- [ ] Task 5's original question is RESOLVED — the flagged `SameSite=Strict`/opaque-origin failure reproduced on a real device exactly as predicted (initial document loaded, every asset 401'd, then even with cookies fixed the opaque origin's storage ban crashed Firebase before first paint), and the fix landed as the Design Change above (second-origin model). What remains for a human: against a real multi-asset dev server (studio) over the Tailscale HTTPS name, confirm the page fully hydrates and is interactive inside the pane — no 401s in the network tab, no `SecurityError` in the console — i.e. the redesign actually delivers "same page as the laptop", not just static HTML.
