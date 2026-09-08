# MicroViber Track C — Feature C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## SCOPE: Feature C only
>
> This plan covers **Feature C (transcript rendering parity)** from
> `docs/features/microviber-track-c/spec.md` §4, and nothing else.
>
> **Feature A (terminal pane) and Feature B (new-session button) are NOT planned
> here.** They are a separate, independent cluster and will be appended to this
> same file when they are planned. Do not implement them from this document.
>
> Per the spec's §1 "Guidance for story breakdown", Feature C has no dependency
> on A or B in either direction, so it can be built and shipped on its own.

**Goal:** Make the phone's transcript actually render like the Claude Code VS Code extension, by first fixing the daemon-side normalizer that is silently discarding transcript data and then rebuilding the renderer on top of the widened stream.

**Architecture:** Two layers, strictly ordered. `daemon/src/lib/claude-adapter/tail.ts` currently collapses each transcript line to at most one event, which drops assistant prose that shares a message with a tool call, drops all but the last tool call, models no tool results at all, and never emits thinking. Tasks 1 to 6 widen the normalizer inside the adapter quarantine and stamp `injected` in the services layer, where the prompt lifecycle actually lives. Tasks 7 to 12 then split `pwa/src/components/Transcript.tsx` into per-kind components that consume the new fields.

**Tech Stack:** TypeScript (strict), Node 22, Vitest, zod on the daemon; React 19, Vite, Tailwind 4, react-markdown on the PWA.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Quality gate before every commit:** `npm run typecheck && npm run lint && npm test`, run from the repo root, all green. This is the CI gate (`docs/architecture-spec.md` §6).
- **TS strictness** per `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. Indexed access yields `T | undefined` — guard it or assert it, never ignore it.
- **No `any`.** `@typescript-eslint/no-explicit-any` is an error. Any `any` needs a `// reason:` comment to survive review.
- **Adapter quarantine (FENCE 2).** Only `daemon/src/lib/claude-adapter/` may model Claude Code internals or reference `~/.claude` paths. The transcript entry vocabulary is such an internal, so all normalizer work stays in that directory.
- **Layering fence.** `schemas/ → domain/ → services/ → api/`, no upward imports. The adapter must never import from `domain/`. This is why `injected` is stamped in `services/`, not in `tail.ts` (Task 6).
- **PWA fence (FENCE 1).** `pwa/` must never import from `daemon/`. `pwa/src/lib/types.ts` is a **hand-maintained mirror** of the daemon's `TranscriptEvent` union and must be updated in lockstep — see Task 7.
- **T7 (the highest-consequence threat row).** Transcript content is arbitrary model output and scraped web text. It is rendered as sanitized markdown through react-markdown's React tree. **Never** `innerHTML`, **never** `dangerouslySetInnerHTML`, never `rehype-raw`. The PWA CSP is `script-src 'self'` with no `unsafe-eval` and no `wasm-unsafe-eval`; no task may loosen it.
- **T11.** MicroViber displays transcript content and never executes or acts on it. Widening what is displayed is in scope; acting on it is not.
- **T9.** `SessionSummary` is an explicit field allowlist. Feature C adds no field to it.
- **Repo-relative paths only** in code, tests, and docs. Never absolute paths.
- **Working directory.** The repo's shared working tree is checked out to another active session's branch. Work in the worktree for `feature/microviber-track-c` and run every git command with that worktree as cwd. Never check out a branch in the primary checkout.

---

## File Structure

### Daemon — changed

| File | Responsibility after this plan |
|---|---|
| `daemon/src/lib/claude-adapter/schemas.ts` | Gains `ThinkingBlock`, gains `is_error` on `ToolResultBlock`, and adds both blocks to the `Content` union so they stop falling through the passthrough catch-all. |
| `daemon/src/lib/claude-adapter/tail.ts` | `TranscriptEvent` widens; `normalizeLine` returns an **array**; a block walker emits events in source order; payload size caps live here. |
| `daemon/src/domain/prompt-lifecycle.ts` | Gains `wasInjected(sessionId, text)` — the correlation `injected` needs. |
| `daemon/src/services/services.ts` | `getTranscript` stamps `injected` after `parseChunk`, which is the only layer that can see both the adapter's events and the domain's prompt records. |

### PWA — changed and created

| File | Responsibility |
|---|---|
| `pwa/src/lib/types.ts` | Mirror of the widened daemon union. |
| `pwa/src/components/Transcript.tsx` | Shrinks to a scroll container plus a per-kind dispatcher. |
| `pwa/src/components/transcript/UserTurn.tsx` | **New.** User prompt block; preserves newlines; the live "From phone" treatment. |
| `pwa/src/components/transcript/ToolCall.tsx` | **New.** Collapsed one-liner, expandable to full input. |
| `pwa/src/components/transcript/ToolResult.tsx` | **New.** Collapsed result, expandable; error tint. |
| `pwa/src/components/transcript/Thinking.tsx` | **New.** Collapsed marker, expandable to reasoning text. |
| `pwa/src/components/transcript/CodeBlock.tsx` | **New.** Styled, horizontally scrollable code block used by the markdown renderer. |
| `pwa/src/components/transcript/DiffView.tsx` | **New.** Red/green line diff for `Edit` / `MultiEdit` / `Write`. |
| `pwa/src/lib/diff.ts` | **New.** Pure `lineDiff` helper, unit-testable without React. |
| `pwa/src/lib/markdown.tsx` | Gains a `code` component override and the GFM + highlight plugins. Anchor logic untouched. |
| `pwa/src/index.css` | Gains the highlight theme import. |
| `pwa/package.json` | Adds `remark-gfm`, `rehype-highlight`, `highlight.js`; removes the unused `clsx`. |

### A correction to the spec's §4.2 wording, decided here

The spec says syntax highlighting via **`highlight.js`**. Implemented literally that is a **T7 violation**: `hljs.highlight()` returns an HTML **string**, which can only be injected with `dangerouslySetInnerHTML`, the exact API T7 forbids.

This plan therefore uses **`rehype-highlight`**, which wraps `lowlight`, which *is* highlight.js — same grammars, same language coverage, same bundle story, same "no WASM, no eval" CSP story. The difference is that it emits a **hast tree** that react-markdown renders as ordinary React elements, so no HTML string is ever injected. This satisfies the spec's intent and strengthens T7 rather than weakening it. Record it in the spec when Task 10 lands.

---

## Task 1: Model thinking and tool_result blocks in the adapter schema

Today `Content` in `daemon/src/lib/claude-adapter/schemas.ts` is a union of `TextBlock`, `ToolUseBlock`, and a `z.object({ type: z.string() }).passthrough()` catch-all. `ToolResultBlock` is declared right above it but is **not** in the union, and there is no thinking block at all. Both therefore parse as anonymous passthrough objects that `normalizeContent` cannot recognise.

**Quarantine note:** this file is explicitly documented as "the ONLY place that models Claude Code internals". Adding block shapes here is exactly where this belongs; nothing outside `lib/claude-adapter/` changes in this task.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/schemas.ts`
- Test: `daemon/test/schemas.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ThinkingBlock` (zod schema for `{ type: 'thinking', thinking: string }`), and `ToolResultBlock` gaining an optional `is_error: boolean`. Both are members of `Content`. Tasks 2 through 5 rely on these parsing into typed shapes.

- [ ] **Step 1: Write the failing test**

Append to `daemon/test/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TranscriptLineSchema } from '../src/lib/claude-adapter/schemas.js';

describe('Content models thinking and tool_result blocks (track-c task 1)', () => {
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

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- schemas.test.ts`
Expected: FAIL. The thinking case fails its `toEqual` because the passthrough catch-all preserves the object but the assertion is exact and the block is not modelled; the `is_error` case fails because `ToolResultBlock` has no such field and the catch-all keeps it untyped.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/schemas.ts`, add `ThinkingBlock` next to the other block schemas and extend `ToolResultBlock`:

```ts
/**
 * Extended reasoning block. Modelled (track-c task 1) so tail.ts can emit its
 * text instead of letting it fall through the Content catch-all, where a
 * thinking-only assistant line normalized to an empty assistant event and
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
  // tint a failure without string-sniffing the result body (track-c task 3).
  is_error: z.boolean().optional(),
});
```

Then add both to the `Content` union. The passthrough catch-all stays last, so any future block kind still parses rather than failing the whole line:

```ts
const Content = z.union([
  z.string(),
  z.array(z.union([TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, z.object({ type: z.string() }).passthrough()])),
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix daemon test -- schemas.test.ts`
Expected: PASS.

Then run the full daemon suite to prove nothing regressed, because `ask-user-question.ts` and `transcript-meta.ts` both parse the same lines:

Run: `npm --prefix daemon test`
Expected: PASS, all files.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/schemas.ts daemon/test/schemas.test.ts
git commit -m "feat(adapter): model thinking and tool_result content blocks (track-c task 1)"
```

---

## Task 2: normalizeLine returns an array so prose and every tool call survive

Two defects share one cause. `normalizeLine` returns at most one event, and its assistant branch reads:

```ts
if (blocks.tool) {
  return { kind: 'tool', at, name: blocks.tool.name, summary: blocks.tool.summary };
}
return { kind: 'assistant', at, text: blocks.text ?? '' };
```

So an assistant message carrying prose **and** a tool call drops the prose. And inside `normalizeContent`, `tool` is reassigned on each iteration, so a message with several tool calls keeps only the last.

This task changes the return type to `TranscriptEvent[]` and emits the text event followed by each tool event in source order. It deliberately does **not** touch the `AskUserQuestion` short-circuit, which stays a whole-content detection returning a single event — that logic is the most security-sensitive and most-tested code in the adapter, and destabilising it is not worth the edge case of prose sharing a message with a question. That edge case is recorded as out of scope at the end of this plan.

**Quarantine note:** entirely inside `lib/claude-adapter/`. No new dependency on `domain/` or `services/`.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Test: `daemon/test/tail.test.ts`

**Interfaces:**
- Consumes: `Content` from Task 1.
- Produces: `normalizeLine(line: string): TranscriptEvent[]` (was `TranscriptEvent | null`). `parseChunk`'s signature is unchanged. Tasks 3, 4, and 5 add further event kinds to the same walker.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/tail.test.ts`:

```ts
describe('normalizeLine emits every block (track-c task 2)', () => {
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
    expect(events[1]).toMatchObject({ kind: 'tool', name: 'Read' });
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

  it('returns an empty array for an unparseable line', () => {
    expect(normalizeLine('not json')).toEqual([]);
    expect(normalizeLine('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL. Compilation fails first, because the existing tests treat `normalizeLine`'s result as a single event or `null`. That is the expected signal that the call sites in the test file need updating in Step 3.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/tail.ts`, replace `normalizeLine`, `NormalizedContent`, and `normalizeContent` with a block walker. Keep `summarizeToolInput` exactly as it is; it still produces the collapsed one-liner.

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
  // single-event shape: tail.ts and transcript-meta.ts share that detection
  // through ask-user-question.ts, and the cross-line resolution pass below
  // depends on exactly one askUserQuestion event per line.
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
  // markdown (spec §4, the "newlines in the wrong place" report).
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

Note the `tool` event now carries `id`. Add it to the union in the same file:

```ts
  | { kind: 'tool'; at: string; id: string; name: string; summary: string }
```

Then update `parseChunk` to flatten the arrays, preserving the line index each event came from:

```ts
  const withIndex: { event: TranscriptEvent; lineIndex: number }[] = [];
  lines.forEach((line, i) => {
    for (const ev of normalizeLine(line)) withIndex.push({ event: ev, lineIndex: i });
  });
```

`resolveAskUserQuestions` needs no change: it drops by `lineIndex`, and every event from a consumed line shares that index, so a consumed line's whole output is dropped together.

- [ ] **Step 4: Update the existing tests that assert the old single-event shape**

These are **deliberate updates, not deletions**. Each existing `normalizeLine(...)` call site in `daemon/test/tail.test.ts` that expects one event or `null` becomes an array assertion. For example the test at the top of the file:

```ts
  it('normalizes a plain user turn (not injected)', () => {
    const events = normalizeLine(userLine('run the tests', '2026-08-23T11:00:00.000Z'));
    expect(events).toEqual([{ kind: 'user', at: '2026-08-23T11:00:00.000Z', text: 'run the tests', injected: false }]);
  });
```

`injected` stays `false` at this layer on purpose. The adapter cannot import `domain/`, so the correlation happens in `services/` — see Task 6.

The `'a non-AskUserQuestion tool_use is unaffected'` test now also asserts the new `id` field.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: PASS.

Run: `npm --prefix daemon test`
Expected: PASS. Pay attention to `transcript-meta.test.ts` and `services.test.ts` — they consume `parseChunk`, whose signature is unchanged, so they should be untouched. If either fails, the flattening in `parseChunk` is wrong; fix it rather than the test.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "feat(adapter): normalizeLine returns an array so prose and every tool call survive (track-c task 2)"
```

---

## Task 3: Emit toolResult events and stop rendering blank user bubbles

`normalizeContent` never recognised `tool_result`, so a user line carrying only a tool result produced `text: ''` and rendered on the phone as an **empty grey bordered box**. Every non-`AskUserQuestion` tool result in every session looks like that today.

`daemon/test/tail.test.ts` currently **asserts that broken behaviour** at the test named `'an ordinary tool_result for a non-AskUserQuestion tool is unaffected (pre-existing behavior, untouched)'`, with the comment `// tool event + the pre-existing blank user bubble — unchanged, out of this task's scope`. That assertion is deliberately updated here — it was scoped out of the earlier story, and this is the task that owns it.

**Quarantine note:** inside `lib/claude-adapter/`. The `AskUserQuestion` consumption path must keep working: a tool_result line that resolves a pending question is still dropped entirely, so it must not start emitting a `toolResult` event that survives.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Test: `daemon/test/tail.test.ts`

**Interfaces:**
- Consumes: `ToolResultBlock` with `is_error` from Task 1; `userEvents` from Task 2.
- Produces: event kind `{ kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }`. Task 8 renders it; Task 7 mirrors it.

- [ ] **Step 1: Write the failing test**

```ts
describe('tool results become their own event (track-c task 3)', () => {
  it('emits a toolResult instead of a blank user bubble', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok, 3 files changed' }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    const events = normalizeLine(line);
    expect(events).toEqual([
      { kind: 'toolResult', at: '2026-09-06T10:00:02.000Z', toolUseId: 'toolu_a', ok: true, text: 'ok, 3 files changed', truncated: false },
    ]);
  });

  it('marks is_error results as not ok', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'boom', is_error: true }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    const events = normalizeLine(line);
    expect(events[0]).toMatchObject({ kind: 'toolResult', ok: false, text: 'boom' });
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

  it('still drops the AskUserQuestion tool_result line entirely rather than surfacing it as a toolResult', () => {
    const events = parseChunk([askLine('toolu_1'), answerLine('toolu_1', 'Yes')].join('\n') + '\n').events;
    expect(events.map((e) => e.kind)).toEqual(['askUserQuestion']);
  });
});
```

The last test reuses the `askLine` / `answerLine` helpers already defined in this test file. It is the regression guard for the consumption path.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — no `toolResult` kind exists, so these fail to compile or return an empty array.

- [ ] **Step 3: Write the implementation**

Add the cap constant and helpers near the top of `daemon/src/lib/claude-adapter/tail.ts`:

```ts
/**
 * Payload ceiling for tool inputs and results (spec §4.1). One `Read` of a
 * large file would otherwise balloon a single /transcript response; the
 * existing 500-event cap bounds count, not size.
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
    return JSON.stringify(content);
  } catch {
    return '';
  }
}
```

Add the union member:

```ts
  | { kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }
```

Extend `userEvents` from Task 2 to walk tool_result blocks in source order:

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
  // A user line with only tool_result blocks emits NO user event. That blank
  // bubble was the empty grey box on the phone (spec §4.1).
  if (text) out.push({ kind: 'user', at, text, injected: false });
  return [...out, ...results];
}
```

- [ ] **Step 4: Update the test that asserts the old blank-bubble behaviour**

Replace the body of `'an ordinary tool_result for a non-AskUserQuestion tool is unaffected (pre-existing behavior, untouched)'` and rename it. Do not delete it — it becomes the assertion that the defect is fixed:

```ts
  it('an ordinary tool_result now becomes a toolResult event instead of a blank user bubble (track-c task 3 — was asserted broken here)', () => {
    const events = parseChunk([toolUseLine('toolu_9', 'Bash'), answerLine('toolu_9', 'done')].join('\n') + '\n').events;
    expect(events.map((e) => e.kind)).toEqual(['tool', 'toolResult']);
  });
```

Adjust the helper names to whatever the file already defines for a generic tool_use line.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: PASS, including the AskUserQuestion consumption guard.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "feat(adapter): emit toolResult events; no more blank user bubbles (track-c task 3)"
```

---

## Task 4: Emit thinking with its text and delete the dead error kind

`thinking` and `error` are both declared in the `TranscriptEvent` union and **never constructed by anything**. A thinking block currently falls through the walker, so a thinking-only assistant line yields an empty assistant event that renders as a bullet with nothing beside it.

They resolve in opposite directions, per spec §4.1: `thinking` becomes real and carries its text; `error` is removed, because nothing produces it and leaving a declared-but-dead branch that the type system vouches for is what the quarantine exists to prevent.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Test: `daemon/test/tail.test.ts`

**Interfaces:**
- Consumes: `ThinkingBlock` from Task 1; `assistantEvents` from Task 2.
- Produces: `{ kind: 'thinking'; at: string; text: string }` replaces `{ kind: 'thinking'; at: string }`. The `error` member is gone. Task 9 renders thinking; Task 7 mirrors both changes.

- [ ] **Step 1: Write the failing test**

```ts
describe('thinking blocks carry their text (track-c task 4)', () => {
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

The expected order puts the joined prose first, then the non-text blocks in source order — the shape `assistantEvents` produces.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — thinking blocks are ignored, so the first test gets `[]` and the second omits `'thinking'`.

- [ ] **Step 3: Write the implementation**

In `daemon/src/lib/claude-adapter/tail.ts`, change the union members:

```ts
  | { kind: 'thinking'; at: string; text: string }
```

and **delete** the `error` line entirely:

```ts
  | { kind: 'error'; at: string; message: string }   // <-- remove this
```

Then handle the block in `assistantEvents`, inside the same loop from Task 2:

```ts
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      rest.push({ kind: 'thinking', at, text: block.thinking });
    }
```

Widen the local cast to include the field:

```ts
    const block = b as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix daemon test`
Expected: PASS. Removing the `error` member may surface a `noFallthroughCasesInSwitch` or exhaustiveness error in the PWA — that is fixed in Task 7, and the daemon workspace should be green on its own here.

- [ ] **Step 5: Run the full gate and commit**

`npm run typecheck` will fail at this point if `pwa/src/components/Transcript.tsx` still has a `case 'error':` branch against the mirrored type. The PWA mirror is not updated until Task 7, so if the root typecheck fails **only** on that, commit with the daemon workspace verified and note it:

```bash
npm --prefix daemon run typecheck && npm --prefix daemon test && npm run lint
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "feat(adapter): thinking carries its text; drop the never-constructed error kind (track-c task 4)"
```

The root gate returns to green at Task 7. If you prefer an always-green root gate, do Task 7's `pwa/src/lib/types.ts` mirror edit in this commit as well.

---

## Task 5: Carry the full tool input so diffs can be rendered

`summarizeToolInput` returns the **first** matching key from a fixed list, truncated to 120 characters, and every other field is discarded before it leaves the daemon. An `Edit`'s `old_string` and `new_string`, a `Write`'s `content`, and a `TodoWrite`'s todos never cross the wire, so no renderer can show a diff or an expanded tool call.

This task keeps `summary` for the collapsed one-liner and adds the full `input`, with every string value capped.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Test: `daemon/test/tail.test.ts`

**Interfaces:**
- Consumes: `capText` and `TOOL_PAYLOAD_MAX_CHARS` from Task 3.
- Produces: `tool` becomes `{ kind: 'tool'; at: string; id: string; name: string; summary: string; input: Record<string, unknown>; truncated: boolean }`. Tasks 8 and 11 consume `input`.

- [ ] **Step 1: Write the failing test**

```ts
describe('tool events carry their full input (track-c task 5)', () => {
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

  it('caps each oversized string field and flags the event', () => {
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
    expect(ev.input.file_path).toBe('a.ts');
  });

  it('yields an empty input object when the tool input is not an object', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Weird', input: 'just a string' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.input).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- tail.test.ts`
Expected: FAIL — `tool` events have no `input` or `truncated` field.

- [ ] **Step 3: Write the implementation**

Add the input capper beside `capText` in `daemon/src/lib/claude-adapter/tail.ts`:

```ts
/**
 * Cap each string field individually rather than the serialized whole, so the
 * object KEEPS ITS SHAPE. DiffView (PWA) needs old_string/new_string to still
 * be present and addressable even when one of them was too big to ship whole.
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

`summarizeToolInput` is unchanged and still reads the uncapped original, which is correct — it truncates to 120 characters itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix daemon test`
Expected: PASS for the daemon workspace.

- [ ] **Step 5: Commit**

```bash
npm --prefix daemon run typecheck && npm --prefix daemon test && npm run lint
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "feat(adapter): tool events carry full capped input and their id (track-c task 5)"
```

---

## Task 6: Stamp injected in the services layer

`tail.ts` hardcodes `injected: false`, so the amber "From phone" treatment in `Transcript.tsx` is unreachable dead code and `docs/functional-spec.md` §3's claim that "phone-injected prompts stay visually distinct" is false.

**This cannot be fixed in the adapter.** `injected` requires the daemon's own record of prompts it sent, which lives in `daemon/src/domain/prompt-lifecycle.ts`, and the layering fence forbids `lib/claude-adapter/` importing from `domain/`. `services/` is the one layer that sees both. This matches `docs/architecture-spec.md` §4, which specifies the flag is set by "daemon-side correlation", not by unwrapping anything on the wire.

**Files:**
- Modify: `daemon/src/domain/prompt-lifecycle.ts`
- Modify: `daemon/src/services/services.ts`
- Test: `daemon/test/prompt-lifecycle.test.ts`, `daemon/test/services.test.ts`

**Interfaces:**
- Consumes: the `user` event shape from Task 2.
- Produces: `PromptLifecycle.wasInjected(sessionId: string, text: string): boolean`. `getTranscript` returns user events with `injected` correctly set. Task 7's `UserTurn` renders it.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/prompt-lifecycle.test.ts`:

```ts
  it('wasInjected reports a prompt this daemon sent for that session (track-c task 6)', async () => {
    const lifecycle = new PromptLifecycle();
    await lifecycle.submit({
      key: 'k1', sessionId: 's1', text: 'run the tests', nowMs: 0,
      sender: { mode: 'owned', send: async () => ({ ok: true }) },
    });
    expect(lifecycle.wasInjected('s1', 'run the tests')).toBe(true);
    expect(lifecycle.wasInjected('s1', 'something else')).toBe(false);
    expect(lifecycle.wasInjected('s2', 'run the tests')).toBe(false);
  });
```

Match the `sender` stub shape the surrounding tests in that file already use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix daemon test -- prompt-lifecycle.test.ts`
Expected: FAIL — `wasInjected` is not a function.

- [ ] **Step 3: Write the implementation**

Add to `PromptLifecycle` in `daemon/src/domain/prompt-lifecycle.ts`, next to `observe`:

```ts
  /**
   * True when this daemon sent a prompt with exactly this text for this
   * session — the correlation behind TranscriptEvent.injected
   * (architecture-spec.md §4). Deliberately matches on text rather than on a
   * wire marker: a takeover prompt lands in the transcript as a PLAIN user
   * entry, indistinguishable from a laptop-typed one, which is the whole
   * point of the takeover write path.
   *
   * Known and accepted imprecision: if the same text is typed at the laptop
   * and also sent from the phone, both render as "From phone". Marking a
   * laptop turn as phone-sent is the harmless direction, and de-duplicating
   * would need per-entry identity the transcript does not carry.
   */
  wasInjected(sessionId: string, text: string): boolean {
    for (const rec of this.byKey.values()) {
      if (rec.sessionId === sessionId && rec.text === text) return true;
    }
    return false;
  }
```

Then in `daemon/src/services/services.ts`, inside `getTranscript`, stamp after the existing observe loop and before the slice:

```ts
      for (const e of events) {
        if (e.kind === 'user') lifecycle.observe({ sessionId: id, text: e.text, atISO: e.at });
      }
      // injected is decided HERE, not in the adapter: the adapter may not
      // import domain/ (layering fence), and only the prompt lifecycle knows
      // which turns this daemon sent (architecture-spec.md §4).
      const stamped = events.map((e) =>
        e.kind === 'user' && lifecycle.wasInjected(id, e.text) ? { ...e, injected: true } : e,
      );
      const bounded = stamped.slice(-TRANSCRIPT_MAX_EVENTS);
      return { events: bounded, nextCursor: null };
```

- [ ] **Step 4: Add the services-level test**

Add to `daemon/test/services.test.ts`, following the fixture pattern the file already uses to stand up `createServices` against a fake transcript:

```ts
  it('marks a user turn the daemon itself sent as injected (track-c task 6)', async () => {
    // Arrange a session whose transcript contains the exact text a prompt was
    // submitted with, then assert the transcript event comes back injected.
    // Use the file's existing helper for building a services instance over a
    // fixture transcript rather than reaching into the filesystem here.
  });
```

Replace the comment with the concrete arrangement using that file's existing helper. The assertion is:

```ts
    const t = services.getTranscript(sessionId, undefined);
    const user = t?.events.find((e) => e.kind === 'user');
    expect(user).toMatchObject({ injected: true });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix daemon test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm --prefix daemon run typecheck && npm --prefix daemon test && npm run lint
git add daemon/src/domain/prompt-lifecycle.ts daemon/src/services/services.ts daemon/test/prompt-lifecycle.test.ts daemon/test/services.test.ts
git commit -m "feat(daemon): stamp injected in services via prompt-lifecycle correlation (track-c task 6)"
```

---

## Task 7: Mirror the widened union in the PWA and preserve newlines in user turns

This is the first PWA task and it restores a green root gate. `pwa/src/lib/types.ts` is a hand-maintained mirror of the daemon union — FENCE 1 forbids importing across — so it must be brought into step with Tasks 2 through 5.

It also fixes the most directly reported symptom. `Transcript.tsx` renders `{e.text}` as a plain React text child with no `whitespace-pre-wrap`, so **every multi-line prompt collapses into one wrapped run**. That is one of the two root causes of "newlines not always at the same place".

**Files:**
- Modify: `pwa/src/lib/types.ts`
- Create: `pwa/src/components/transcript/UserTurn.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-user-turn.test.tsx` (new)

**Interfaces:**
- Consumes: the daemon union from Tasks 2 to 5.
- Produces: `UserTurn({ e })` where `e` is `Extract<TranscriptEvent, { kind: 'user' }>`. Tasks 8 to 11 add sibling components under the same directory and are dispatched from the same switch.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-user-turn.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserTurn } from '../src/components/transcript/UserTurn.js';

describe('UserTurn', () => {
  it('preserves newlines in a multi-line prompt', () => {
    const { container } = render(<UserTurn e={{ kind: 'user', at: '', text: 'line one\nline two', injected: false }} />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.className).toContain('whitespace-pre-wrap');
    expect(block.textContent).toBe('line one\nline two');
  });

  it('marks a phone-sent prompt', () => {
    render(<UserTurn e={{ kind: 'user', at: '', text: 'hi', injected: true }} />);
    expect(screen.getByText('From phone')).toBeInTheDocument();
  });

  it('does not mark a laptop-typed prompt', () => {
    render(<UserTurn e={{ kind: 'user', at: '', text: 'hi', injected: false }} />);
    expect(screen.queryByText('From phone')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-user-turn.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Update the mirror**

In `pwa/src/lib/types.ts`, replace the `TranscriptEvent` union so it matches the daemon exactly. Keep the SYNC comment at the top of the file:

```ts
export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'thinking'; at: string; text: string }
  | { kind: 'tool'; at: string; id: string; name: string; summary: string; input: Record<string, unknown>; truncated: boolean }
  | { kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean;
      /** SYNC daemon tail.ts: present iff resolved — 'tool_result' (laptop stub) | 'text' (later human turn, incl. free text and the interruption marker). */
      resolvedBy?: 'tool_result' | 'text';
      selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean }[] };
```

The `error` member is gone, matching Task 4.

- [ ] **Step 4: Create the component**

Create `pwa/src/components/transcript/UserTurn.tsx`:

```tsx
import type { ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * The extension's input-echo treatment: a bordered, full-width, visually quiet
 * block. `whitespace-pre-wrap` is load-bearing — prompts to a coding agent are
 * paragraphs, and without it every newline the user typed collapsed into a
 * single wrapped run (spec §4.2).
 */
export function UserTurn({ e }: { e: Extract<TranscriptEvent, { kind: 'user' }> }): ReactElement {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[16px] whitespace-pre-wrap ${
        e.injected ? 'border-amber-700/60 bg-amber-500/10 text-zinc-100' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'
      }`}
    >
      {e.injected && (
        <span className="block text-[10.5px] font-bold uppercase tracking-wider text-amber-400 mb-1">From phone</span>
      )}
      {e.text}
    </div>
  );
}
```

- [ ] **Step 5: Wire it into the dispatcher**

In `pwa/src/components/Transcript.tsx`, import `UserTurn`, replace the inline `case 'user'` block with `return <UserTurn e={e} />;`, and **delete the `case 'error':` branch** so the switch stays exhaustive against the new union. Leave the other branches alone for now; later tasks replace them.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix pwa test`
Expected: PASS. `transcript-askuserquestion.test.tsx` and `transcript-links.test.tsx` must still pass untouched.

- [ ] **Step 7: Run the full root gate and commit**

The root gate should now be green again for the first time since Task 4.

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/lib/types.ts pwa/src/components/transcript/UserTurn.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-user-turn.test.tsx
git commit -m "feat(pwa): mirror the widened event union; user turns keep their newlines (track-c task 7)"
```

---

## Task 8: Render tool results and make tool calls expandable

`docs/functional-spec.md` line 175 promises "Tool calls collapse to one line each, expandable on tap". `Transcript.tsx` contains zero `onClick`, zero `useState`, and no `<details>` — tap-to-expand has never existed. Tool results are not rendered at all.

**Files:**
- Create: `pwa/src/components/transcript/ToolCall.tsx`
- Create: `pwa/src/components/transcript/ToolResult.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-tools.test.tsx` (new)

**Interfaces:**
- Consumes: `tool` and `toolResult` from the Task 7 mirror.
- Produces: `ToolCall({ e })`, `ToolResult({ e })`. Task 11 adds a diff branch **inside** `ToolCall`.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-tools.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCall } from '../src/components/transcript/ToolCall.js';
import { ToolResult } from '../src/components/transcript/ToolResult.js';

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

  it('expands on tap to reveal the full input', () => {
    render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/run the suite/)).toBeInTheDocument();
  });

  it('flags a truncated payload when expanded', () => {
    render(<ToolCall e={{ ...toolEvent, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});

describe('ToolResult', () => {
  it('shows a successful result collapsed, and expands on tap', () => {
    render(<ToolResult e={{ kind: 'toolResult', at: '', toolUseId: 'toolu_a', ok: true, text: 'all 42 tests passed', truncated: false }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/all 42 tests passed/)).toBeInTheDocument();
  });

  it('tints a failed result', () => {
    const { container } = render(<ToolResult e={{ kind: 'toolResult', at: '', toolUseId: 'toolu_a', ok: false, text: 'boom', truncated: false }} />);
    expect(container.innerHTML).toContain('red');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-tools.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create ToolCall**

Create `pwa/src/components/transcript/ToolCall.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * The extension's collapsed tool line, expandable on tap — implementing
 * functional-spec.md's long-standing promise (spec §4.2). Input is rendered
 * as plain text inside <pre>, never as markdown or HTML: it is arbitrary
 * model output (T7/T11), and it is displayed, never acted on.
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

- [ ] **Step 4: Create ToolResult**

Create `pwa/src/components/transcript/ToolResult.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

const PREVIEW_CHARS = 100;

/**
 * Before this component every non-AskUserQuestion tool result rendered as an
 * empty grey bordered box, because the daemon modelled no tool_result kind
 * (spec §4.1). Plain text in a <pre>, never markdown or HTML (T7/T11).
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

- [ ] **Step 5: Wire both into the dispatcher**

In `pwa/src/components/Transcript.tsx`, replace the inline `case 'tool'` with `return <Gutter><ToolCall e={e} /></Gutter>;` and add `case 'toolResult': return <Gutter><ToolResult e={e} /></Gutter>;`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix pwa test`
Expected: PASS.

- [ ] **Step 7: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/components/transcript/ToolCall.tsx pwa/src/components/transcript/ToolResult.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-tools.test.tsx
git commit -m "feat(pwa): render tool results and make tool calls expandable (track-c task 8)"
```

---

## Task 9: Render thinking with its reasoning text

`Transcript.tsx` renders a literal, content-free `thinking…`. Task 4 made the event carry real text, so the marker becomes expandable.

**Files:**
- Create: `pwa/src/components/transcript/Thinking.tsx`
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-thinking.test.tsx` (new)

**Interfaces:**
- Consumes: `thinking` with `text` from Task 7's mirror.
- Produces: `Thinking({ e })`.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-thinking.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Thinking } from '../src/components/transcript/Thinking.js';

describe('Thinking', () => {
  it('shows a marker, not a wall of text, until tapped', () => {
    render(<Thinking e={{ kind: 'thinking', at: '', text: 'the config is probably stale' }} />);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
    expect(screen.queryByText(/probably stale/)).toBeNull();
  });

  it('reveals the reasoning on tap', () => {
    render(<Thinking e={{ kind: 'thinking', at: '', text: 'the config is probably stale' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/probably stale/)).toBeInTheDocument();
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
 * functional-spec.md §3: "Thinking renders as a marker, not a wall of text."
 * The marker stays the default; the text is now available on tap, which it
 * never was before (the event carried no text at all — spec §4.1).
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

- [ ] **Step 4: Wire it in**

In `pwa/src/components/Transcript.tsx`, replace `case 'thinking'` with `return <Gutter><Thinking e={e} /></Gutter>;`.

- [ ] **Step 5: Run the tests and commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/components/transcript/Thinking.tsx pwa/src/components/Transcript.tsx pwa/test/transcript-thinking.test.tsx
git commit -m "feat(pwa): thinking marker expands to its reasoning text (track-c task 9)"
```

---

## Task 10: Style code blocks, add syntax highlighting and GFM

Today a fenced code block renders as a bare `<pre><code>`. Tailwind 4's Preflight resets it to `font-family: monospace` at `font-size: 1em` with no background, padding, border, or scroll container, so **code is visually indistinguishable from prose** except for the typeface. There is no highlighting library, and no `remark-gfm`, so tables, task lists, strikethrough, and bare autolinks do not render at all. Missing GFM is the second root cause of text landing differently than in the extension.

**T7 is the governing constraint here.** See the "correction to the spec's §4.2 wording" note near the top of this plan: `rehype-highlight` is used instead of calling `highlight.js` directly, because the latter's API returns an HTML string that could only be injected with `dangerouslySetInnerHTML`. `rehype-highlight` produces a syntax tree that react-markdown renders as ordinary React elements. Same grammars, no HTML injection, no CSP change.

**Files:**
- Modify: `pwa/package.json`
- Create: `pwa/src/components/transcript/CodeBlock.tsx`
- Modify: `pwa/src/lib/markdown.tsx`
- Modify: `pwa/src/index.css`
- Test: `pwa/test/transcript-code.test.tsx` (new), `pwa/test/markdown-safety.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CodeBlock({ className, children })`, wired as react-markdown's `code` component override.

- [ ] **Step 1: Add the dependencies**

```bash
npm --prefix pwa install remark-gfm rehype-highlight highlight.js
npm --prefix pwa uninstall clsx
```

`clsx` is declared in `pwa/package.json` and referenced nowhere in `pwa/src` or `pwa/test`. Removing it is the clean-as-you-touch step the spec calls for, and this is the task that already edits that file.

- [ ] **Step 2: Write the failing test**

Create `pwa/test/transcript-code.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SafeMarkdown } from '../src/lib/markdown.js';

describe('code rendering', () => {
  it('gives a fenced block its own styled, scrollable container', () => {
    const { container } = render(<SafeMarkdown>{'```ts\nconst a = 1;\n```'}</SafeMarkdown>);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain('overflow-x-auto');
  });

  it('highlights a known language into element spans, never an HTML string', () => {
    const { container } = render(<SafeMarkdown>{'```ts\nconst a = 1;\n```'}</SafeMarkdown>);
    expect(container.querySelectorAll('pre span').length).toBeGreaterThan(0);
  });

  it('renders an unknown language as plain text rather than failing', () => {
    const { container } = render(<SafeMarkdown>{'```notalanguage\nhello\n```'}</SafeMarkdown>);
    expect(container.querySelector('pre')?.textContent).toContain('hello');
  });

  it('styles inline code distinctly from prose', () => {
    const { container } = render(<SafeMarkdown>{'use `npm test` here'}</SafeMarkdown>);
    const code = container.querySelector('code');
    expect(code?.className).toContain('bg-');
  });

  it('renders a GFM table', () => {
    const { container } = render(<SafeMarkdown>{'| a | b |\n|---|---|\n| 1 | 2 |'}</SafeMarkdown>);
    expect(container.querySelector('table')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-code.test.tsx`
Expected: FAIL on every case — no plugins, no overrides, no table support.

- [ ] **Step 4: Create CodeBlock**

Create `pwa/src/components/transcript/CodeBlock.tsx`:

```tsx
import type { ReactElement, ReactNode } from 'react';

/**
 * react-markdown's `code` override. It renders BOTH inline code and the inner
 * <code> of a fenced block, distinguished by whether rehype-highlight left a
 * `language-*`/`hljs` class on it.
 *
 * T7: children are already-parsed React nodes from the markdown tree (and,
 * for a fenced block, rehype-highlight's element spans). Nothing here is an
 * HTML string and nothing uses dangerouslySetInnerHTML.
 */
export function CodeBlock({ className, children }: { className?: string; children?: ReactNode }): ReactElement {
  const isBlock = typeof className === 'string' && /(^|\s)(language-|hljs)/.test(className);

  if (!isBlock) {
    return (
      <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.9em] text-zinc-200">{children}</code>
    );
  }
  return <code className={`${className ?? ''} font-mono text-[13.5px] leading-normal`}>{children}</code>;
}
```

- [ ] **Step 5: Wire the plugins and the overrides**

In `pwa/src/lib/markdown.tsx`, add the imports and extend the `Markdown` element. **Do not touch the anchor logic or `urlTransform`** — they carry T7 and track-b-4 findings.

```tsx
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from '../components/transcript/CodeBlock.js';
```

```tsx
    <Markdown
      urlTransform={urlTransform}
      remarkPlugins={[remarkGfm]}
      // rehype-highlight wraps lowlight (highlight.js) and emits a hast tree,
      // which react-markdown renders as React elements. Chosen over calling
      // highlight.js directly, whose API returns an HTML string that would
      // need dangerouslySetInnerHTML — the one API T7 forbids outright.
      // `ignoreMissing` keeps an unknown language tag from throwing.
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={{
        code: CodeBlock,
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-900/70 p-2">{children}</pre>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-zinc-800 px-2 py-1 text-left text-zinc-300">{children}</th>,
        td: ({ children }) => <td className="border border-zinc-800 px-2 py-1 text-zinc-400">{children}</td>,
        a: ({ href, children: linkChildren }) => {
          // ... existing anchor implementation, unchanged ...
        },
      }}
    >
```

The `pre` and `table` wrappers each own their horizontal scroll, so wide content never makes the whole transcript scroll sideways.

- [ ] **Step 6: Add the theme stylesheet**

In `pwa/src/index.css`, add the highlight theme after the Tailwind import:

```css
@import "tailwindcss";
@import "highlight.js/styles/github-dark.css";
:root { color-scheme: dark; }
html, body, #root { height: 100%; }
body { margin: 0; background: #09090b; }
```

This is a bundled stylesheet served from the app's own origin, so the CSP's `style-src 'self' 'unsafe-inline'` covers it with no change.

- [ ] **Step 7: Extend the safety test**

Add to `pwa/test/markdown-safety.test.tsx`, to prove the new plugins did not open a hole:

```tsx
  it('still renders raw HTML inert after adding gfm and highlight plugins', () => {
    const { container } = render(<SafeMarkdown>{'<img src=x onerror=alert(1)>'}</SafeMarkdown>);
    expect(container.querySelector('img')).toBeNull();
  });
```

- [ ] **Step 8: Run the tests and commit**

Run: `npm --prefix pwa test`
Expected: PASS, including the existing `markdown-safety.test.tsx` cases.

```bash
npm run typecheck && npm run lint && npm test
git add pwa/package.json package-lock.json pwa/src/components/transcript/CodeBlock.tsx pwa/src/lib/markdown.tsx pwa/src/index.css pwa/test/transcript-code.test.tsx pwa/test/markdown-safety.test.tsx
git commit -m "feat(pwa): styled code blocks, hast-based highlighting, GFM tables; drop unused clsx (track-c task 10)"
```

---

## Task 11: Render diffs for Edit, MultiEdit, and Write

With Task 5 shipping the full tool input, an `Edit`'s `old_string` and `new_string` finally reach the phone. The extension shows an inline red/green diff; MicroViber shows a file path and nothing else.

No diff library is added. A common-prefix/common-suffix trim is enough for the single-hunk edits these tools produce, and it keeps the dependency surface flat.

**Files:**
- Create: `pwa/src/lib/diff.ts`
- Create: `pwa/src/components/transcript/DiffView.tsx`
- Modify: `pwa/src/components/transcript/ToolCall.tsx`
- Test: `pwa/test/diff.test.ts` (new), extend `pwa/test/transcript-tools.test.tsx`

**Interfaces:**
- Consumes: `tool.input` from Task 5, `ToolCall` from Task 8.
- Produces: `lineDiff(oldText, newText): DiffLine[]` where `DiffLine = { type: 'ctx' | 'del' | 'add'; text: string }`, and `DiffView({ oldText, newText })`.

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

  it('caps runaway context so a one-line edit in a big file stays readable', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const edited = big.replace('line 100', 'line 100 changed');
    const out = lineDiff(big, edited);
    expect(out.length).toBeLessThan(20);
    expect(out.some((l) => l.type === 'add' && l.text === 'line 100 changed')).toBe(true);
  });
});
```

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
 * not a full LCS: Edit and Write produce one contiguous change, and this
 * avoids adding a diff dependency to the PWA bundle (spec §4.2).
 *
 * Context is capped at CONTEXT_LINES either side, so a one-line edit inside a
 * large file renders as a small hunk rather than the whole file.
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
  for (let i = leadFrom; i < prefix; i++) out.push({ type: 'ctx', text: a[i] ?? '' });
  for (let i = prefix; i < a.length - suffix; i++) out.push({ type: 'del', text: a[i] ?? '' });
  for (let i = prefix; i < b.length - suffix; i++) out.push({ type: 'add', text: b[i] ?? '' });

  const tailStart = a.length - suffix;
  const tailEnd = Math.min(a.length, tailStart + CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i++) out.push({ type: 'ctx', text: a[i] ?? '' });

  return out;
}
```

`?? ''` rather than `!` satisfies `noUncheckedIndexedAccess` without an assertion.

- [ ] **Step 4: Create DiffView**

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

/** Inline red/green diff, matching how the extension shows a file edit. */
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

- [ ] **Step 5: Branch ToolCall onto the diff**

In `pwa/src/components/transcript/ToolCall.tsx`, add above the generic key/value list, inside the `open` block:

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

and in the expanded body:

```tsx
          {(() => {
            const d = diffOf(e);
            return d ? <DiffView oldText={d.oldText} newText={d.newText} /> : null;
          })()}
```

Keep the key/value list for every other field, so a `MultiEdit`'s edit array and a `TodoWrite`'s todos are still visible.

- [ ] **Step 6: Extend the tool test**

Add to `pwa/test/transcript-tools.test.tsx`:

```tsx
  it('renders a diff for an Edit when expanded', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', summary: 'a.ts', input: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const a = 2;/)).toBeInTheDocument();
  });
```

- [ ] **Step 7: Run the tests and commit**

```bash
npm --prefix pwa test
npm run typecheck && npm run lint && npm test
git add pwa/src/lib/diff.ts pwa/src/components/transcript/DiffView.tsx pwa/src/components/transcript/ToolCall.tsx pwa/test/diff.test.ts pwa/test/transcript-tools.test.tsx
git commit -m "feat(pwa): inline red/green diffs for Edit, MultiEdit and Write (track-c task 11)"
```

---

## Task 12: Follow the transcript bottom only when already pinned there

`Transcript.tsx` scrolls to the bottom exactly once per newly-selected session and never again, so events arriving during a live turn do not follow and the view appears frozen mid-turn. The opposite failure is just as bad: scrolling on every poll would yank the user back down while they read up-thread.

The rule: follow the bottom when the user is already at the bottom, and never otherwise.

**Files:**
- Modify: `pwa/src/components/Transcript.tsx`
- Test: `pwa/test/transcript-scroll.test.tsx` (new)

**Interfaces:**
- Consumes: everything from Tasks 7 to 11.
- Produces: no new exports. This is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Create `pwa/test/transcript-scroll.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

const ev = (text: string): TranscriptEvent => ({ kind: 'assistant', at: '', text });

/**
 * jsdom performs no layout, so it clamps a real `scrollTop` assignment back to
 * 0 and reports `scrollHeight`/`clientHeight` as 0. Redefine all three as
 * plain properties and RECORD what the component assigns, rather than trusting
 * jsdom to store it. `writes` is the assertion surface.
 */
function harness(container: HTMLElement, opts: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const el = container.firstElementChild as HTMLElement;
  const writes: number[] = [];
  let current = opts.scrollTop;
  Object.defineProperty(el, 'clientHeight', { get: () => opts.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => current,
    set: (v: number) => { current = v; writes.push(v); },
    configurable: true,
  });
  return { el, writes, opts };
}

const props = { sessionId: 's1', sessionCwd: '', canAnswer: false, answerInFlight: null };

describe('Transcript scrolling', () => {
  it('follows new events while pinned to the bottom', () => {
    const { container, rerender } = render(<Transcript events={[ev('one')]} {...props} />);
    // At the bottom: scrollHeight - clientHeight - scrollTop === 0.
    const h = harness(container, { scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    h.el.dispatchEvent(new Event('scroll')); // let the component sample "pinned"

    h.opts.scrollHeight = 400; // new events arrive
    rerender(<Transcript events={[ev('one'), ev('two')]} {...props} />);
    expect(h.writes.at(-1)).toBe(400);
  });

  it('does not yank the view when the user has scrolled up', () => {
    const { container, rerender } = render(<Transcript events={[ev('one')]} {...props} />);
    // Far from the bottom: 1000 - 100 - 10 = 890, well over the 24px slack.
    const h = harness(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 10 });
    h.el.dispatchEvent(new Event('scroll'));
    h.writes.length = 0; // ignore anything written during the first render

    rerender(<Transcript events={[ev('one'), ev('two')]} {...props} />);
    expect(h.writes).toEqual([]);
    expect(h.el.scrollTop).toBe(10);
  });
});
```

Note that `harness` is installed **after** the first render, so the initial
newly-selected-session jump has already happened against jsdom's own zeroed
values and cannot pollute either assertion. The `scroll` event is dispatched
explicitly because jsdom fires none on its own.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix pwa test -- transcript-scroll.test.tsx`
Expected: FAIL on the first case — the current effect only fires on a session change, so `scrollTop` stays at 0.

- [ ] **Step 3: Write the implementation**

In `pwa/src/components/Transcript.tsx`, replace the two scroll effects:

```tsx
  const ref = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);
  // Whether the user was pinned to the bottom BEFORE this render's new events
  // were laid out. Sampled in a layout effect so it reflects the pre-update
  // scroll position, not the post-update one.
  const pinnedRef = useRef(true);

  useEffect(() => { pendingRef.current = sessionId; pinnedRef.current = true; }, [sessionId]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    // 24px of slack: a partially-scrolled last line still counts as "at the bottom".
    pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || events.length === 0) return;
    // Jump on first load of a newly-picked session, then follow only while pinned.
    if (pendingRef.current === sessionId || pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
      pendingRef.current = null;
    }
  }, [events, sessionId]);
```

and attach the handler to the scroll container:

```tsx
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-[16.5px] leading-relaxed">
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix pwa test`
Expected: PASS, all files.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/components/Transcript.tsx pwa/test/transcript-scroll.test.tsx
git commit -m "feat(pwa): follow the transcript bottom only while pinned there (track-c task 12)"
```

---

## Task 13: Reconcile the specs

Feature C changes observable behaviour and corrects two false claims, so the specs must be updated in the same branch. This is the clean-as-you-touch step the workspace requires, not optional paperwork.

**Files:**
- Modify: `docs/functional-spec.md`
- Modify: `docs/architecture-spec.md`
- Modify: `docs/features/microviber-track-c/spec.md`

- [ ] **Step 1: Update `docs/functional-spec.md` §3, Transcript view**

Add a `**Changed**` entry in the established style, dated, naming the story. It must record that tool results now render instead of blank boxes, that tool calls are genuinely expandable (the line already claiming this was aspirational), that thinking carries text, that code blocks are highlighted, that GFM tables render, that user prompts keep their newlines, and that the phone-injected treatment is now live rather than dead code.

- [ ] **Step 2: Update `docs/architecture-spec.md` §4**

The normalized `TranscriptEvent` shape in §4 is now wrong. Replace it with the widened union, and add a sentence recording that `injected` is stamped in `services/` because the adapter may not import `domain/`.

- [ ] **Step 3: Record the highlighting decision in the feature spec**

In `docs/features/microviber-track-c/spec.md` §4.2, note that the implementation uses `rehype-highlight` (lowlight, which is highlight.js) rather than calling `highlight.js` directly, because the direct API returns an HTML string that would require `dangerouslySetInnerHTML` and violate T7. Same grammars, same CSP posture.

- [ ] **Step 4: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add docs/functional-spec.md docs/architecture-spec.md docs/features/microviber-track-c/spec.md
git commit -m "docs: reconcile specs to the shipped transcript parity behaviour (track-c task 13)"
```

---

## Out of scope for this plan

Each of these was considered and deliberately excluded. None is a gap to be quietly filled by an implementer.

- **Features A and B.** Separate cluster, planned separately into this file later.
- **Assistant prose sharing a message with an `AskUserQuestion`.** The detection keeps its whole-content short-circuit and single-event shape, because the cross-line resolution pass depends on exactly one `askUserQuestion` event per line and that logic is the most security-sensitive in the adapter. Prose on such a line is still dropped. Rare, and not worth destabilising the answer mechanism.
- **Live transcript streaming.** The 2.5-second poll stays. The WebSocket lands with Feature A.
- **Transcript pagination.** `getTranscript` still ignores `cursor` and returns `nextCursor: null`, silently truncating to the last 500 events with no marker. Pre-existing and unchanged.
- **A full LCS diff.** Task 11's single-hunk trim is sufficient for `Edit` and `Write`. A multi-hunk diff would need a real algorithm or a dependency.
- **Per-tool icons or bespoke renderers** beyond the diff branch. Every other tool uses the generic expandable key/value view.
- **Shiki or TextMate-exact colors.** Settled in the spec's decision table.
- **Rendering `MultiEdit`'s edit array as several diffs.** It shows as a structured value in the key/value list. A follow-up if it proves annoying in real use.
