---
id: microviber-track-b-4
title: Transcript link handling — local vs external routing
status: todo
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

## Affected Files
- `pwa/src/lib/link-classify.ts` — new: `classifyLink`.
- `pwa/src/lib/markdown.tsx` — link-rendering override, routes local vs external.
- `pwa/src/components/Transcript.tsx` — threads `sessionCwd` through to `SafeMarkdown`.
- `pwa/src/App.tsx` — passes `current?.cwd` into `Transcript`.
- `pwa/test/link-classify.test.ts`, `pwa/test/transcript-links.test.tsx` — new.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 9 and 11. Depends on story microviber-track-b-3 for `navigateWebPane` and the Web pane itself to exist — a local link has nowhere to route to before that ships.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] In a real session's transcript, get the agent to output a markdown link to a local file (e.g. a spec or mockup file) and one to `http://localhost:<a resolved port>/some/path`; tap each and confirm they open in the Web pane at the correct target (the devserver link's path is preserved, not collapsed to root).
- [ ] Get the agent to output a link to a real external URL (e.g. a GitHub PR); tap it and confirm it opens in the phone's system browser, not inside the app.
- [ ] Confirm a devserver link to a port that isn't currently resolved for any known folder is refused (falls back to the pane's empty state) rather than silently proxying.
