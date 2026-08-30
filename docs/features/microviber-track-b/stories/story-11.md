---
id: microviber-track-b-11
title: Web pane content-plane streaming proxy (SSE / streamed responses)
status: todo
project: microviber
depends_on: [microviber-track-b-3]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/22
---

## User Story
As a **developer using MicroViber's Web pane**, I want to browse a dev server whose responses stream (Server-Sent Events, streamed React Server Components, chunked long-poll, or any endpoint that holds the connection open) without the pane hanging, so that the pane works for the full range of dev servers I run — not only ones whose responses complete quickly.

## Background / Why
Story microviber-track-b-3's content plane reverse-proxies dev-server traffic by **fully buffering** each upstream response before relaying it: `daemon/src/lib/webpane/proxy.ts`'s `proxyToLoopback` awaits `res.arrayBuffer()`, and `handleContentPlane` (in `daemon/src/api/app.ts`) relays it with a single `reply.send(Buffer.from(upstream.body))`. This works for ordinary page and asset responses (verified live against studio's Next.js dev server), but any response that does not complete promptly — an SSE endpoint, a streamed RSC/Suspense response, or a long-poll — never flushes to the iframe until upstream ends, and an endpoint that never ends pins the request and grows the in-memory buffer unboundedly. The request-side 10MB cap added in story-3 bounds request bodies only, not response bodies.

This was deliberately **deferred** during story-3's code review (see story-3's "Deferred from code review" follow-ups) as out of scope for that security-hardening pass. It is a real functional limitation, not a bug in what shipped: the common "did my change render?" use case is unaffected.

## Acceptance Criteria
1. The content plane relays upstream dev-server responses as a **stream** (pipe upstream → `reply.raw`, or `reply.send(nodeReadableStream)`), so bytes reach the iframe as they arrive rather than only after the upstream response completes.
2. An SSE / chunked / never-ending upstream response is delivered incrementally and does **not** buffer the whole body in daemon memory; closing the iframe (client disconnect) tears down the upstream connection promptly (no leaked socket, no orphaned buffer).
3. The existing response-header hygiene is preserved on the streamed path: hop-by-hop, `content-encoding`, `content-length`, `set-cookie`, `access-control-*`, and the upstream's own `content-security-policy`/`referrer-policy` are still stripped, and the daemon's own `content-security-policy: frame-ancestors …` + `referrer-policy: no-referrer` still win (the story-3 header-precedence guarantee must hold on the streamed path too).
4. The request-side body cap and the Origin / cookie-capability / port-allowlist checks from story-3 are unchanged and still enforced before any streaming begins.
5. A response-side safeguard exists so a hostile or runaway upstream cannot exhaust daemon memory or file descriptors: e.g. an idle/stall timeout on the upstream stream and a bounded number of concurrent in-flight proxied streams (document whatever bound is chosen).
6. Non-streaming responses (normal pages/assets) continue to work exactly as before — this is verified by the existing content-plane tests still passing.

## Affected Files
- `daemon/src/lib/webpane/proxy.ts` — `proxyToLoopback` returns/exposes a stream instead of a fully-buffered `Uint8Array` (or gains a streaming variant).
- `daemon/src/api/app.ts` — `handleContentPlane` relays via a stream to `reply.raw`/`reply.send(stream)`, preserving the header-hygiene + daemon-header-precedence logic; add client-disconnect teardown and the response-side safeguard.
- `daemon/test/webpane/proxy.test.ts` — streaming behavior (incremental delivery, teardown on client abort).
- `daemon/test/app.test.ts` — content-plane streaming test (SSE-style upstream delivers incrementally; header hygiene + daemon-header precedence still hold on the streamed path; client disconnect tears down upstream).

## Technical Notes
- Reconcile with the story-3 request-side 10MB cap (`MAX_CONTENT_BODY_BYTES`) — that cap is request-body only and stays; this story adds the **response**-side streaming + safeguard.
- The WebSocket upgrade path (`app.server.on('upgrade')`) already streams via a raw socket splice and is out of scope here — this story is about the HTTP content plane only.
- Keep the daemon's security-header precedence (story-3 / architecture-spec.md T15): on a streamed response the daemon-owned `frame-ancestors` + `referrer-policy` must still be set and must still win over any upstream copy. Setting response headers before piping the body is the natural place.
- Fastify streaming: `reply.send(stream)` or writing to `reply.raw` directly — pick whichever cleanly preserves the header logic and Fastify's own framing recomputation; document the choice.

## Manual Test Checklist
- [ ] Run `npm run typecheck && npm run lint && npm test` from `microviber/` — all green.
- [ ] Point the Web pane at a dev server with a streaming endpoint (e.g. a Next.js App Router page using streaming/Suspense, or an SSE route) over the Tailscale HTTPS name; confirm content appears incrementally and the pane does not hang.
- [ ] Open a streaming/SSE endpoint, then navigate away / close the pane; confirm (daemon logs or process inspection) the upstream connection is torn down and memory does not grow unbounded.
- [ ] Confirm a normal (non-streaming) dev-server page still loads exactly as before, with the daemon's `frame-ancestors` + `referrer-policy` headers intact (not overridden by the dev server's own).
