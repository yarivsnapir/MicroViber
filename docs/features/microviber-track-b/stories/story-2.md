---
id: microviber-track-b-2
title: Web pane backend — shared cookie auth, dev-server proxy, local file route
status: in-progress
project: microviber
depends_on: [microviber-track-b-1]
complexity: L
github_issue: https://github.com/yarivsnapir/MicroViber/issues/9
---

## User Story
As the **MicroViber daemon**, I want a same-origin reverse-proxy route to a resolved dev-server port and a route that serves an arbitrary local file, both authenticated through a mechanism an `<iframe src>` can actually use, so that a later PWA story can embed either kind of content in a "Web pane" without exposing the daemon's main bearer token to framed content.

## Acceptance Criteria
1. `POST /api/webpane-token` requires the normal bearer header (no exceptions, ever) and, on success, sets `Set-Cookie: mv_webpane=<opaque>; Path=/api/webpane/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`, scoped to exactly the one resource (a port or a path) it was minted for.
2. The daemon's global bearer-auth hook gains exactly one narrow exception: `/api/webpane/devserver/*` and `/api/webpane/localfile` accept the `mv_webpane` cookie in place of the header; every other route (including `/api/webpane-token` itself) still requires the real header, unchanged.
3. `GET/POST/etc. /api/webpane/devserver/:port/*` reverse-proxies to `http://127.0.0.1:<port>/*` — target host is hardcoded to loopback, never configurable — **only** when `:port` is currently in the live resolved-port set (from story microviber-track-b-1's resolver); otherwise 403 `FORBIDDEN`. This is the T13 allowlist check.
4. `GET /api/webpane/localfile?path=<path>` reads and returns the file's bytes with a content-type guessed from its extension (`.html`→`text/html`, `.md`→`text/markdown`, images, `.pdf`, else `application/octet-stream`) — **no folder restriction**, any path the daemon process can read is servable. This is threat T16's explicit, deliberate accepted risk (see spec.md §9) — do not add a folder allowlist back in.
5. A minted token/cookie validates only against the exact resource (port or path) it was minted for, and expires 5 minutes after issuance.

## Affected Files
- `daemon/src/lib/webpane/webpane-auth.ts` — new: `WebpaneTokenStore`, `parseCookieHeader`, `resourceKey`.
- `daemon/src/lib/webpane/proxy.ts` — new: `proxyToLoopback`.
- `daemon/src/lib/webpane/local-file.ts` — new: `readLocalFile` + content-type table.
- `daemon/src/api/app.ts` — three new routes, the auth-hook cookie carve-out, `AppDeps` extensions.
- `daemon/src/services/services.ts` — wires the new `lib/webpane/` functions into `AppDeps`.
- `daemon/src/schemas/api.ts` — `WebpaneTokenBody` schema.
- `daemon/test/webpane/webpane-auth.test.ts`, `daemon/test/webpane/proxy.test.ts`, `daemon/test/webpane/local-file.test.ts` — new.
- `daemon/test/app.test.ts` — extended with route + auth-carve-out tests.

## Technical Notes
Full implementation (real code, TDD steps) is in `docs/features/microviber-track-b/plan.md` Tasks 4-7. Two threat-model rows this story must satisfy exactly as written in `docs/features/microviber-track-b/spec.md` §7 and re-verified here:
- **T14** (the cookie reopens CSRF surface T4 was written to prevent) — mitigated by `SameSite=Strict` + `Path=/api/webpane/` scoping + the narrow per-resource capability. Verify all three properties are present on the actual `Set-Cookie` header, not just asserted in a comment.
- **T13** (proxy steered to an unintended service) — mitigated by the hardcoded-loopback target and the live-resolved-port allowlist check. Verify the 403 path with a port deliberately not in the resolved set.

This story is backend-only — no PWA code calls these routes yet (that's story microviber-track-b-3). Note (spec-to-stories rule 4): verify via script, not UI.

**Deferred from story microviber-track-b-1's code/security review:** `resolveDevServerPort` re-runs its full filesystem scan (up to ~7 sync file ops) on every `listSessions()` call, and this story's AC3 403-allowlist check (`listResolvedDevServerPorts()`) calls `listSessions()` again on every proxied request/poll — the resolution cost is no longer amortized across a single poll cycle once this story lands. Consider a per-`cwd` memo (short TTL or mtime-keyed) in `daemon/src/lib/webpane/` before or as part of this story, rather than letting the proxy's hot path re-stat every candidate config file per request.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Verification script: `POST /api/webpane-token` with a real bearer token and `{"kind":"devserver","port":<a resolved port>}`; confirm the `Set-Cookie` header has all four properties (`Path=/api/webpane/`, `HttpOnly`, `Secure`, `SameSite=Strict`) and `Max-Age=300`.
- [ ] With that cookie only (no Authorization header), `curl` `/api/webpane/devserver/<port>/` and confirm it proxies through (200, real dev-server content) rather than 401.
- [ ] With the same cookie, `curl` `/api/sessions` and confirm it still 401s — the cookie must not work outside `/api/webpane/*`.
- [ ] `curl` `/api/webpane/devserver/<some port NOT currently resolved>/` with a valid bearer token and confirm 403 `FORBIDDEN`.
- [ ] Mint a token for a local file path, `curl /api/webpane/localfile?path=<that path>` with the cookie, confirm the correct `content-type` header and body bytes.
