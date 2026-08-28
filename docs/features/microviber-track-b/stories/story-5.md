---
id: microviber-track-b-5
title: Title bar + PWA install button
status: todo
project: microviber
depends_on: []
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/12
---

## User Story
As a **developer visiting MicroViber in a browser**, I want a real app identity (icon + name) and a one-tap install button, so that I can recognize the app and add it to my home screen as a real standalone PWA rather than a browser bookmark.

## Acceptance Criteria
1. `manifest.webmanifest` has `icons` for `192x192` and `512x512` with `purpose: "any maskable"`, `display: "standalone"`, `start_url: "/"`, matching the already-delivered art at `pwa/public/icon-192.png` and `pwa/public/icon-512.png` (flat in `public/`, not under an `icons/` subdirectory).
2. `index.html` links `apple-touch-icon.png` and `favicon.png` (already delivered at `pwa/public/`) via `<link>` tags.
3. A new title bar renders at the very top of the app shell — visible on every screen (pairing, empty state, session view, Web pane) — showing the app icon and "MICROVIBER" wordmark.
4. An install button appears in the title bar **only** when `beforeinstallprompt` has fired and captured, **and** `display-mode: standalone` is not already active (both conditions, not just one) — no button on iOS Safari (the event never fires there) and no button once already installed.
5. Tapping the install button calls `.prompt()` on the captured event.

## Affected Files
- `pwa/public/manifest.webmanifest` — full icon list replacing the `icons: []` stub.
- `pwa/index.html` — apple-touch-icon and favicon `<link>` tags.
- `pwa/src/lib/install-prompt.ts` — new: `captureInstallPrompt`.
- `pwa/src/components/TitleBar.tsx` — new.
- `pwa/src/App.tsx` — wires `TitleBar` into `Shell`.
- `pwa/test/manifest.test.ts`, `pwa/test/install-prompt.test.ts`, `pwa/test/title-bar.test.tsx` — new.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Task 12 and 13. **Icon art is already delivered** (as of 2026-08-28) at `pwa/public/icon-192.png`, `pwa/public/icon-512.png`, `pwa/public/apple-touch-icon.png`, `pwa/public/favicon.png` — this story only wires them in, no art to source. Per `docs/features/microviber-track-b/spec.md` §9, iOS gets **no** install detection/fallback UI at all — Android/Chrome only, by explicit decision.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Load the app in Chrome on Android (or desktop Chrome with mobile emulation): confirm the title bar shows the icon + wordmark on every screen (pairing screen, empty state, a real session).
- [ ] Confirm the install button appears in the title bar, tapping it triggers the real browser install prompt, and the button disappears once installed (reload in standalone mode).
- [ ] Confirm no install button ever appears on iOS Safari.
- [ ] Confirm the manifest is valid (Chrome DevTools → Application → Manifest shows no errors) and the app installs as a real standalone app, not a bookmark.
