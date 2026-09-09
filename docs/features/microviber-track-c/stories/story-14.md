---
id: microviber-track-c-14
title: The control-plane WebSocket lands, with its upgrade gate and frame protocol
status: todo
project: microviber
depends_on: [microviber-track-c-13]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/60
---

## User Story
As a **developer**, I want **a live bidirectional stream attached to a terminal**, so that **keystrokes and output can flow between the phone and a real shell**.

## Why this story is the security-sensitive one in Feature A
Today the control plane has **no** WebSocket at all: `app.ts:568` refuses every main-origin upgrade, `pwa/src/lib/api.ts`'s `openStream` is defined and never called, and `daemon/package.json` has no WebSocket dependency. The two building blocks written for this — `api/ws/authorize.ts`'s `authorizeUpgrade` and `api/ws/hub.ts`'s `Hub` — are imported **only by a test**. `authorizeUpgrade` was written for threat T5 and has never run in production. This story is what it was for, which means this story is where it gets its first real exercise.

## Acceptance Criteria
1. A `/ws` upgrade handler is registered on the control plane and wired to `authorizeUpgrade`.
2. **The upgrade gate runs in this order, before any PTY is attached**, each with its own refusal:
   1. Host allowlist (T3) → `421`
   2. Host port **is** the control port
   3. `Origin` equals the control origin (T5) → refuse
   4. Bearer token from `Sec-WebSocket-Protocol`, as `pwa/src/lib/api.ts` already sends it → `401`
   5. `?terminal=<id>` resolves to a live registry entry → `404`
3. Each gate step has its own test asserting the refusal, including the order — a later step must not be reachable when an earlier one fails.
4. **The existing refusal narrows rather than disappears.** `app.ts:568` currently rejects all main-origin upgrades wholesale; it becomes "reject unless the path is `/ws` and the gate passes". A test asserts every *other* main-origin upgrade path is still refused.
5. **The content-plane splice at `app.ts:557` is untouched and must not overlap.** A test asserts a content-plane upgrade still takes its own path and is unaffected.
6. Frame protocol is JSON, zod-validated at the boundary:
   | Direction | Frame |
   |---|---|
   | client → daemon | `{ t: 'in', d: string }` |
   | client → daemon | `{ t: 'resize', cols: number, rows: number }` |
   | daemon → client | `{ t: 'out', d: string }` |
   | daemon → client | `{ t: 'exit', code: number \| null }` |
7. Inbound frames are capped at **64 KiB**. An oversized **or** schema-invalid frame **closes the socket** rather than being ignored — fail-closed, matching the repo's standard.
8. **One attached client per terminal.** A second attach to the same id displaces the first, and the displaced socket is closed with a WebSocket **close frame carrying an explicit reason string** — the protocol's own close mechanism, not a fifth entry in the frame table — never dropped silently.
9. The attached client owns the PTY's dimensions: its `resize` frames set the size, and on displacement the **new** client's dimensions win.
10. On attach, the ring buffer replays verbatim before live output resumes, so the client can reconstruct the visible screen.
11. `{ t: 'exit' }` is delivered when the PTY dies, and the socket then closes.
12. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/api/app.ts` — register `/ws`; narrow the `:568` refusal without touching the `:557` splice.
- `daemon/src/api/ws/authorize.ts` — wire it up; extend only if the gate needs the terminal-id step.
- `daemon/src/api/ws/hub.ts` — the attach/displace bookkeeping.
- `daemon/src/schemas/api.ts` — the four frame schemas and the 64 KiB cap.
- `daemon/package.json` — the WebSocket dependency.
- `daemon/test/ws-hub.test.ts` — extend: displacement, close reason, dimension ownership.
- `daemon/test/app.test.ts` — the five gate refusals in order, the narrowed refusal, the untouched content-plane splice.

## Technical Notes
**Why JSON frames and not a raw byte pipe.** `resize` has to be multiplexed onto the same socket, and a raw pipe cannot carry it (`spec.md` §2.2). The content plane's splice is a raw byte pipe precisely because it carries nothing but bytes; this socket is not that.

**Strict `Origin` equality is safe here and is not belt-and-braces.** CORS never covers sockets, and browsers always send `Origin` on a WS handshake — the same reasoning the content-plane splice already relies on (T15).

**Why one client and not multiplexing.** MicroViber is a single-user tool (`docs/functional-spec.md` §5), so two views onto one PTY would add reconciliation complexity for a case that does not arise. Displacement is the deliberate behaviour, not a limitation to apologise for.

**Rollout:** additive. Nothing in the PWA opens this socket until story 15, so merging alone changes no live path — but it does open a new authenticated surface, so the gate tests are the acceptance evidence, not a nice-to-have.

## Manual Test Checklist
- [ ] `story-14-check.sh`: runs the gate, then drives the socket from a Node client — attach with a valid bearer and terminal id, send `in`, assert `out` comes back, send `resize`, send a 65 KiB frame and assert the socket **closes**, send malformed JSON and assert it closes, attach a second client and assert the first receives a close frame **with a reason**, kill the PTY and assert `exit`. Also assert each of the five gate refusals returns its documented code. PASS/FAIL per check.
- [ ] No UI in this story. There is nothing to look at in the app until story 15 — do not hand over a `wscat` command line.
