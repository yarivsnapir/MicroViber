---
id: microviber-track-c-9
title: Bound the /transcript response by bytes, not only by event count
status: todo
project: microviber
depends_on: [microviber-track-c-1]
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/54
---

## User Story
As a **developer reading a session from my phone**, I want **the transcript response to be bounded by its actual size and to tell me when it was cut**, so that **a session full of large tool payloads neither stalls the daemon nor silently truncates my scrollback**.

## Why this exists
Carved out of `microviber-track-c-1`'s review (2026-09-08). Two findings were
deliberately deferred there because both need a decision this story owns, not a
patch:

1. **`TRANSCRIPT_MAX_EVENTS = 500` (`daemon/src/services/services.ts`) bounds
   event COUNT, not response SIZE.** story-1 capped each tool event's `input` at
   ~72 KB and each `toolResult.text` at 32 KB, so a 500-event response is now
   bounded in principle — but only at a ceiling of several megabytes, which is
   not a bound anyone would choose deliberately. The comment on
   `TOOL_PAYLOAD_MAX_CHARS` in `tail.ts` points here.
2. **story-1 multiplied events per line, so 500 events is now much less
   scrollback than it was.** One assistant turn that thinks, explains, and makes
   three tool calls with three results is 8 events from 4 transcript lines;
   before story-1 the same turn was 1–2 events. Effective phone scrollback
   therefore shrank roughly 2–4× with no acceptance criterion and no note. Nobody
   asked for that.

Neither is a security hole — the response is behind bearer auth on a tunnel, and
`Fastify({ logger: false })` means none of it is logged. This is about the daemon
being single-threaded (`JSON.stringify` of the whole body is synchronous) and
about not silently shortening what the user can scroll back to.

## Acceptance Criteria
1. `getTranscript` bounds its response by **serialized bytes** as well as event
   count, with the byte ceiling recorded as a named constant and its measured
   headroom noted beside it (architecture-spec.md §6 requires the measurement,
   not just the constant).
2. When the response is truncated for **either** reason, the payload says so
   explicitly rather than silently returning a short list — the PWA must be able
   to tell "this is the start of the session" from "we cut it here".
3. The PWA renders that marker at the top of the transcript.
4. The event-count ceiling is re-chosen with story-1's higher events-per-line in
   mind, so effective scrollback is at least what it was before story-1 — or the
   reduction is explicitly accepted and recorded here with a reason.
5. A test drives `getTranscript` over a transcript whose events are large enough
   to hit the byte ceiling before the count ceiling, and asserts both the bound
   and the marker.
6. A test covers the reverse: many small events hitting the count ceiling first.
7. `npm run typecheck && npm run lint && npm test` green from the repo root.

## Affected Files
- `daemon/src/services/services.ts` — the byte budget and the truncation marker.
- `daemon/src/lib/claude-adapter/tail.ts` — update the `TOOL_PAYLOAD_MAX_CHARS` comment that currently forward-references this story.
- `daemon/src/schemas/api.ts` — the transcript response shape gains the marker.
- `pwa/src/lib/types.ts` — mirror it (FENCE 1, hand-maintained).
- `pwa/src/components/Transcript.tsx` — render the marker.
- `daemon/test/services.test.ts` — the two ceiling tests.

## Technical Notes
**Pagination is still out of scope.** `getTranscript` accepts a `cursor` and
ignores it, always returning `nextCursor: null`; the track-c spec §8 lists that
as pre-existing and unchanged. This story bounds and *labels* the window, it does
not add paging. Doing so would make the marker unnecessary, which is a reasonable
argument for doing pagination instead — decide that here rather than inheriting it.

**Do not lower the per-field caps to compensate.** story-1's
`TOOL_PAYLOAD_MAX_CHARS` / `TOOL_INPUT_MAX_CHARS` were sized so the largest
legitimate input (an `Edit` with both strings at the per-field cap) ships whole
and unflagged; there are tests pinning that. The fix belongs at the response
layer.

## Manual Test Checklist
- [ ] Package the byte-ceiling and count-ceiling checks into `story-9-check.sh` in the shape story-1 established: everything runnable runs itself and prints PASS/FAIL, and anything visual is served as a labelled preview. Do not hand over a list of curl commands.
