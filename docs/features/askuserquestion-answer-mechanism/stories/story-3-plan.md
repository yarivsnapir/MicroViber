# Per-question `selectedLabels` — Implementation Plan (story `askuserquestion-answer-mechanism-3`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a resolved `AskUserQuestion` card highlight the actual answer to *each* question independently, by changing `selectedLabels` from a flat `string[]` to a per-question `string[][]` across daemon and PWA.

**Architecture:** Both resolution clauses of spec §4.1 (the `tool_result` answer stub and the human-text turn) already know the pending question list, so both can attribute labels to a specific question. The whole rule stays inside `daemon/src/lib/claude-adapter/ask-user-question.ts` — the adapter quarantine (spec §6) whose module header says callers must never re-implement it — and `tail.ts` stays a dumb wiring layer. One shared greedy longest-label-first matcher (`matchLabelRun`) serves both clauses, so the two can never drift. The PWA mirrors the wire shape by hand (`pwa/src/lib/types.ts` is a SYNC point, not derived) and `isOn(qi, label)` indexes by question.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Node 22 ESM, zod, vitest, React 19 + Tailwind (PWA), `@testing-library/react`.

## Global Constraints

- Run every command from `microviber/` (the project root of this repo). Full gate: `npm run typecheck && npm run lint && npm test`.
- `exactOptionalPropertyTypes` is on: you cannot assign `undefined` to an optional property. Keep the existing `...(x !== undefined ? { x } : {})` spread idiom in `tail.ts`.
- `@typescript-eslint/no-explicit-any` is an error. No `any` anywhere in this story.
- ESLint FENCE 1: `pwa/**` must never import from `daemon/**`. `pwa/src/lib/types.ts` is a hand-maintained mirror — change both sides in the same commit.
- ESLint FENCE 2: only `daemon/src/lib/claude-adapter/**` may reference `~/.claude` paths. The AC2 probe script in Task 5 lives under `docs/`, which is outside `daemon/src/`, so the fence does not apply to it — but it is linted (`eslint .` covers `docs/**/*.ts`), so it must typecheck-clean by ESLint's rules and carry no `any`.
- `AskUserQuestionInputSchema` already rejects duplicate option labels **within one question**. Duplicate labels **across** questions are legal and are exactly the bug this story fixes.
- Commit subjects use the `askuserquestion-answer-mechanism-3` story scope, e.g. `fix(askuserquestion-3): ...`. Do not touch files outside this story's list.

## Semantics being preserved (read before Task 1)

`selectedLabels` becomes `string[][] | undefined`, where:

- **Outer `undefined`** = "can't tell for this call" — the only `undefined` the card ever sees today, and the only one either parser can produce, because both are all-or-nothing: a partial match yields `undefined` for the whole call, never a half-filled array. `AskUserQuestionCard.tsx`'s *no longer pending* caption stays keyed on the outer `undefined`, so its rendering is byte-for-byte unchanged.
- **`selectedLabels[i]`** = the labels picked for question `i`. Because both parsers are all-or-nothing, every inner array is non-empty and `selectedLabels.length === questions.length` whenever the outer value is defined. Do not write code that depends on an inner array being empty; do not add a partial-parse path in this story.

## Behaviour change to state honestly in review

Today `labelsFromToolResult` does a blind `content.split(',')` and returns whatever tokens fall out, *without* checking them against the question's own options. A stub that is not a label list (say, a sentence) therefore produces junk "labels" which match no option, so the card renders dimmed with no highlight **and no caption**. After this story the same stub fails the label walk and yields `undefined`, so the card renders dimmed with no highlight **and the neutral *no longer pending* caption**. That is the honest render for "resolved, but I cannot tell what was picked", and it makes the `tool_result` clause consistent with the text clause, which has always behaved this way. Call it out in the PR body.

## File Structure

| File | Responsibility in this story |
|---|---|
| `daemon/src/lib/claude-adapter/ask-user-question.ts` | The whole rule: `matchLabelRun` (shared matcher), `parseAnswerText` → `string[][]`, `labelsFromToolResult` → per-question, `Resolution` + `isResolvingUserEntry` signature. |
| `daemon/src/lib/claude-adapter/transcript-meta.ts` | One call site adapts to the new `isResolvingUserEntry` signature. No behaviour change. |
| `daemon/src/lib/claude-adapter/tail.ts` | `TranscriptEvent.askUserQuestion.selectedLabels` type + resolution wiring. Stays dumb. |
| `daemon/test/ask-user-question.test.ts` | Updated shapes + new per-question coverage. |
| `daemon/test/tail.test.ts` | Updated shapes + the two-question cross-highlight regression at the wire level. |
| `pwa/src/lib/types.ts` | Hand-maintained mirror of the wire shape. |
| `pwa/src/components/AskUserQuestionCard.tsx` | `isOn(qi, label)` indexes by question. |
| `pwa/test/ask-user-question-card.test.tsx` | Updated shapes + **the** regression test (two questions, shared labels). |
| `pwa/test/transcript-askuserquestion.test.tsx` | Two fixtures carry `selectedLabels` — mechanical shape fix. |
| `docs/features/askuserquestion-answer-mechanism/spec.md` | §4.1, §5.3, §6, §7.1 updated to the per-question shape; §7.1's Known limitation closed (AC6). |
| `docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts` | **New.** The AC2 empirical probe. |
| `docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-answer-accepted.ts` | One inline type annotation mirrors the new wire shape. |

---

### Task 1: The shared matcher and `parseAnswerText` → `string[][]` (AC1)

**Files:**
- Modify: `daemon/src/lib/claude-adapter/ask-user-question.ts:135-159`
- Test: `daemon/test/ask-user-question.test.ts:73-91`

**Interfaces:**
- Consumes: `AskUserQuestionInput` from `./schemas.js` (already imported).
- Produces:
  - `matchLabelRun(q: AskUserQuestionInput, text: string): string[] | null` — module-private, used again by Task 2.
  - `longestFirstLabels(q: AskUserQuestionInput): string[]` — module-private, used again by Task 2.
  - `parseAnswerText(questions: AskUserQuestionInput[], text: string): string[][] | undefined` — exported; Task 3 consumes it.

- [ ] **Step 1: Update the two existing `parseAnswerText` assertions to the per-question shape**

In `daemon/test/ask-user-question.test.ts`, inside `describe('composeAnswerText / parseAnswerText')`, the round-trip assertion currently reads:

```ts
    expect(parseAnswerText([q1, q2], text)).toEqual(['Yes', 'Frontend, and docs', 'Backend']);
```

Change it to:

```ts
    expect(parseAnswerText([q1, q2], text)).toEqual([['Yes'], ['Frontend, and docs', 'Backend']]);
```

The `returns undefined for free text, a wrong heading, a missing line, or an unknown label` test needs no change — `undefined` is still `undefined`.

- [ ] **Step 2: Add per-question coverage**

Append inside the same `describe` block:

```ts
  it('groups labels by question: one inner array per question, in question order (story-3 AC1)', () => {
    const text = composeAnswerText([q1, q2], [['No'], ['Backend']]);
    expect(parseAnswerText([q1, q2], text)).toEqual([['No'], ['Backend']]);
  });

  it('two questions sharing an option label keep their own answers apart (story-3, the regression this story exists for)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const qs = [yn('First'), yn('Second')];
    const text = composeAnswerText(qs, [['Yes'], ['No']]);
    expect(parseAnswerText(qs, text)).toEqual([['Yes'], ['No']]);
  });

  it('a single-select question offered two labels is undefined — the shared matcher enforces cardinality (§5.2)', () => {
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: Yes, No')).toBeUndefined();
  });
```

That last case is unreachable from `composeAnswerText` — `validateAnswer` (§5.2) rejects a two-pick answer to a single-select question before it can ever be composed — so tightening here changes no shipped behaviour. It is asserted because both §4.1 clauses now share this matcher, and Task 2's answer-stub path *can* be handed arbitrary content.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix daemon test -- ask-user-question`
Expected: FAIL. The updated round-trip assertion and both new tests report a flat array (e.g. `['Yes', 'No']`) where a nested one was expected.

- [ ] **Step 4: Extract the matcher and re-shape `parseAnswerText`**

In `daemon/src/lib/claude-adapter/ask-user-question.ts`, replace the whole `parseAnswerText` function (currently the last function in the file) with:

```ts
function longestFirstLabels(q: AskUserQuestionInput): string[] {
  return q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
}

/**
 * Match `text` as an exact `", "`-joined run of ONE question's own option
 * labels, longest label first so a label that itself contains `", "` is not
 * split. Returns the labels picked, or null when `text` is anything else
 * (free text, a partial match, an unknown label, or empty).
 *
 * Also enforces the question's own cardinality: a single-select question
 * must yield exactly one label. Both resolution clauses of §4.1 go through
 * here, so neither can accept a run that `validateAnswer` (§5.2) would have
 * rejected on the way out — the module header's "never re-implement the
 * rule" applies to reading answers as much as to writing them.
 *
 * Greedy with no backtracking — the rule parseAnswerText has always used.
 * Consequence, deliberately accepted: if a question offers both `"A"` and
 * `"A, B"`, the longer is tried first, so a run that would only parse by
 * choosing the shorter one is reported as no match. Saying "can't tell" is
 * the safe answer here; every "can't tell" degrades to an unhighlighted
 * card, never to a wrong highlight.
 */
function matchLabelRun(q: AskUserQuestionInput, text: string): string[] | null {
  const labels = longestFirstLabels(q);
  const picked: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const hit = labels.find((l) => rest === l || rest.startsWith(`${l}, `));
    if (hit === undefined) return null;
    picked.push(hit);
    rest = rest.slice(hit.length);
    if (rest.startsWith(', ')) rest = rest.slice(2);
  }
  if (picked.length === 0) return null;
  if (picked.length > 1 && q.multiSelect !== true) return null;
  return picked;
}

/**
 * Inverse of composeAnswerText. Exact-shape only: returns ONE ARRAY PER
 * QUESTION, in question order, or undefined for anything else (free text,
 * partial match, unknown label). All-or-nothing — a single unparseable line
 * makes the whole call undefined, so a defined result always has exactly
 * `questions.length` non-empty entries (spec §5.3 accepted degrade).
 */
export function parseAnswerText(questions: AskUserQuestionInput[], text: string): string[][] | undefined {
  const lines = text.split('\n');
  const heading = lines[0];
  if (heading !== (questions.length === 1 ? HEADING_ONE : HEADING_MANY)) return undefined;
  if (lines.length !== questions.length + 1) return undefined;
  const out: string[][] = [];
  for (const [i, q] of questions.entries()) {
    const line = lines[i + 1] ?? '';
    const prefix = `- ${q.header}: `;
    if (!line.startsWith(prefix)) return undefined;
    const picked = matchLabelRun(q, line.slice(prefix.length));
    if (picked === null) return undefined;
    out.push(picked);
  }
  return out;
}
```

Note `matchLabelRun` returning `null` for empty text preserves the old `pickedAny` guard exactly: a line of `- Header: ` with nothing after it is still `undefined`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix daemon test -- ask-user-question`
Expected: the `composeAnswerText / parseAnswerText` describe block is fully green. The `isResolvingUserEntry — clause (a) tool_result` block still passes (untouched this task).

- [ ] **Step 6: Commit**

```bash
git add daemon/src/lib/claude-adapter/ask-user-question.ts daemon/test/ask-user-question.test.ts
git commit -m "fix(askuserquestion-3): parseAnswerText returns one label array per question"
```

---

### Task 2: The `tool_result` clause, scoped per question (AC2)

**Files:**
- Modify: `daemon/src/lib/claude-adapter/ask-user-question.ts:52-54, 79-102`
- Modify: `daemon/src/lib/claude-adapter/transcript-meta.ts:100`
- Test: `daemon/test/ask-user-question.test.ts:30-45`

**Interfaces:**
- Consumes: `matchLabelRun`, `longestFirstLabels` (Task 1); `DetectedQuestion` (already exported from this module).
- Produces:
  - `Resolution` = `{ by: 'tool_result'; selectedLabels: string[][] | undefined } | { by: 'text'; text: string }`
  - `isResolvingUserEntry(entry: UserTranscriptLine, pending: DetectedQuestion): Resolution | null` — **signature change**: the second parameter is now the whole `DetectedQuestion`, not a bare `toolUseId`. Task 3 consumes this.

**Why the signature changes:** producing per-question labels needs the question list, and `DetectedQuestion` already carries `{ toolUseId, questions }` together. `transcript-meta.ts`'s `pendingQuestion` is structurally identical to `DetectedQuestion`, so that call site becomes shorter, not longer.

- [ ] **Step 1: Update the existing clause-(a) tests and add the per-question ones**

In `daemon/test/ask-user-question.test.ts`, `describe('isResolvingUserEntry — clause (a) tool_result')` currently passes a bare id. Replace the entire describe block with:

```ts
describe('isResolvingUserEntry — clause (a) tool_result', () => {
  const pending1 = { toolUseId: 'toolu_1', questions: [q1] };
  it('resolves on a matching tool_result and attributes its labels to the one question', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });
  it('a tool_result for a different id, with no text, does not resolve', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_OTHER', content: 'ok' }] });
    expect(isResolvingUserEntry(e, pending1)).toBeNull();
  });
  it('normalises non-string, empty, and <tool_use_error> content to selectedLabels: undefined', () => {
    for (const content of [{ some: 'object' }, '', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>']) {
      const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] });
      expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
    }
  });
  it('content that is not a run of this question\'s own labels is undefined, not junk tokens (story-3: the old blind split(",") emitted unmatchable strings)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'go with the first one' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('a single multiSelect question takes the whole run — no boundary to guess', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Frontend, Backend' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend', 'Backend']] });
  });
  it('two single-select questions split positionally, so shared labels stay apart (story-3 AC2)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });
  it('several questions where any is multiSelect is genuinely ambiguous — undefined, never a guess (story-3 AC2)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, Frontend, Backend' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1, q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('a run of two labels for a SINGLE-select question is undefined, not a two-pick answer (cardinality, §5.2)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('leftover text after every question has taken its label is undefined (the walk must consume the stub exactly)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No, Yes' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
});
```

Also update the one clause-(b) call site that still passes a bare id — in `describe('isResolvingUserEntry — clause (b) human turn')` and the `origin.kind: "auto-continuation"` describe block, every `isResolvingUserEntry(x, 'toolu_1')` becomes `isResolvingUserEntry(x, { toolUseId: 'toolu_1', questions: [q1] })`. There is also one at `daemon/test/ask-user-question.test.ts:68` inside a clause-(b) test — give it the same treatment.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix daemon test -- ask-user-question`
Expected: FAIL — TypeScript/vitest reports the object argument where a `string` is declared, and the new expectations report flat arrays.

- [ ] **Step 3: Re-shape the `Resolution` type and the clause-(a) implementation**

In `daemon/src/lib/claude-adapter/ask-user-question.ts`, change the `Resolution` union:

```ts
export type Resolution =
  | { by: 'tool_result'; selectedLabels: string[][] | undefined }
  | { by: 'text'; text: string };
```

Change `isResolvingUserEntry`'s signature and its clause-(a) branch (leave the `isMeta` / `origin.kind` / `humanText` tail exactly as it is):

```ts
export function isResolvingUserEntry(entry: UserTranscriptLine, pending: DetectedQuestion): Resolution | null {
  const content = entry.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const r = ToolResultBlock.safeParse(block);
      if (r.success && r.data.tool_use_id === pending.toolUseId) {
        return { by: 'tool_result', selectedLabels: labelsFromToolResult(pending.questions, r.data.content) };
      }
    }
  }
  if (entry.isMeta === true) return null;
  if (entry.origin?.kind !== undefined && SYNTHETIC_ORIGIN_KINDS.has(entry.origin.kind)) return null;
  const text = humanText(content);
  return text === null ? null : { by: 'text', text };
}
```

Replace `labelsFromToolResult` with:

```ts
/**
 * One "no labels" shape for the card: undefined for non-string, empty, or
 * CLI-error content — and equally for any content this cannot attribute to a
 * specific question, which is a change from the original blind
 * `split(',')`. Matching against the questions' own options is what makes
 * per-question attribution possible at all, and it means a stub that is not
 * an answer can no longer masquerade as one (story-3 AC2).
 */
function labelsFromToolResult(questions: AskUserQuestionInput[], content: unknown): string[][] | undefined {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<tool_use_error>')) return undefined;
  return splitStubAcrossQuestions(questions, trimmed);
}

/**
 * The laptop's own answer stub is ONE string covering EVERY question, unlike
 * the composed text format (§5.3) which puts each question on its own line.
 * Attribution is therefore only possible where the boundary between two
 * questions' runs is knowable:
 *
 *  - one question — it takes the whole run, multiSelect or not;
 *  - several questions, all single-select — each takes exactly one label, in
 *    order, so position decides;
 *  - several questions where any is multiSelect — a multiSelect question
 *    could have consumed any number of the `", "`-joined labels, so the
 *    boundary is genuinely ambiguous. Return undefined rather than guess.
 *
 * The walk must also consume the stub exactly; leftover text means this is
 * not the shape we think it is. Every rejection degrades to an unhighlighted
 * card — the card can always tell "resolved" from "resolved with labels".
 */
function splitStubAcrossQuestions(questions: AskUserQuestionInput[], stub: string): string[][] | undefined {
  const [only] = questions;
  if (only === undefined) return undefined;
  if (questions.length === 1) {
    const picked = matchLabelRun(only, stub);
    return picked === null ? undefined : [picked];
  }
  if (questions.some((q) => q.multiSelect === true)) return undefined;
  const out: string[][] = [];
  let rest = stub;
  for (const q of questions) {
    const hit = longestFirstLabels(q).find((l) => rest === l || rest.startsWith(`${l}, `));
    if (hit === undefined) return undefined;
    out.push([hit]);
    rest = rest.slice(hit.length);
    if (rest.startsWith(', ')) rest = rest.slice(2);
  }
  return rest.length === 0 ? out : undefined;
}
```

- [ ] **Step 4: Adapt the `transcript-meta.ts` call site**

`daemon/src/lib/claude-adapter/transcript-meta.ts:100` currently reads:

```ts
      if (pendingQuestion && isResolvingUserEntry(e, pendingQuestion.toolUseId)) pendingQuestion = null;
```

Change to:

```ts
      if (pendingQuestion && isResolvingUserEntry(e, pendingQuestion)) pendingQuestion = null;
```

`pendingQuestion` is declared as `{ toolUseId: string; questions: AskUserQuestionInput[] } | null` — structurally a `DetectedQuestion`. This call only uses the result for truthiness, so its behaviour is unchanged.

- [ ] **Step 5: Run the daemon suite to verify it passes**

Run: `npm --prefix daemon test && npm --prefix daemon run typecheck`
Expected: `ask-user-question.test.ts` and `transcript-meta.test.ts` green. `tail.test.ts` may now FAIL to compile (it consumes `isResolvingUserEntry` only indirectly, but `tail.ts` itself still passes a bare `toolUseId`) — that is Task 3's job. If `npm --prefix daemon run typecheck` reports errors confined to `tail.ts`, that is expected; proceed.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/lib/claude-adapter/ask-user-question.ts daemon/src/lib/claude-adapter/transcript-meta.ts daemon/test/ask-user-question.test.ts
git commit -m "fix(askuserquestion-3): attribute answer-stub labels to their own question"
```

---

### Task 3: The wire shape in `tail.ts` (AC3)

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts:18, 116, 128-135, 150`
- Test: `daemon/test/tail.test.ts:98, 111, 177, 209-211, 234, 252`

**Interfaces:**
- Consumes: `isResolvingUserEntry(entry, pending: DetectedQuestion)` and `parseAnswerText(questions, text): string[][] | undefined` (Tasks 1–2).
- Produces: `TranscriptEvent`'s `askUserQuestion` variant with `selectedLabels?: string[][]`. Task 4 mirrors this exact shape in the PWA.

- [ ] **Step 1: Update the existing `selectedLabels` assertions and add the wire-level regression**

In `daemon/test/tail.test.ts`, every `expect(...selectedLabels).toEqual(['Yes'])` becomes `toEqual([['Yes']])` and every `toEqual(['No'])` becomes `toEqual([['No']])`. Those are at lines 98, 111, 177, 209, 211, 234 and 252. The `toBeUndefined()` assertions (lines 145, 193, 244, 287) are unchanged.

Then append this test inside `describe('parseChunk AskUserQuestion resolution — rule (b), human text turn (spec §4.1)')`:

```ts
  it('two questions sharing an option set keep their answers apart end-to-end (story-3 AC5, the regression)', () => {
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const twoQuestions = { questions: [yn('First'), yn('Second')] };
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', twoQuestions),
      userLine('Answering your questions:\n- First: Yes\n- Second: No', '2026-08-23T11:00:20.000Z'),
    ].join('\n') + '\n';
    const e = find(parseChunk(chunk).events);
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual([['Yes'], ['No']]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix daemon test -- tail`
Expected: FAIL — flat arrays where nested ones are expected, plus a compile error in `tail.ts` from Task 2's signature change.

- [ ] **Step 3: Change the type and the wiring**

In `daemon/src/lib/claude-adapter/tail.ts`, line 18 inside the `askUserQuestion` variant:

```ts
      /** One entry per question, in question order (story-3). Absent = "can't tell" for the whole call; never a partially-filled array. */
      selectedLabels?: string[][];
```

Line 116, the resolutions map:

```ts
  const resolutions = new Map<string, { resolvedBy: 'tool_result' | 'text'; selectedLabels: string[][] | undefined; at: string | undefined }>();
```

Line 128, the call into the adapter — pass the whole pending question instead of the bare id:

```ts
      const r = isResolvingUserEntry(parsed.data, { toolUseId: p.event.toolUseId, questions: p.event.questions });
```

Lines 131 and 134 (the two `resolutions.set` calls) and line 150 (the `exactOptionalPropertyTypes` spread) need **no textual change** — they already forward whatever `selectedLabels` type the adapter produces.

- [ ] **Step 4: Run the daemon gate to verify it passes**

Run: `npm --prefix daemon run typecheck && npm --prefix daemon test`
Expected: PASS, whole daemon suite green with no type errors.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "fix(askuserquestion-3): TranscriptEvent.selectedLabels carries one array per question"
```

---

### Task 4: PWA mirror and per-question highlighting (AC4, AC5)

**Files:**
- Modify: `pwa/src/lib/types.ts:31`
- Modify: `pwa/src/components/AskUserQuestionCard.tsx:54-55`
- Test: `pwa/test/ask-user-question-card.test.tsx:96`
- Test: `pwa/test/transcript-askuserquestion.test.tsx:21, 41`

**Interfaces:**
- Consumes: the wire shape produced by Task 3 — `selectedLabels?: string[][]`, one entry per question. This is a hand-maintained mirror (FENCE 1 forbids importing the daemon type), so it must match Task 3 exactly.
- Produces: nothing downstream — `AskUserQuestionCard` is a leaf.

- [ ] **Step 1: Write the regression test**

In `pwa/test/ask-user-question-card.test.tsx`, first update the existing resolved-with-labels test to the new shape:

```ts
  it('resolved with labels: dimmed, selected highlighted, nothing interactive even when answerable', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text', selectedLabels: [['Yes']] }} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Yes').className).toMatch(/amber/);
  });
```

Then append the regression test. Note it needs its own two-question fixture whose questions share an option set — the file's existing `two` fixture deliberately does not, so do not reuse it:

```ts
  it('two questions sharing an option label highlight only their OWN answer (story-3 AC4 — the bug this story fixes)', () => {
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const shared: Ask = {
      kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1',
      resolved: true, resolvedBy: 'text', selectedLabels: [['Yes'], ['No']],
      questions: [yn('First'), yn('Second')],
    };
    render(<AskUserQuestionCard e={shared} canAnswer inFlight={null} onAnswer={() => {}} />);
    // Two "Yes" nodes and two "No" nodes exist — one per question, in question order.
    const yeses = screen.getAllByText('Yes');
    const nos = screen.getAllByText('No');
    expect(yeses).toHaveLength(2);
    expect(nos).toHaveLength(2);
    expect(yeses[0]!.className).toMatch(/amber/);   // Q1 answered Yes  → highlighted
    expect(nos[0]!.className).not.toMatch(/amber/); // Q1's No          → not
    expect(yeses[1]!.className).not.toMatch(/amber/); // Q2's Yes       → not (the old bug lit this)
    expect(nos[1]!.className).toMatch(/amber/);     // Q2 answered No   → highlighted
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix pwa test -- ask-user-question-card`
Expected: FAIL. The regression test fails on `yeses[1]` — the flat `.includes('Yes')` lights Q2's "Yes" too. The updated resolved-with-labels test fails to typecheck (`string[][]` vs `string[]`) until Step 3.

- [ ] **Step 3: Mirror the wire shape and index by question**

`pwa/src/lib/types.ts`, inside the `askUserQuestion` variant, replace the `selectedLabels` line with:

```ts
      /** SYNC daemon tail.ts: one entry per question, in question order. Absent = "can't tell" for the whole call. */
      selectedLabels?: string[][];
```

`pwa/src/components/AskUserQuestionCard.tsx`, replace `isOn`:

```ts
  const isOn = (qi: number, label: string): boolean =>
    e.resolved ? !!e.selectedLabels?.[qi]?.includes(label) : !!shown[qi]?.includes(label);
```

Leave line 98's `e.resolved && e.selectedLabels === undefined` caption condition alone — outer-`undefined` still means "can't tell for this call", so its rendering is unchanged.

- [ ] **Step 4: Fix the two `Transcript` fixtures**

In `pwa/test/transcript-askuserquestion.test.tsx`, lines 21 and 41 both carry `selectedLabels: ['Yes']`. Change both to `selectedLabels: [['Yes']]`. No other change — those tests assert on a single-question event.

- [ ] **Step 5: Run the PWA gate to verify it passes**

Run: `npm --prefix pwa run typecheck && npm --prefix pwa test`
Expected: PASS, whole PWA suite green.

- [ ] **Step 6: Commit**

```bash
git add pwa/src/lib/types.ts pwa/src/components/AskUserQuestionCard.tsx pwa/test/ask-user-question-card.test.tsx pwa/test/transcript-askuserquestion.test.tsx
git commit -m "fix(askuserquestion-3): highlight each question's own answer in the resolved card"
```

---

### Task 5: Spec close-out and the AC2 empirical probe (AC2, AC6)

**Files:**
- Modify: `docs/features/askuserquestion-answer-mechanism/spec.md` — §4.1 clause (a), §5.3, §6 signature line, §7.1 table row
- Modify: `docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-answer-accepted.ts:98`
- Create: `docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts`

**Interfaces:**
- Consumes: `detectAskUserQuestion` and `isResolvingUserEntry` from the daemon adapter (Tasks 1–2) — the probe drives the *shipped* code, so it can never test a re-implementation.
- Produces: nothing downstream.

**Why the probe exists:** AC2 requires the per-question split of the laptop's own answer stub to be confirmed empirically rather than assumed, and no fixture in this repo records a real **multi-question** stub — architecture-spec F16 only captured a single-question one (`content: "Yes"`), and the `'Yes, No'` in the tests is a synthesized value. Task 2's walk is written to be correct either way (it parses exactly or says "can't tell"), so the probe is confirmation, not a blocker. It reads `~/.claude/projects/` — the adapter's own data domain — so it lives under `docs/`, is run by the developer, and redacts by default.

- [ ] **Step 1: Write the probe**

Create `docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts`:

```ts
/**
 * AC2 empirical probe for askuserquestion-answer-mechanism-3.
 *
 * The question AC2 asks: when the laptop itself answers a MULTI-question
 * AskUserQuestion, what does the resulting tool_result stub actually look
 * like, and can `isResolvingUserEntry` attribute it per question?
 *
 * This drives the SHIPPED adapter (detectAskUserQuestion +
 * isResolvingUserEntry) over real transcripts, so a PASS here is a statement
 * about the code that ships, not about a re-implementation.
 *
 * Redacted by default: option labels and stub content are replaced with
 * positional placeholders, so the output carries the SHAPE of the stub and
 * nothing a conversation said. Pass --raw to see the literal strings (useful
 * when a case does not parse and you need to see why).
 *
 * Usage, from the repo root — via the REPO'S OWN pinned `tsx` (a root
 * devDependency, so the lockfile fixes its version), never `npx tsx`, which
 * would fetch an undeclared executable from the network:
 *   ./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts
 *   ./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts --raw
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectAskUserQuestion, isResolvingUserEntry } from '../../../../daemon/src/lib/claude-adapter/ask-user-question.js';
import { TranscriptLineSchema } from '../../../../daemon/src/lib/claude-adapter/schemas.js';

const RAW = process.argv.includes('--raw');
const ROOT = join(homedir(), '.claude', 'projects');

function transcripts(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) out.push(...transcripts(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function show(s: string): string {
  return RAW ? JSON.stringify(s) : `<${s.length} chars, ${s.split(', ').length} ", "-separated part(s)>`;
}

let files = 0, asks = 0, multi = 0, stubs = 0, parsed = 0;
const failures: string[] = [];

for (const file of transcripts(ROOT)) {
  files += 1;
  let lines: string[];
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }

  const parsedLines = lines.map((l) => {
    const t = l.trim();
    if (!t) return null;
    try { return TranscriptLineSchema.safeParse(JSON.parse(t)); } catch { return null; }
  });

  for (const [i, pl] of parsedLines.entries()) {
    if (!pl?.success || pl.data.type !== 'assistant') continue;
    const detected = detectAskUserQuestion(pl.data.message.content);
    if (!detected) continue;
    asks += 1;
    if (detected.questions.length < 2) continue;
    multi += 1;

    for (const later of parsedLines.slice(i + 1)) {
      if (!later?.success || later.data.type !== 'user') continue;
      const r = isResolvingUserEntry(later.data, detected);
      if (!r || r.by !== 'tool_result') continue;
      stubs += 1;
      const headers = detected.questions.map((q) => q.header).join(' | ');
      if (r.selectedLabels === undefined) {
        failures.push(`  ✗ ${detected.questions.length} questions [${RAW ? headers : 'redacted'}] — stub did NOT split per question`);
      } else {
        parsed += 1;
        console.log(`  ✓ ${detected.questions.length} questions → ${JSON.stringify(r.selectedLabels.map((ls) => RAW ? ls : ls.length))}`);
      }
      break;
    }
  }
}

console.log(`\nScanned ${files} transcript file(s) under ~/.claude/projects`);
console.log(`  AskUserQuestion calls found:            ${asks}`);
console.log(`  ...with 2+ questions:                   ${multi}`);
console.log(`  ...answered by a tool_result stub:      ${stubs}`);
console.log(`  ...whose stub split per question:       ${parsed}`);
for (const f of failures) console.log(f);

if (stubs === 0) {
  console.log('\nINCONCLUSIVE — no multi-question call was ever answered by a tool_result stub in these transcripts.');
  console.log('That is itself the AC2 finding: the asymmetry is unobservable here, and the code says "can\\'t tell" rather than guessing.');
} else if (parsed === stubs) {
  console.log('\nCONFIRMED — every real multi-question stub split per question.');
} else {
  console.log(`\nPARTIAL — ${stubs - parsed} real stub(s) could not be split. Re-run with --raw and record the shape in spec §4.1.`);
}
```

- [ ] **Step 2: Verify the probe compiles and runs**

Run: `./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts` — the repo's own pinned `tsx` (root
devDependency), not `npx tsx`, which would resolve an unreviewed executable from
the network at whatever version is current.
Expected: it runs to completion and prints a summary. Any of CONFIRMED / PARTIAL / INCONCLUSIVE is a valid result — record which one in the PR body and in spec §4.1 if it is not CONFIRMED. It must not throw.

- [ ] **Step 3: Fix the story-1 verify script's inline type**

`docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-answer-accepted.ts:98` declares the transcript event shape inline. Change `selectedLabels?: string[]` to `selectedLabels?: string[][]` so the annotation matches the wire it reads. The `JSON.stringify` on line 100 needs no change.

- [ ] **Step 4: Update the spec (AC6 and the surrounding accuracy)**

In `docs/features/askuserquestion-answer-mechanism/spec.md`:

**§4.1 clause (a)** — replace `` `selectedLabels` = the block's string content split on `,` (as today), **except** that `isResolvingUserEntry` normalises to `selectedLabels: undefined` when the content is not a string, is empty, or begins with `<tool_use_error>` `` with:

> `selectedLabels` = the block's string content matched against the pending questions' **own option labels**, longest label first, and attributed one array per question: one question takes the whole run; several all-single-select questions take one label each, positionally; several questions where any is `multiSelect` is genuinely ambiguous and yields `undefined`. `isResolvingUserEntry` also normalises to `selectedLabels: undefined` when the content is not a string, is empty, begins with `<tool_use_error>` (the CLI's own rejection, §2 corollary), or is not an exact run of those labels

**§5.3** — change "On a full match it returns the flat list of matched labels (used as `selectedLabels`)" to "On a full match it returns **one array of labels per question**, in question order (used as `selectedLabels`)".

**§6** — change the `isResolvingUserEntry` signature line to:

> `isResolvingUserEntry(entry, pending: DetectedQuestion): { by: 'tool_result'; selectedLabels: string[][] | undefined } | { by: 'text'; text: string } | null` — the rule in §4.1. Takes the whole pending question (not just its id) because attributing labels to a question needs the option lists.

**§7.1** — replace the *Resolved with labels* row's Rendering cell with:

> As today: dimmed, selected labels highlighted (amber). `selectedLabels` is **one array per question** (`string[][]`), matched by `selectedLabels[qi]`, so two questions sharing an option label each highlight only their own answer. *(Fixed in story `askuserquestion-answer-mechanism-3`; this row previously carried a Known limitation describing the flat-list cross-highlight bug.)*

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three green.

- [ ] **Step 6: Commit**

```bash
git add docs/features/askuserquestion-answer-mechanism/spec.md \
        docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts \
        docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-answer-accepted.ts
git commit -m "docs(askuserquestion-3): per-question selectedLabels in the spec + AC2 probe"
```

---

## Acceptance-criteria coverage

| AC | Covered by |
|---|---|
| 1 — `parseAnswerText` returns `string[][]` | Task 1 |
| 2 — `tool_result` clause scoped per question, or the asymmetry documented empirically | Task 2 (implementation) + Task 5 (probe, and the §4.1 wording that records whichever outcome the probe shows) |
| 3 — `TranscriptEvent.selectedLabels: string[][] \| undefined` on both sides | Task 3 (daemon) + Task 4 (PWA mirror) |
| 4 — `isOn(qi, label)` matches per question | Task 4 |
| 5 — existing tests updated; new shared-label regression test | Tasks 1–4 (regression asserted at three levels: parser, wire, card) |
| 6 — spec §7.1 Known limitation closed | Task 5 |

---

### Task 7: Parse the laptop's REAL answer-stub format (AC7)

**Added 2026-09-08.** AC2's empirical probe inverted its own premise: the stub CAN be split per question, because the real format already pairs each question with its label. This task closes AC2 properly instead of documenting an asymmetry that does not exist.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/ask-user-question.ts` (`labelsFromToolResult` + one new module-private helper)
- Test: `daemon/test/ask-user-question.test.ts`
- Test: `daemon/test/tail.test.ts` (one wire-level case)
- Modify: `docs/features/askuserquestion-answer-mechanism/spec.md` (§4.1 clause (a) — replace the "shape remains unobserved" paragraph with the measured finding)

**Interfaces:**
- Consumes: `matchLabelRun(q, text): string[] | null` and `splitStubAcrossQuestions(questions, stub): string[][] | undefined` (Tasks 1-2, unchanged).
- Produces: `labelsFromPairFormat(questions, stub): string[][] | undefined` — module-private. `labelsFromToolResult` keeps its signature and return type.

**The measured evidence (do not re-derive, this is the spec input):** a probe over 1306 real transcripts found 374 `AskUserQuestion` calls. Of 308 single-question calls answered by a stub, only **9** matched the `", "`-joined bare-label assumption; of 50 multi-question calls, **0** did. The 349 non-matching stubs fall into 107 shapes whose three most common — 215 of 349 — are:

```
× 195  1 question    · · · · ·: "<Q>"="<L>". · · · · · · · · ·.
×  17  2 questions   · · · · ·: "<Q>"="<L>", "<Q>"="<L>". · · · · · · · · ·.
×   3  3 questions   · · · · ·: "<Q>"="<L>", "<Q>"="<L>", "<Q>"="<L>". · · ·.
```

i.e. `Your questions have been answered: "<question text>"="<selected label>", … . You can now continue with these answers in mind.` A verbatim specimen, captured live:

```
Your questions have been answered: "Which behaviour do you want?"="Positional map (Recommended)", "Where should the shaping live?"="In ask-user-question.ts (Recommended)". You can now continue with these answers in mind.
```

Remaining shapes are mostly the same format where the value is a free-text **"Other"** answer rather than an option label.

**Design — anchor on known literals, never on quote-counting.** Question texts and labels can themselves contain `"`, so a regex over quoted pairs is fragile. Instead, for each pending question, search for the literal `"<that question's own question text>"="` and read the value that follows. Surrounding prose is then irrelevant, and question order does not matter.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/ask-user-question.test.ts`, inside the clause-(a) describe block:

```ts
  const REAL_TAIL = '. You can now continue with these answers in mind.';
  const realStub = (pairs: [string, string][]) =>
    `Your questions have been answered: ${pairs.map(([q, l]) => `"${q}"="${l}"`).join(', ')}${REAL_TAIL}`;

  it('parses the laptop\'s REAL pair-format stub for one question (AC7 — 195 of 349 observed stubs)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('parses the REAL pair-format stub for two questions that share an option set (AC7 — the whole point)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const qs = [yn('First'), yn('Second')];
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['First?', 'Yes'], ['Second?', 'No']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: qs }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });

  it('a multiSelect question\'s pair value is a ", "-joined run of its own labels', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which parts?', 'Frontend, Backend']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend', 'Backend']] });
  });

  it('a free-text ("Other") value matches no option label, so the WHOLE call is undefined (AC7 + AC3 all-or-nothing)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'actually, let me think about it']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a pair stub missing one of the pending questions is undefined, not a partial answer', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['First?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('order does not matter — anchoring is per question, not positional', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Second?', 'No'], ['First?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });

  it('the bare-label run still works — it is the fallback, not replaced (the 9 of 308 that matched)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('a question whose own question text is empty is undefined — an empty anchor would match anywhere', () => {
    const blank: AskUserQuestionInput = { question: '', header: 'Blank', options: [{ label: 'Yes', description: '' }], multiSelect: false };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [blank] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
```

Add one wire-level case to `daemon/test/tail.test.ts`, inside the clause-(a) describe block:

```ts
  it('a two-question call resolved by the REAL pair-format stub splits per question at the wire (story-3 AC7)', () => {
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const stub = 'Your questions have been answered: "First?"="Yes", "Second?"="No". You can now continue with these answers in mind.';
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', { questions: [yn('First'), yn('Second')] }),
      toolResultLine('toolu_1', stub),
    ].join('\n') + '\n';
    const e = events(chunk);
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual([['Yes'], ['No']]);
  });
```

(Use whatever the file's existing `find(parseChunk(chunk).events)` idiom is instead of `events(chunk)` — match the surrounding tests.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix daemon test -- ask-user-question` and `npm --prefix daemon test -- tail`
Expected: the pair-format tests FAIL (the stub does not begin with an option label, so `splitStubAcrossQuestions` rejects it and `selectedLabels` is `undefined`). The bare-label fallback test and the empty-question test should already PASS.

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/ask-user-question.ts`, add the helper next to `splitStubAcrossQuestions`:

```ts
/**
 * The laptop's own answer stub, in the format Claude Code actually writes —
 * measured over 1306 real transcripts (story-3 AC7, probe
 * `docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts`):
 *
 *   Your questions have been answered: "<question text>"="<label>", "<question text>"="<label>".
 *   You can now continue with these answers in mind.
 *
 * The format is ALREADY per-question, which is why AC2's "can it be split"
 * premise was wrong: it pairs each question with its own answer.
 *
 * Anchoring is on the literal `"<question text>"="` for each PENDING question,
 * never on counting quotes — question texts and labels may both contain `"`,
 * so a quote-scanning parser would mis-split. Consequences of anchoring:
 * surrounding prose is irrelevant (the leading and trailing sentences vary),
 * and the pairs may appear in any order.
 *
 * All-or-nothing, like every other path here: a question that is absent, or
 * whose value is a free-text "Other" answer rather than one of its own option
 * labels, makes the WHOLE call undefined rather than a partial attribution
 * (AC3's invariant — a defined result always has exactly `questions.length`
 * non-empty entries).
 */
function labelsFromPairFormat(questions: AskUserQuestionInput[], stub: string): string[][] | undefined {
  const out: string[][] = [];
  for (const q of questions) {
    if (q.question.length === 0) return undefined;
    const anchor = `"${q.question}"="`;
    const at = stub.indexOf(anchor);
    if (at === -1) return undefined;
    const from = at + anchor.length;
    const close = stub.indexOf('"', from);
    if (close === -1) return undefined;
    const picked = matchLabelRun(q, stub.slice(from, close));
    if (picked === null) return undefined;
    out.push(picked);
  }
  return out.length === questions.length ? out : undefined;
}
```

Then change the last line of `labelsFromToolResult` from
`return splitStubAcrossQuestions(questions, trimmed);`
to:

```ts
  // The pair format is what Claude Code actually writes (AC7); the bare-label
  // run is kept as a fallback — it matched 9 of 308 observed single-question
  // stubs, and it is the shape architecture-spec F16's hand-written stub used.
  return labelsFromPairFormat(questions, trimmed) ?? splitStubAcrossQuestions(questions, trimmed);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix daemon run typecheck && npm --prefix daemon test`
Expected: whole daemon suite green, no pre-existing test regressed.

- [ ] **Step 5: Update spec §4.1 with the measured finding**

Clause (a) currently carries a paragraph saying the real stub shape "remains unobserved as of story-3". Replace it with the measurement: the real format is the `"<question>"="<label>"` pair format shown above; it is parsed by anchoring per question; the bare-label run is retained as a fallback; a free-text "Other" value yields `undefined` for the whole call. Quote the observed counts (9/308 single-question and 0/50 multi-question matched the bare-label assumption; 349 stubs in 107 shapes, top three = 215). Match the section's existing voice.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/lib/claude-adapter/ask-user-question.ts daemon/test/ask-user-question.test.ts daemon/test/tail.test.ts docs/features/askuserquestion-answer-mechanism/spec.md
git commit -m "fix(askuserquestion-3): parse the real answer-stub format, per question"
```
