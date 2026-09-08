# story-1 (microviber-track-c-1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Story:** [#37](https://github.com/yarivsnapir/MicroViber/issues/37) — Widen the transcript event stream and render every kind, including diffs
**Story file:** `docs/features/microviber-track-c/stories/story-1.md`
**Feature plan:** `docs/features/microviber-track-c/plan.md` — this story implements **tasks 1, 2, 3, 4, 5, 8, 9, 11** plus the **`types.ts` mirror half of task 7**.
**Branch:** `story/microviber-track-c-1` (off `main`, PR base `main`)

**Goal:** the phone's transcript shows what actually happened — assistant prose *and* every tool call, each call's real arguments, each tool's result, the reasoning, and a red/green diff per file edit. Two layers, strictly ordered: widen the daemon normalizer first, then rebuild the renderer on the widened stream.

---

## Baseline (measured on this branch before any edit)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` — daemon | 33 files, **534 passed** |
| `npm test` — pwa | 26 files, **189 passed** |

Any red at the end of this plan is this story's own. There is one known-flaky
test unrelated to this work: `pwa/test/webpane.test.tsx` → *"normalizes a path
typed without a leading slash"* ([#50](https://github.com/yarivsnapir/MicroViber/issues/50)).
It passed at baseline; if it flaps, it is not a regression from this story.

---

## Corrections to the feature plan — read before starting

The feature plan was written before three things that are now true on `main`.
Where they conflict, **this file wins**.

1. **`selectedLabels` is `string[][]`, not `string[]`.** Feature-plan Task 7's
   mirror snippet shows `selectedLabels?: string[]`. That predates
   `askuserquestion-answer-mechanism-3` ([#36](https://github.com/yarivsnapir/MicroViber/issues/36) /
   [#53](https://github.com/yarivsnapir/MicroViber/issues/53)), which shipped
   per-question labels. `pwa/src/lib/types.ts` **already** has `string[][]` and
   is already in sync for the `askUserQuestion` member.
   **Do not touch the `askUserQuestion` line of the mirror.** Copying the plan's
   snippet verbatim would silently regress a shipped feature.

2. **PWA component tests need a jsdom docblock and cleanup.**
   `pwa/vite.config.ts` sets `environment: 'node'`. Every existing component
   test opts in per file. The feature plan's Task 8/9/11 test snippets omit
   both. Every **`.tsx`** test file this story creates MUST start:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, afterEach } from 'vitest';
   import { render, screen, cleanup, fireEvent } from '@testing-library/react';
   afterEach(cleanup);
   ```
   `pwa/test/diff.test.ts` is pure and stays on the node environment.

3. **`types.ts` moves in lockstep with the daemon union (AC25), so there is no
   standalone "mirror task".** Feature-plan Task 4 offers "commit with a red
   root gate, Task 7 fixes it". AC25 forbids that. Every task below that
   changes the daemon union edits `pwa/src/lib/types.ts` **in the same commit**,
   and the root gate is green at every commit.

4. **Scope boundary against story-7 ([#43](https://github.com/yarivsnapir/MicroViber/issues/43)).**
   This story takes only the *mirror* half of feature-plan Task 7. It does
   **not** create `pwa/src/components/transcript/UserTurn.tsx`, does **not** add
   `whitespace-pre-wrap` to user turns, and does **not** stamp `injected`
   (feature-plan Task 6). Do not touch `case 'user'` in `Transcript.tsx` beyond
   leaving it exactly as it is.

5. **Working directory.** The feature plan tells you to work in the
   `feature/microviber-track-c` worktree. That branch is stale (it predates the
   push-notification, autostart and per-question-labels features on `main`).
   This story runs in its own worktree off `main`; the planning docs were
   cherry-picked in as files. Never `git checkout` a branch in the shared
   primary checkout at `microviber/`.

---

## Global constraints (apply to every task)

- **Gate before every commit:** `npm run typecheck && npm run lint && npm test` from the repo root, all green.
- **TS strictness** per `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. Indexed access yields `T | undefined` — use `?? ''`, never `!`.
- **No `any`.** `@typescript-eslint/no-explicit-any` is an error.
- **FENCE 2 (adapter quarantine).** All normalizer work stays inside `daemon/src/lib/claude-adapter/`. Nothing outside it learns a new transcript block shape.
- **FENCE 1 (PWA).** `pwa/` never imports from `daemon/`. `pwa/src/lib/types.ts` is a hand-maintained mirror.
- **T7 / T11.** Tool input, tool results and thinking text are arbitrary model output. Render as plain text in `<pre>` / plain React children — **never** markdown, **never** `innerHTML`, **never** `dangerouslySetInnerHTML`, never `rehype-raw`. Nothing acts on the content.
- **Repo-relative paths only** in code, tests and docs.
- **`daemon/test/tail.test.ts` is updated, never deleted.** Its existing cases are the AskUserQuestion regression suite (AC14).

---

## Task 1: EventRow tolerates an unknown event kind

**Lands first, before any new kind exists** — that is the whole point (AC16).
The PWA is an installed PWA with a service worker, so a phone can run a cached
older bundle against a newer daemon. Today an unrecognised `kind` falls off the
end of `EventRow`'s switch, returns `undefined`, and React throws *"Nothing was
returned from render"*, blanking the **entire** transcript.

**Covers:** AC16.

**Files:**
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-unknown-kind.test.tsx` (new)

**Interfaces:** produces nothing new; widens `EventRow`'s return type to `ReactElement | null`.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-unknown-kind.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);

const base = { sessionId: 's1', sessionCwd: '/proj', canAnswer: false, answerInFlight: null };

describe('Transcript tolerates an event kind it does not know (AC16 — version skew)', () => {
  it('renders the events it understands and skips the one it does not, without throwing', () => {
    // A cached older bundle meeting a newer daemon's event. Cast is the point
    // of the test: the union deliberately cannot express this at compile time.
    const future = { kind: 'somethingTheDaemonAddedLater', at: '' } as unknown as TranscriptEvent;
    expect(() =>
      render(<Transcript {...base} events={[
        { kind: 'assistant', at: '', text: 'before' },
        future,
        { kind: 'assistant', at: '', text: 'after' },
      ]} />),
    ).not.toThrow();
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-unknown-kind.test.tsx`
Expected: FAIL — React throws "Nothing was returned from render".

- [ ] **Step 3: Write the implementation**

In `pwa/src/components/Transcript.tsx`, change `EventRow`'s return type to
`ReactElement | null` and add a final arm to the switch:

```tsx
    case 'askUserQuestion':
      return <AskUserQuestionCard e={e} canAnswer={canAnswer} inFlight={answerInFlight} onAnswer={onAnswer} />;
    default:
      // Load bearing, not defensive (story-1 AC16): this is an installed PWA
      // with a service worker, so a phone can be running a CACHED OLDER bundle
      // against a newer daemon. Without this arm an unknown kind returns
      // undefined and React blanks the whole transcript.
      return null;
  }
```

Note `default` after an exhaustive switch is fine: TS narrows `e` to `never`
there, and no lint rule forbids it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix pwa test`
Expected: PASS — including `transcript-askuserquestion.test.tsx` and `transcript-links.test.tsx` untouched.

- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/components/Transcript.tsx pwa/test/transcript-unknown-kind.test.tsx
git commit -m "fix(pwa): EventRow tolerates an unknown event kind instead of blanking the transcript (story-1 AC16)"
```

---

## Task 2: Model thinking and tool_result blocks in the adapter schema

`Content` in `daemon/src/lib/claude-adapter/schemas.ts` is a union of
`TextBlock`, `ToolUseBlock` and a `z.object({ type: z.string() }).passthrough()`
catch-all. `ToolResultBlock` is declared right above it but is **not in the
union**, and there is no thinking block at all — so both parse as anonymous
passthrough objects the walker cannot recognise.

**Covers:** the parsing precondition for AC5–AC9.
**Feature plan:** task 1.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/schemas.ts`
- Test: `daemon/test/schemas.test.ts`

**Interfaces:** produces `ThinkingBlock`; `ToolResultBlock` gains optional `is_error`; both join `Content`. Tasks 3–6 depend on this.

- [ ] **Step 1: Write the failing test**

Append to `daemon/test/schemas.test.ts` (it already imports from
`../src/lib/claude-adapter/schemas.js` — reuse that import, do not add a second):

```ts
describe('Content models thinking and tool_result blocks (story-1)', () => {
  it('parses a thinking block with its text intact', () => {
    const parsed = TranscriptLineSchema.safeParse({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing two options' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const block = (parsed.data as { message: { content: unknown[] } }).message.content[0];
    expect(block).toEqual({ type: 'thinking', thinking: 'weighing two options' });
  });

  it('parses a tool_result block and keeps is_error', () => {
    const parsed = TranscriptLineSchema.safeParse({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }] },
      timestamp: '2026-09-06T10:00:01.000Z',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const block = (parsed.data as { message: { content: Record<string, unknown>[] } }).message.content[0];
    expect(block?.tool_use_id).toBe('toolu_1');
    expect(block?.is_error).toBe(true);
  });
});
```

If `TranscriptLineSchema` is not already imported in that file, add it to the
existing import from `../src/lib/claude-adapter/schemas.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- schemas.test.ts`
Expected: FAIL. The thinking case fails its exact `toEqual` — the catch-all
preserves the object but the block is not modelled. The `is_error` case fails
because `ToolResultBlock` has no such field and the catch-all leaves it untyped.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/schemas.ts`, add `ThinkingBlock` beside the
other block schemas and extend `ToolResultBlock`:

```ts
/**
 * Extended reasoning block. Modelled (story-1) so tail.ts can emit its text
 * instead of letting it fall through the Content catch-all, where a
 * thinking-only assistant line normalized to an EMPTY assistant event and
 * rendered as a bare gutter bullet with nothing beside it.
 */
export const ThinkingBlock = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  // Claude Code marks a failed tool with is_error. Modelled so the PWA can
  // tint a failure without string-sniffing the result body (story-1 AC7).
  is_error: z.boolean().optional(),
});
```

Then add both to `Content`, keeping the passthrough catch-all **last** so any
future block kind still parses rather than failing the whole line:

```ts
const Content = z.union([
  z.string(),
  z.array(z.union([TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, z.object({ type: z.string() }).passthrough()])),
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix daemon test -- schemas.test.ts`
Expected: PASS.

Then the whole daemon suite — `ask-user-question.ts` and `transcript-meta.ts`
parse the same lines through the same schema:

Run: `npm --prefix daemon test`
Expected: PASS, 534+ tests. Watch `ask-user-question.test.ts` and
`transcript-meta.test.ts` in particular: `ToolResultBlock` entering the union
means tool_result blocks now parse as a *typed* member rather than the
passthrough. If either goes red, the schema is wrong — fix the schema, not the test.

- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/schemas.ts daemon/test/schemas.test.ts
git commit -m "feat(adapter): model thinking and tool_result content blocks (story-1)"
```

---

## Task 3: normalizeLine returns an array so prose and every tool call survive

Two defects, one cause. `normalizeLine` returns at most one event, and its
assistant branch prefers the tool over the prose:

```ts
if (blocks.tool) return { kind: 'tool', ... };
return { kind: 'assistant', at, text: blocks.text ?? '' };
```

so prose sharing a message with a tool call is **discarded**. And inside
`normalizeContent`, `tool` is reassigned each iteration, so a multi-tool message
keeps only the **last** call.

**Covers:** AC1, AC2, AC3, AC4, AC14, and the `id` half of AC11. AC25 for the `tool.id` mirror.
**Feature plan:** task 2.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Modify: `pwa/src/lib/types.ts` (lockstep, AC25 — `tool` gains `id`)
- Test: `daemon/test/tail.test.ts`

**Interfaces:** produces `normalizeLine(line: string): TranscriptEvent[]` (was `TranscriptEvent | null`). `parseChunk`'s signature is **unchanged**. Tasks 4–6 extend the same two walkers.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/tail.test.ts`:

```ts
describe('normalizeLine emits every block (story-1)', () => {
  it('keeps assistant prose that shares a message with a tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the config.' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'daemon/src/config.ts' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'assistant', text: 'Let me check the config.' });
    expect(events[1]).toMatchObject({ kind: 'tool', name: 'Read', id: 'toolu_a' });
  });

  it('keeps every tool call in a multi-tool message, not just the last', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: { pattern: 'TODO' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events.map((e) => e.kind)).toEqual(['tool', 'tool']);
    expect(events.map((e) => (e.kind === 'tool' ? e.name : ''))).toEqual(['Read', 'Grep']);
    expect(events.map((e) => (e.kind === 'tool' ? e.id : ''))).toEqual(['toolu_a', 'toolu_b']);
  });

  it('joins several text blocks with a blank line, not a single space', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First para.' }, { type: 'text', text: 'Second para.' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'assistant', text: 'First para.\n\nSecond para.' });
  });

  it('returns an empty array for an unparseable or unrenderable line', () => {
    expect(normalizeLine('not json')).toEqual([]);
    expect(normalizeLine('')).toEqual([]);
    expect(normalizeLine('{"type":"queue-operation"}')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — and it fails at **compile** first, because the file's existing
call sites treat the result as one event or `null`. That is the expected signal
that Step 4 has work to do.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/tail.ts`, replace `normalizeLine`,
`NormalizedContent` and `normalizeContent` with a block walker. Keep
`summarizeToolInput` **exactly** as it is — it still produces the collapsed
one-liner and still reads the uncapped original.

```ts
/** Normalize one raw .jsonl line into zero or more TranscriptEvents, in source order. */
export function normalizeLine(line: string): TranscriptEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const parsed = TranscriptLineSchema.safeParse(raw);
  if (!parsed.success) return [];
  const e = parsed.data;
  if (e.type !== 'user' && e.type !== 'assistant') return [];

  const at = e.timestamp ?? '';

  if (e.type === 'user') {
    // The synthetic "Continue from where you left off." resume handshake
    // (architecture-spec.md F17/F18) is not something the user typed.
    if (e.isMeta === true) return [];
    return userEvents(e.message.content, at);
  }

  // An AskUserQuestion tool_use keeps its whole-content short-circuit and its
  // SINGLE-event shape: tail.ts and transcript-meta.ts share that detection
  // through ask-user-question.ts, and resolveAskUserQuestions below depends on
  // exactly one askUserQuestion event per line (AC14).
  const detected = detectAskUserQuestion(e.message.content);
  if (detected) {
    return [{ kind: 'askUserQuestion', at, toolUseId: detected.toolUseId, resolved: false, questions: detected.questions }];
  }

  return assistantEvents(e.message.content, at);
}

function assistantEvents(content: unknown, at: string): TranscriptEvent[] {
  if (typeof content === 'string') return content ? [{ kind: 'assistant', at, text: content }] : [];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  const rest: TranscriptEvent[] = [];

  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      rest.push({ kind: 'tool', at, id: block.id ?? '', name: block.name, summary: summarizeToolInput(block.input) });
    }
  }

  const out: TranscriptEvent[] = [];
  // Blank line, not a space: several text blocks are separate paragraphs, and
  // joining them with ' ' collapsed real paragraph breaks in the rendered
  // markdown (AC3).
  const text = texts.join('\n\n');
  if (text) out.push({ kind: 'assistant', at, text });
  return [...out, ...rest];
}

function userEvents(content: unknown, at: string): TranscriptEvent[] {
  if (typeof content === 'string') return content ? [{ kind: 'user', at, text: content, injected: false }] : [];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string };
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }

  const text = texts.join('\n\n');
  return text ? [{ kind: 'user', at, text, injected: false }] : [];
}
```

Widen the `tool` union member in the same file — it now carries the tool_use `id`:

```ts
  | { kind: 'tool'; at: string; id: string; name: string; summary: string }
```

Then flatten in `parseChunk`, preserving each event's source line index:

```ts
  const withIndex: { event: TranscriptEvent; lineIndex: number }[] = [];
  lines.forEach((line, i) => {
    for (const ev of normalizeLine(line)) withIndex.push({ event: ev, lineIndex: i });
  });
```

`resolveAskUserQuestions` needs **no** change: it drops by `lineIndex`, and
every event from a consumed line shares that index, so a consumed line's whole
output is dropped together.

- [ ] **Step 4: Update the existing tests to the array shape (AC14)**

**Deliberate updates, not deletions.** In `daemon/test/tail.test.ts`:

| Test | Change |
|---|---|
| `'normalizes a plain user turn (not injected)'` | `expect(events).toEqual([{ kind: 'user', … }])` |
| `'does NOT unwrap a cross-session-message wrapper anymore…'` | `normalizeLine(userLine(wrapped))[0] as Extract<…>` |
| `'normalizes an assistant text turn'` | `toEqual([{ kind: 'assistant', … }])` |
| `'collapses a tool_use to a one-line tool event with a summary'` | `normalizeLine(line)[0] as Extract<…>` |
| `'returns null for unrenderable / unknown lines'` | rename to `'returns an empty array for …'`; `toEqual([])` |
| `'emits an unresolved askUserQuestion event for a bare AskUserQuestion tool_use…'` | `normalizeLine(…)[0] as Extract<…>`; **must still be exactly one event** |
| `'a non-AskUserQuestion tool_use is unaffected — still collapses to the generic tool kind'` | `normalizeLine(…)[0] as Extract<…>`; also assert the new `id` |

Every `describe('parseChunk …')` case keeps its existing shape — `parseChunk`'s
signature did not change. **Do not touch** the AskUserQuestion resolution tests
beyond compile fixes; AC14 requires them to pass on their existing assertions.

- [ ] **Step 5: Mirror `tool.id` in the PWA (AC25, same commit)**

In `pwa/src/lib/types.ts`:

```ts
  | { kind: 'tool'; at: string; id: string; name: string; summary: string }
```

Leave every other member alone — **especially** `askUserQuestion` with its
`selectedLabels?: string[][]` (see Correction 1).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix daemon test`
Expected: PASS. Pay attention to:
- `transcript-meta.test.ts` and `services.test.ts` — they consume `parseChunk`, whose signature is unchanged; they should need no edit. If either fails, the flattening is wrong — fix the code, not the test.
- `prompt-lifecycle.test.ts` — `services.ts` `getTranscript` calls `lifecycle.observe` for every `user` event. Joining multi-text-block turns with `\n\n` instead of `' '` changes the observed text for that (rare) shape. Confirm green.

Run: `npm --prefix pwa test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts pwa/src/lib/types.ts
git commit -m "feat(adapter): normalizeLine returns an array so prose and every tool call survive (story-1)"
```

---

## Task 4: Emit toolResult events and stop rendering blank user bubbles

`normalizeContent` never recognised `tool_result`, so a user line carrying only
a tool result produced `text: ''` and rendered on the phone as an **empty grey
bordered box**. Every non-`AskUserQuestion` tool result in every session looks
like that today.

`daemon/test/tail.test.ts` currently **asserts that broken behaviour**, at
`'an ordinary tool_result for a non-AskUserQuestion tool is unaffected
(pre-existing behavior, untouched)'`, whose comment reads
`// tool event + the pre-existing blank user bubble — unchanged, out of this
task's scope`. **This story owns it. Update it; do not delete it.**

**Covers:** AC5, AC6, AC7, AC8, AC15, the `toolResult.text` half of AC12, AC25.
**Feature plan:** task 3.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Modify: `pwa/src/lib/types.ts` (lockstep, AC25)
- Test: `daemon/test/tail.test.ts`

**Interfaces:** produces `{ kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }`, plus `TOOL_PAYLOAD_MAX_CHARS`, `capText`, `toolResultText`. Task 6 reuses `capText`; Task 7 renders the event.

- [ ] **Step 1: Write the failing test**

```ts
describe('tool results become their own event (story-1)', () => {
  it('emits a toolResult instead of a blank user bubble', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok, 3 files changed' }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)).toEqual([
      { kind: 'toolResult', at: '2026-09-06T10:00:02.000Z', toolUseId: 'toolu_a', ok: true, text: 'ok, 3 files changed', truncated: false },
    ]);
  });

  it('marks is_error results as not ok', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'boom', is_error: true }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)[0]).toMatchObject({ kind: 'toolResult', ok: false, text: 'boom' });
  });

  it('flattens an array tool_result content to its text blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }],
      },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)[0]).toMatchObject({ kind: 'toolResult', text: 'line one\nline two' });
  });

  it('serialises a non-string, non-array tool_result content to JSON, and absent content to empty', () => {
    const objLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: { rows: 2 } }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(objLine)[0]).toMatchObject({ kind: 'toolResult', text: '{"rows":2}' });

    const bareLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(bareLine)[0]).toMatchObject({ kind: 'toolResult', text: '' });
  });

  it('truncates an oversized result and flags it', () => {
    const huge = 'x'.repeat(40_000);
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: huge }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    const ev = normalizeLine(line)[0];
    expect(ev).toMatchObject({ kind: 'toolResult', truncated: true });
    if (ev?.kind !== 'toolResult') throw new Error('expected toolResult');
    expect(ev.text.length).toBeLessThanOrEqual(32_001);
  });

  it('still drops the AskUserQuestion tool_result line entirely rather than surfacing it as a toolResult (AC15)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    expect(parseChunk(chunk).events.map((e) => e.kind)).toEqual(['askUserQuestion']);
  });
});
```

The last test reuses the `assistantToolUseLine` / `toolResultLine` /
`askQuestionInput` helpers **already defined** in that file. Place this
`describe` block *after* their declarations (they are declared around line 57).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — no `toolResult` kind exists, so these fail to compile.

- [ ] **Step 3: Write the implementation**

Add the cap constant and helpers near the top of
`daemon/src/lib/claude-adapter/tail.ts`:

```ts
/**
 * Payload ceiling for tool inputs and results. One `Read` of a large file
 * would otherwise balloon a single /transcript response: the existing
 * 500-event cap bounds event COUNT, not payload SIZE (story-1 AC12).
 */
const TOOL_PAYLOAD_MAX_CHARS = 32_000;

function capText(s: string): { text: string; truncated: boolean } {
  return s.length > TOOL_PAYLOAD_MAX_CHARS
    ? { text: `${s.slice(0, TOOL_PAYLOAD_MAX_CHARS)}…`, truncated: true }
    : { text: s, truncated: false };
}

/** Flatten a tool_result's `content` (string, block array, or arbitrary JSON) to displayable text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b !== 'object' || b === null) continue;
      const block = b as { type?: string; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}
```

> `JSON.stringify` returns `string | undefined` (e.g. for a bare `undefined`),
> so the `?? ''` is not decoration — it is what keeps the return type `string`.

Add the union member:

```ts
  | { kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }
```

Extend `userEvents` from Task 3 to walk tool_result blocks in source order:

```ts
function userEvents(content: unknown, at: string): TranscriptEvent[] {
  if (typeof content === 'string') return content ? [{ kind: 'user', at, text: content, injected: false }] : [];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  const results: TranscriptEvent[] = [];

  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const capped = capText(toolResultText(block.content));
      results.push({
        kind: 'toolResult',
        at,
        toolUseId: block.tool_use_id,
        ok: block.is_error !== true,
        text: capped.text,
        truncated: capped.truncated,
      });
    }
  }

  const out: TranscriptEvent[] = [];
  const text = texts.join('\n\n');
  // A user line with ONLY tool_result blocks emits NO user event. That blank
  // bubble was the empty grey box on the phone (AC6).
  if (text) out.push({ kind: 'user', at, text, injected: false });
  return [...out, ...results];
}
```

- [ ] **Step 4: Update the test that asserts the old blank-bubble behaviour**

Rewrite the body of
`'an ordinary tool_result for a non-AskUserQuestion tool is unaffected
(pre-existing behavior, untouched)'` and rename it. It becomes the assertion
that the defect is fixed:

```ts
  it('an ordinary tool_result now becomes a toolResult event instead of a blank user bubble (story-1 AC6 — was asserted broken here)', () => {
    const chunk = [
      assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' }),
      toolResultLine('toolu_2', 'file1\nfile2'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events.map((e) => e.kind)).toEqual(['tool', 'toolResult']);
    expect(events[1]).toMatchObject({ kind: 'toolResult', toolUseId: 'toolu_2', ok: true, text: 'file1\nfile2' });
  });
```

- [ ] **Step 5: Mirror in the PWA (AC25, same commit)**

Add to `pwa/src/lib/types.ts`:

```ts
  | { kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }
```

No renderer arm yet — Task 1's `default: return null` already makes an
unrendered kind harmless, which is precisely the property it exists for.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix daemon test`
Expected: PASS, including every AskUserQuestion resolution case untouched (AC14/AC15).

- [ ] **Step 7: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts pwa/src/lib/types.ts
git commit -m "feat(adapter): emit toolResult events; no more blank user bubbles (story-1)"
```

---

## Task 5: Emit thinking with its text and delete the dead error kind

`thinking` and `error` are both declared in `TranscriptEvent` and **never
constructed by anything**. A thinking block falls through the walker, so a
thinking-only assistant line yields an empty assistant event that renders as a
bullet with nothing beside it.

They resolve in opposite directions: `thinking` becomes real and carries its
text; `error` is **removed**, because nothing produces it and a
declared-but-dead branch the type system vouches for is exactly what the
quarantine exists to prevent.

**Covers:** AC9, AC10, AC25.
**Feature plan:** task 4 (plus the `error` half of task 7's mirror).

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Modify: `pwa/src/lib/types.ts` (lockstep, AC25)
- Modify: `pwa/src/components/Transcript.tsx` (delete `case 'error':`)
- Test: `daemon/test/tail.test.ts`

**Interfaces:** `{ kind: 'thinking'; at: string; text: string }` replaces `{ kind: 'thinking'; at: string }`; the `error` member is gone. Task 9 renders thinking.

> **Why all four files in one commit.** Removing `error` from the mirror makes
> `Transcript.tsx`'s `case 'error':` narrow `e` to `never`, so `e.message`
> stops typechecking. AC25 requires the mirror to move with the daemon union in
> the *same* commit, so the renderer arm goes with it and the root gate stays
> green. (The feature plan's Task 4 offers a red-gate commit here; AC25
> overrides that — see Correction 3.)

- [ ] **Step 1: Write the failing test**

```ts
describe('thinking blocks carry their text (story-1)', () => {
  it('emits a thinking event with the reasoning text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'the config is probably stale' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(normalizeLine(line)).toEqual([
      { kind: 'thinking', at: '2026-09-06T10:00:00.000Z', text: 'the config is probably stale' },
    ]);
  });

  it('keeps thinking, prose, and a tool call from one message, in source order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check the file first' },
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(normalizeLine(line).map((e) => e.kind)).toEqual(['assistant', 'thinking', 'tool']);
  });
});
```

The expected order is the joined prose first, then the non-text blocks in
source order — the shape `assistantEvents` produces.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — thinking blocks are ignored, so the first gets `[]` and the
second omits `'thinking'`.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/tail.ts`:

```ts
  | { kind: 'thinking'; at: string; text: string }
```

and **delete** the `error` member entirely:

```ts
  | { kind: 'error'; at: string; message: string }   // <-- remove this line
```

Handle the block in `assistantEvents`, in the same loop, and widen the local cast:

```ts
    const block = b as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
```

```ts
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      rest.push({ kind: 'thinking', at, text: block.thinking });
    }
```

- [ ] **Step 4: Mirror and drop the dead renderer arm (AC25, same commit)**

In `pwa/src/lib/types.ts`: `thinking` gains `text: string`; **delete** the
`error` member.

In `pwa/src/components/Transcript.tsx`: **delete** the `case 'error':` arm.
Leave `case 'thinking':` rendering the literal `thinking…` for now — Task 9
replaces it. Task 1's `default: return null` stays last.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green — daemon and PWA together.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts pwa/src/lib/types.ts pwa/src/components/Transcript.tsx
git commit -m "feat(adapter): thinking carries its text; drop the never-constructed error kind (story-1)"
```

---

## Task 6: Carry the full tool input so diffs can be rendered

`summarizeToolInput` returns the **first** matching key from a fixed list,
truncated to 120 characters, and every other field is discarded before it
leaves the daemon. An `Edit`'s `old_string` / `new_string`, a `Write`'s
`content` and a `TodoWrite`'s todos never cross the wire, so no renderer can
show a diff or an expanded call.

`summary` is unchanged and still drives the collapsed one-liner (AC11).

**Covers:** AC11, AC12, AC13, AC25.
**Feature plan:** task 5.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Modify: `pwa/src/lib/types.ts` (lockstep, AC25)
- Test: `daemon/test/tail.test.ts`

**Interfaces:** `tool` becomes `{ kind: 'tool'; at: string; id: string; name: string; summary: string; input: Record<string, unknown>; truncated: boolean }`. Tasks 8 and 11 consume `input`.

- [ ] **Step 1: Write the failing test**

```ts
describe('tool events carry their full input (story-1)', () => {
  it('keeps every input field, not just the summary key', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Edit', input: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } }],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    expect(ev).toMatchObject({ kind: 'tool', name: 'Edit', summary: 'a.ts', truncated: false });
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.input).toEqual({ file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  });

  it('caps each oversized string field individually and flags the event, keeping the object shape', () => {
    const huge = 'y'.repeat(40_000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Write', input: { file_path: 'a.ts', content: huge } }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.truncated).toBe(true);
    expect(String(ev.input.content).length).toBeLessThanOrEqual(32_001);
    // The shape survives: DiffView addresses fields by name (AC12).
    expect(ev.input.file_path).toBe('a.ts');
  });

  it('keeps non-string input fields untouched, so a MultiEdit edit array and a TodoWrite list still ship', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } }],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.input.edits).toEqual([{ old_string: 'x', new_string: 'y' }]);
  });

  it('yields an empty input object when the tool input is not an object (AC13)', () => {
    for (const input of ['just a string', 42, null, ['an', 'array']]) {
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Weird', input }] },
        timestamp: '2026-09-06T10:00:00.000Z',
      });
      const ev = normalizeLine(line)[0];
      if (ev?.kind !== 'tool') throw new Error('expected tool');
      expect(ev.input).toEqual({});
      expect(ev.truncated).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — `tool` events have no `input` or `truncated` field.

- [ ] **Step 3: Write the implementation**

Add the input capper beside `capText`:

```ts
/**
 * Cap each string field individually rather than the serialized whole, so the
 * object KEEPS ITS SHAPE. DiffView (PWA) needs old_string/new_string to still
 * be present and addressable by name even when one of them was too big to
 * ship whole (story-1 AC12).
 */
function capInput(input: unknown): { input: Record<string, unknown>; truncated: boolean } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { input: {}, truncated: false };
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const capped = capText(v);
      out[k] = capped.text;
      if (capped.truncated) truncated = true;
    } else {
      out[k] = v;
    }
  }
  return { input: out, truncated };
}
```

Widen the union member:

```ts
  | { kind: 'tool'; at: string; id: string; name: string; summary: string; input: Record<string, unknown>; truncated: boolean }
```

And update the `tool_use` branch in `assistantEvents`:

```ts
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const capped = capInput(block.input);
      rest.push({
        kind: 'tool',
        at,
        id: block.id ?? '',
        name: block.name,
        summary: summarizeToolInput(block.input),
        input: capped.input,
        truncated: capped.truncated,
      });
    }
```

`summarizeToolInput` stays **unchanged** and still reads the uncapped original
— correct, because it truncates to 120 characters itself (AC11).

- [ ] **Step 4: Mirror in the PWA (AC25, same commit)**

Same widened `tool` member in `pwa/src/lib/types.ts`.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts pwa/src/lib/types.ts
git commit -m "feat(adapter): tool events carry their id and full capped input (story-1)"
```

> **Daemon layer complete here.** `pwa/src/lib/types.ts` is now a byte-faithful
> mirror of the daemon union. Verify by eye before moving on: same members,
> same field names, same optionality — with `askUserQuestion.selectedLabels`
> still `string[][]`.

---

## Task 7: Render tool results instead of empty grey boxes

**Covers:** AC17.
**Feature plan:** task 8 (first half).

**Files:**
- Create: `pwa/src/components/transcript/ToolResult.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-tools.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-tools.test.tsx` — note the jsdom docblock (Correction 2):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToolResult } from '../src/components/transcript/ToolResult.js';

afterEach(cleanup);

const ok = { kind: 'toolResult' as const, at: '', toolUseId: 'toolu_a', ok: true, text: 'all 42 tests passed', truncated: false };

describe('ToolResult', () => {
  it('collapses to a one-line preview and expands on tap', () => {
    render(<ToolResult e={{ ...ok, text: 'first line\nsecond line' }} />);
    expect(screen.queryByText(/second line/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/second line/)).toBeInTheDocument();
  });

  it('tints a failed result', () => {
    const { container } = render(<ToolResult e={{ ...ok, ok: false, text: 'boom' }} />);
    expect(container.innerHTML).toContain('red');
  });

  it('marks a truncated result when expanded', () => {
    render(<ToolResult e={{ ...ok, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('shows a placeholder rather than an empty row for an empty result', () => {
    render(<ToolResult e={{ ...ok, text: '' }} />);
    expect(screen.getByRole('button').textContent).toMatch(/empty result/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-tools.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `pwa/src/components/transcript/ToolResult.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

const PREVIEW_CHARS = 100;

/**
 * Before this component every non-AskUserQuestion tool result rendered as an
 * EMPTY GREY BORDERED BOX, because the daemon modelled no tool_result kind at
 * all (story-1 AC6/AC17). Plain text in a <pre>, never markdown and never
 * HTML: a tool result is arbitrary model/command output (T7/T11).
 */
export function ToolResult({ e }: { e: Extract<TranscriptEvent, { kind: 'toolResult' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  const firstLine = e.text.split('\n', 1)[0] ?? '';
  const preview = firstLine.length > PREVIEW_CHARS ? `${firstLine.slice(0, PREVIEW_CHARS)}…` : firstLine;
  const tone = e.ok ? 'text-zinc-500' : 'text-red-400';

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className={`w-full text-left font-mono text-[13.5px] ${tone}`}>
        <span>{open ? '▾ ' : '▸ '}</span>
        {e.ok ? '' : 'error · '}
        {preview || '(empty result)'}
      </button>
      {open && (
        <pre className={`mt-1 rounded border border-zinc-800 bg-zinc-900/60 p-2 overflow-x-auto whitespace-pre-wrap font-mono text-[13px] ${e.ok ? 'text-zinc-300' : 'text-red-300'}`}>
          {e.text}
          {e.truncated ? '\n\n[truncated]' : ''}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the dispatcher**

In `pwa/src/components/Transcript.tsx`, import `ToolResult` and add, before `default`:

```tsx
    case 'toolResult':
      return <Gutter><ToolResult e={e} /></Gutter>;
```

- [ ] **Step 5: Run the tests, gate, commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/components/transcript/ToolResult.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-tools.test.tsx
git commit -m "feat(pwa): render tool results as an expandable preview instead of an empty box (story-1 AC17)"
```

---

## Task 8: Make tool calls collapse to one line, expandable on tap

`docs/functional-spec.md` promises *"Tool calls collapse to one line each,
expandable on tap"*. `Transcript.tsx` contains zero `onClick`, zero `useState`
and no `<details>` — tap-to-expand has **never** existed. This task is where
that line stops being aspirational.

**Covers:** AC18, and the non-diff half of AC23.
**Feature plan:** task 8 (second half).

**Files:**
- Create: `pwa/src/components/transcript/ToolCall.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: extend `pwa/test/transcript-tools.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `pwa/test/transcript-tools.test.tsx` (add `ToolCall` to the imports):

```tsx
const toolEvent = {
  kind: 'tool' as const, at: '', id: 'toolu_a', name: 'Bash',
  summary: 'npm test', input: { command: 'npm test', description: 'run the suite' }, truncated: false,
};

describe('ToolCall', () => {
  it('collapses to the tool name and summary', () => {
    render(<ToolCall e={toolEvent} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText(/run the suite/)).toBeNull();
  });

  it('expands on tap to reveal every input field', () => {
    render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/run the suite/)).toBeInTheDocument();
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
  });

  it('flags a truncated payload when expanded', () => {
    render(<ToolCall e={{ ...toolEvent, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('keeps a non-string field visible, so a MultiEdit edit array survives (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/old_string/)).toBeInTheDocument();
  });

  it('says so rather than rendering an empty box when there is no input', () => {
    render(<ToolCall e={{ ...toolEvent, input: {} }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/no input/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-tools.test.tsx`
Expected: FAIL — `ToolCall` does not exist.

- [ ] **Step 3: Write the implementation**

Create `pwa/src/components/transcript/ToolCall.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * The extension's collapsed tool line, expandable on tap — finally
 * implementing functional-spec.md's long-standing promise (story-1 AC18).
 * Input is rendered as plain text inside <pre>, never as markdown or HTML: it
 * is arbitrary model output (T7/T11), and it is displayed, never acted on.
 */
export function ToolCall({ e }: { e: Extract<TranscriptEvent, { kind: 'tool' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(e.input);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left font-mono text-[14.5px] text-zinc-400"
      >
        <span className="text-zinc-500">{open ? '▾ ' : '▸ '}</span>
        <span className="text-amber-400 font-semibold">{e.name}</span>
        {e.summary ? ` · ${e.summary}` : ''}
      </button>
      {open && (
        <div className="mt-1 rounded border border-zinc-800 bg-zinc-900/60 p-2 overflow-x-auto">
          {entries.length === 0 && <div className="text-[13px] text-zinc-500">no input</div>}
          {entries.map(([k, v]) => (
            <div key={k} className="text-[13px]">
              <span className="text-zinc-500">{k}: </span>
              <pre className="inline whitespace-pre-wrap font-mono text-zinc-300">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </pre>
            </div>
          ))}
          {e.truncated && <div className="mt-1 text-[12px] text-amber-500">payload truncated</div>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the dispatcher**

In `pwa/src/components/Transcript.tsx`, replace the inline `case 'tool':` body with:

```tsx
    case 'tool':
      return <Gutter><ToolCall e={e} /></Gutter>;
```

- [ ] **Step 5: Run the tests, gate, commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/components/transcript/ToolCall.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-tools.test.tsx
git commit -m "feat(pwa): tool calls collapse to one line and expand to their full input (story-1 AC18)"
```

---

## Task 9: Render thinking with its reasoning text

`Transcript.tsx` renders a literal, content-free `thinking…`. Task 5 made the
event carry real text, so the marker becomes expandable. The marker stays the
**default** — `docs/functional-spec.md`'s rule is that thinking is a marker,
not a wall of text.

**Covers:** AC19.
**Feature plan:** task 9.

**Files:**
- Create: `pwa/src/components/transcript/Thinking.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-thinking.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-thinking.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Thinking } from '../src/components/transcript/Thinking.js';

afterEach(cleanup);

const e = { kind: 'thinking' as const, at: '', text: 'the config is probably stale' };

describe('Thinking', () => {
  it('shows a marker, not a wall of text, until tapped', () => {
    render(<Thinking e={e} />);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
    expect(screen.queryByText(/probably stale/)).toBeNull();
  });

  it('reveals the reasoning on tap, and hides it again', () => {
    render(<Thinking e={e} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/probably stale/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/probably stale/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-thinking.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `pwa/src/components/transcript/Thinking.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * functional-spec.md: "Thinking renders as a marker, not a wall of text." The
 * marker stays the default; the text is now available on tap, which it never
 * was before — the event carried no text at all (story-1 AC9/AC19). Plain
 * text, never markdown and never HTML (T7/T11).
 */
export function Thinking({ e }: { e: Extract<TranscriptEvent, { kind: 'thinking' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="italic text-zinc-500 text-[14.5px] text-left">
        {open ? '▾ ' : '▸ '}thinking…
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-zinc-800 pl-2 italic whitespace-pre-wrap text-[14px] text-zinc-500">
          {e.text}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the dispatcher**

In `pwa/src/components/Transcript.tsx`, replace `case 'thinking':` with:

```tsx
    case 'thinking':
      return <Gutter><Thinking e={e} /></Gutter>;
```

- [ ] **Step 5: Run the tests, gate, commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/components/transcript/Thinking.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-thinking.test.tsx
git commit -m "feat(pwa): the thinking marker expands to its reasoning text (story-1 AC19)"
```

---

## Task 10: A pure lineDiff helper

No diff library is added. A common-prefix / common-suffix trim is enough for
the single contiguous change `Edit` and `Write` produce, and it keeps the phone
bundle flat.

**Covers:** AC21, AC24.
**Feature plan:** task 11 (first half).

**Files:**
- Create: `pwa/src/lib/diff.ts`
- Test: `pwa/test/diff.test.ts` (new)

**Interfaces:** produces `lineDiff(oldText, newText): DiffLine[]` where `DiffLine = { type: 'ctx' | 'del' | 'add'; text: string }`. React-independent (AC24), so this test file stays on the **node** environment — no jsdom docblock.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { lineDiff } from '../src/lib/diff.js';

describe('lineDiff', () => {
  it('marks a changed middle line and keeps the surrounding context', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('handles a pure addition', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('handles a pure deletion', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('reports no change as all context', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'ctx', text: 'b' },
    ]);
  });

  it('renders a whole-file write as all additions', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { type: 'del', text: '' },
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('caps runaway context so a one-line edit in a big file stays a small hunk (AC21)', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const edited = big.replace('line 100', 'line 100 changed');
    const out = lineDiff(big, edited);
    expect(out.length).toBeLessThan(20);
    expect(out.some((l) => l.type === 'add' && l.text === 'line 100 changed')).toBe(true);
    expect(out.filter((l) => l.type === 'ctx').length).toBeLessThanOrEqual(6);
  });
});
```

> The all-additions case asserts a leading `{ type: 'del', text: '' }`: an
> empty `oldText` splits to `['']`, which is a real (empty) line the trim
> cannot match. Assert the behaviour rather than pretend it away — `DiffView`
> renders it as a `- ` row with nothing after it, which is honest for a file
> that had no prior content.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- diff.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `pwa/src/lib/diff.ts`:

```ts
export interface DiffLine {
  type: 'ctx' | 'del' | 'add';
  text: string;
}

const CONTEXT_LINES = 3;

/**
 * Single-hunk line diff by common-prefix / common-suffix trim. Deliberately
 * NOT a full LCS: Edit and Write produce one contiguous change, and this
 * avoids adding a diff dependency to the phone's bundle (story-1 AC24).
 *
 * Context is capped at CONTEXT_LINES either side, so a one-line edit inside a
 * large file renders as a small hunk rather than the whole file (AC21).
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  const leadFrom = Math.max(0, prefix - CONTEXT_LINES);
  // `?? ''` rather than `!` — noUncheckedIndexedAccess is on, and an assertion
  // here would be a lie the compiler cannot check.
  for (let i = leadFrom; i < prefix; i++) out.push({ type: 'ctx', text: a[i] ?? '' });
  for (let i = prefix; i < a.length - suffix; i++) out.push({ type: 'del', text: a[i] ?? '' });
  for (let i = prefix; i < b.length - suffix; i++) out.push({ type: 'add', text: b[i] ?? '' });

  const tailStart = a.length - suffix;
  const tailEnd = Math.min(a.length, tailStart + CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i++) out.push({ type: 'ctx', text: a[i] ?? '' });

  return out;
}
```

- [ ] **Step 4: Run the tests, gate, commit**

```bash
npm --prefix pwa test -- diff.test.ts
npm run typecheck && npm run lint && npm test
git add pwa/src/lib/diff.ts pwa/test/diff.test.ts
git commit -m "feat(pwa): pure lineDiff helper with capped context (story-1 AC21/AC24)"
```

---

## Task 11: Render red and green diffs for Edit, MultiEdit and Write

With Task 6 shipping the full tool input, an `Edit`'s `old_string` and
`new_string` finally reach the phone. The extension shows an inline red/green
diff; MicroViber shows a file path and nothing else.

**Covers:** AC20, AC22, AC23.
**Feature plan:** task 11 (second half).

**Files:**
- Create: `pwa/src/components/transcript/DiffView.tsx`
- Modify: `pwa/src/components/transcript/ToolCall.tsx`
- Test: extend `pwa/test/transcript-tools.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `pwa/test/transcript-tools.test.tsx`:

```tsx
describe('ToolCall diff branch', () => {
  it('renders a red/green diff for an Edit when expanded (AC20)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', summary: 'a.ts', input: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const a = 2;/)).toBeInTheDocument();
  });

  it('renders a Write as an all-addition diff (AC20)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Write', summary: 'a.ts', input: { file_path: 'a.ts', content: 'line one\nline two' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/\+ line one/)).toBeInTheDocument();
    expect(screen.getByText(/\+ line two/)).toBeInTheDocument();
  });

  it('gives the diff its own horizontal scroll container, so a long line never scrolls the transcript (AC22)', () => {
    const { container } = render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { old_string: 'a'.repeat(400), new_string: 'b'.repeat(400) } }} />);
    fireEvent.click(screen.getByRole('button'));
    const pre = container.querySelector('pre.overflow-x-auto');
    expect(pre).not.toBeNull();
  });

  it('still lists every other input field beside the diff (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/file_path/)).toBeInTheDocument();
  });

  it('renders no diff for a tool whose input has no edit strings', () => {
    const { container } = render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('pre.overflow-x-auto')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-tools.test.tsx`
Expected: FAIL — no diff is rendered.

- [ ] **Step 3: Create DiffView**

Create `pwa/src/components/transcript/DiffView.tsx`:

```tsx
import type { ReactElement } from 'react';
import { lineDiff } from '../../lib/diff.js';

const TONE = {
  ctx: 'text-zinc-500',
  del: 'bg-red-950/40 text-red-300',
  add: 'bg-emerald-950/40 text-emerald-300',
} as const;

const SIGIL = { ctx: '  ', del: '- ', add: '+ ' } as const;

/**
 * Inline red/green diff, matching how the extension shows a file edit
 * (story-1 AC20). `overflow-x-auto` on the <pre> is load bearing: a long
 * edited line must scroll INSIDE this box, never scroll the whole transcript
 * sideways (AC22). Diff text is arbitrary model output — plain children of a
 * <pre>, never markdown, never HTML (T7/T11).
 */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }): ReactElement {
  const lines = lineDiff(oldText, newText);
  return (
    <pre className="mt-1 overflow-x-auto rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[12.5px] leading-snug">
      {lines.map((l, i) => (
        <div key={`${i}:${l.type}`} className={TONE[l.type]}>
          {SIGIL[l.type]}
          {l.text}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 4: Branch ToolCall onto the diff**

In `pwa/src/components/transcript/ToolCall.tsx`, import `DiffView` and add
above the component:

```tsx
import { DiffView } from './DiffView.js';

/** Tools whose input describes a file edit the extension renders as a diff. */
function diffOf(e: Extract<TranscriptEvent, { kind: 'tool' }>): { oldText: string; newText: string } | null {
  const { old_string: oldS, new_string: newS, content } = e.input;
  if (typeof oldS === 'string' && typeof newS === 'string') return { oldText: oldS, newText: newS };
  // A Write replaces the whole file: everything is an addition.
  if (e.name === 'Write' && typeof content === 'string') return { oldText: '', newText: content };
  return null;
}
```

and inside the `open` block, **above** the key/value list:

```tsx
          {(() => {
            const d = diffOf(e);
            return d ? <DiffView oldText={d.oldText} newText={d.newText} /> : null;
          })()}
```

**Keep the key/value list for every field**, so a `MultiEdit`'s `edits` array
and a `TodoWrite`'s todos stay visible (AC23). Do not filter `old_string` /
`new_string` out of it — the story asks for "every other input field still
appears", and dropping them would make a truncated edit undiagnosable.

- [ ] **Step 5: Run the tests, gate, commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/lib/diff.ts pwa/src/components/transcript/DiffView.tsx pwa/src/components/transcript/ToolCall.tsx pwa/test/diff.test.ts pwa/test/transcript-tools.test.tsx
git commit -m "feat(pwa): inline red/green diffs for Edit, MultiEdit and Write (story-1 AC20-AC23)"
```

---

## Task 12: Full-gate verification and story reconciliation

**Covers:** AC26, and closes the story.

- [ ] **Step 1: Run the whole gate from the repo root**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: exit 0 on all three. Compare against the baseline table at the top —
daemon ≥ 534 + the new cases, pwa ≥ 189 + the new cases, **zero** failures.

- [ ] **Step 2: Confirm the mirror is faithful**

Diff the two unions by eye:

```bash
sed -n '/export type TranscriptEvent/,/^$/p' daemon/src/lib/claude-adapter/tail.ts
sed -n '/export type TranscriptEvent/,/^$/p' pwa/src/lib/types.ts
```

Every member, field name and optionality must match, with no `error` member on
either side, and `askUserQuestion.selectedLabels` still `string[][]`.

- [ ] **Step 3: Confirm no T7 regression**

```bash
grep -rn 'dangerouslySetInnerHTML\|innerHTML\|rehype-raw' pwa/src
```

Expected: no hits in any file this story touched. (`container.innerHTML` inside
a *test* is a read-only assertion and is fine.)

- [ ] **Step 4: Confirm the branch is only this story**

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```

Every commit subject must be this story's; every touched file must be in the
story's "Affected Files" list, plus the planning docs and this plan. The shared
checkout means a sibling session's commit can land on a branch — if a foreign
commit appears here, stop and ask.

- [ ] **Step 5: Mark the story done**

Set `status: done` in `docs/features/microviber-track-c/stories/story-1.md` and
update the row in `docs/features/microviber-track-c/stories/README.md`.
`syncounter-code-review` → `create-qa-pr` handles the issue close and the PR.

---

## Out of scope for this story

Recorded so review does not read these as omissions:

- **Assistant prose sharing a message with an `AskUserQuestion`.** The detection keeps its single-event short-circuit: `resolveAskUserQuestions` depends on exactly one such event per line, and it is the most security-sensitive logic in the adapter (AC14).
- **`MultiEdit` rendered as several separate diffs.** The first `old_string`/`new_string` pair at the top level diffs; the `edits` array stays visible in the key/value list (AC23).
- **`injected` stamping** (feature-plan task 6) and **user-turn newline preservation / `UserTurn.tsx`** (feature-plan task 7's other half) — story-7, [#43](https://github.com/yarivsnapir/MicroViber/issues/43).
- **Code-block styling, syntax highlighting, GFM tables** (feature-plan task 10) — story-6, [#42](https://github.com/yarivsnapir/MicroViber/issues/42).
- **Scroll-follow-while-pinned** (feature-plan task 12) — story-8, [#44](https://github.com/yarivsnapir/MicroViber/issues/44).
