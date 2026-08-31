---
id: microviber-track-b-4
title: Transcript link handling — local vs external routing
status: done
project: microviber
depends_on: [microviber-track-b-3]
complexity: S
github_issue: https://github.com/yarivsnapir/MicroViber/issues/11
---

## User Story
As a **developer reading a transcript on MicroViber**, I want links the agent outputs to do the right thing when I tap them — open a local file or dev-server address inside the app, or open an external link (like a GitHub PR) in my phone's own browser — so that I don't lose my place in the app for links that could stay inside it.

## Acceptance Criteria
1. `classifyLink(href, sessionCwd)` classifies: `file://` URIs and bare filesystem paths (absolute or relative) as `localfile`; `http(s)://localhost` or `http(s)://127.0.0.1` addresses (any scheme) as `devserver`, preserving the port and path; anything else `http(s)://` as `external`.
2. A relative bare path (no leading `/`, no `file://`) resolves against the originating session's `cwd` before being used.
3. A local link's tap is intercepted (no default browser navigation) and routed into the Web pane (story microviber-track-b-3) via `navigateWebPane` — a `devserver` link preserves its own path (unlike the dropdown's "Dev servers" row, which always lands on root) but still goes through the same port-allowlist check (T13) as every other entry into the proxy.
4. An external link renders as a normal `<a target="_blank" rel="noopener noreferrer">` and is untouched by the classification/interception logic — it opens in the phone's own browser exactly like any other web link.
5. **(Added during manual testing, absorbed into this story rather than carved out — see below.)** The Web pane exposes a Back control whenever it has any target open (a transcript link tap, a dropdown pick, or an in-devserver path edit — visibility does not depend on whether the back-stack itself has an entry, since that gate raced the mount-time restore's async token mint and could leave Back missing even with a dev server genuinely open). Back restores the previous target and re-mints its token; if the stack is empty it closes the pane instead of doing nothing. The stack is per-mount only (not persisted across reloads, like a browser tab's own back button), lives in a ref rather than React state (a setState updater running the restore's network call was found to double-mint under StrictMode), and a failed restore keeps its entry so a retry is still possible instead of silently discarding it.

## Scope note (2026-08-30)
Manual testing of this story's own acceptance criteria (tapping a local link into the Web pane) surfaced that the pane had no way to return to whatever was open before the tap — a `WebPane.tsx` gap from story microviber-track-b-3, not a regression in this story's own files. Discussed with the user; decision was to absorb it into this story as acceptance criterion 5 rather than carve a separate story, since it was found while testing this story's own tap-to-navigate flow. Implementing it also surfaced and fixed a real, pre-existing bug in `WebPane.tsx`: `externalNavigate` (the function `navigateWebPane` calls) was assigned inside a mount-only (`[]`-dep) `useEffect`, permanently closing over the FIRST render's `go`/`current` — so a transcript-link-tap navigation could never see the pane's actual current target. Fixed with a ref that always points at the latest `go`. A second manual-testing round found Back still sometimes missing (a race between the mount-time restore's async mint and an early tap); resolved by dropping the "does history have an entry" visibility gate entirely, per the user's own suggestion.

## Code review note (2026-08-31)
The formal code + security review (post-manual-testing) found and fixed: (a) `goBack`'s side effects ran inside a `setHistory` updater, which this app's `StrictMode` wrapper double-invokes — moved the stack to a `useRef` and made `go()` report success/failure so a failed restore no longer silently drops its history entry; (b) `shouldIntercept` (case-insensitive scheme check) and `classifyLink` (previously case-sensitive) disagreed on casing, so an uppercase-scheme or protocol-relative external URL fell into the bare-path branch and was misclassified as `localfile` instead of `external` — both are now case-insensitive and protocol-relative URLs classify as `external`; (c) added `rel="noopener noreferrer"` to the intercepted-link anchor too (its href is still live via long-press/middle-click) and scoped `urlTransform`'s `file://` allowance to the `href` attribute only, not every URL-bearing attribute; (d) added a second, independent `javascript:`/`data:`/`vbscript:` denylist local to the anchor-rendering code as defense-in-depth. The review also flagged a genuine, accepted threat-model widening — transcript content (untrusted model output) now selects which local file gets read by one tap — recorded in `docs/architecture-spec.md` T9/T11/T16/T7 rather than left undocumented.

## Affected Files
- `pwa/src/lib/link-classify.ts` — new: `classifyLink`.
- `pwa/src/lib/markdown.tsx` — link-rendering override, routes local vs external; explicit link color (manual-test finding: `prose-invert` is a no-op, `@tailwindcss/typography` isn't installed).
- `pwa/src/components/Transcript.tsx` — threads `sessionCwd` through to `SafeMarkdown`.
- `pwa/src/App.tsx` — passes `current?.cwd` into `Transcript`; subscribes to `subscribeWebPaneRequests` to switch to the Web pane on a link tap.
- `pwa/src/components/WebPane.tsx` — AC5: back-stack + Back button; fixes the `externalNavigate` stale-closure bug described above.
- `pwa/test/link-classify.test.ts`, `pwa/test/transcript-links.test.tsx`, `pwa/test/app-webpane-switch.test.tsx` — new.
- `pwa/test/markdown-safety.test.tsx`, `pwa/test/webpane.test.tsx` — extended.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 9 and 11. Depends on story microviber-track-b-3 for `navigateWebPane` and the Web pane itself to exist — a local link has nowhere to route to before that ships.

## Manual Test Checklist
- [x] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [x] In a real session's transcript, get the agent to output a markdown link to a local file (e.g. a spec or mockup file) and one to `http://localhost:<a resolved port>/some/path`; tap each and confirm they open in the Web pane at the correct target (the devserver link's path is preserved, not collapsed to root).
- [x] Get the agent to output a link to a real external URL (e.g. a GitHub PR); tap it and confirm it opens in the phone's system browser, not inside the app.
- [x] Confirm a devserver link to a port that isn't currently resolved for any known folder is refused (falls back to the pane's empty state) rather than silently proxying.
- [x] With a dev server already open in the Web pane, get the agent to output a local-file link and tap it; confirm a Back button now appears and tapping it returns to the dev server that was open before.
