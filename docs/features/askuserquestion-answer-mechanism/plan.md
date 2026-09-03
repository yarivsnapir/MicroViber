# AskUserQuestion Answer Mechanism — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a phone user answer a pending `AskUserQuestion` in a taken-over session by tapping options, with the answer sent as a plain user turn and the question's resolution re-derived from the transcript alone.

**Architecture:** A new adapter module `daemon/src/lib/claude-adapter/ask-user-question.ts` owns detection, the two-clause resolution rule (matching `tool_result`, or any later non-meta, non-`origin` human text turn), and the fixed answer-text format with its parser. `tail.ts` and `transcript-meta.ts` both call it. `services.sendPrompt` accepts a discriminated body (`{text}` | `{answer}`), validates an answer against the currently pending question, composes the text, and pushes it through the unchanged `PromptLifecycle.submit()` → `send()` → `userFrame()` path. The story-8 `tool_result` write plumbing is deleted. The PWA gets an `AskUserQuestionCard` with selectable chips and one **Send answers** button.

**Tech Stack:** Node 22 + TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Fastify, zod, vitest; PWA: Vite + React 19 + Tailwind, vitest + @testing-library/react (jsdom).

**Spec:** `docs/features/askuserquestion-answer-mechanism/spec.md` (section numbers below refer to it). **Judge:** `docs/architecture-spec.md` §5 threat model + §6 engineering standards.

## Global Constraints

- **Testing gate** (architecture-spec §6): `cd microviber && npm run typecheck && npm run lint && npm test` must be green before every commit. Per-workspace shortcuts while iterating: `cd microviber/daemon && npx vitest run test/<file>.test.ts`; `cd microviber/pwa && npx vitest run test/<file>.test.tsx`.
- **Adapter quarantine** (§6, lint FENCE 2): only `daemon/src/lib/claude-adapter/**` may model transcript vocabulary (`isMeta`, `origin`, `tool_result`, the answer text format). `domain/`, `services/`, `api/` consume only the adapter's exported types/functions.
- **Layering fence:** `schemas/ → domain/ → services/ → api/`, no upward imports. PWA never imports from `daemon/` (FENCE 1); its `pwa/src/lib/types.ts` is a hand-maintained mirror.
- **zod at every boundary; no `any`** (`@typescript-eslint/no-explicit-any` is an error). No non-null assertions (`!`) — a prior review rejected one; use narrowing or `?? default`.
- **Threat model:** no change to T1–T12 mitigations; the daemon keeps driving sessions only via `claude -p --resume … --input-format stream-json` (session-manager.ts `startTakeoverSession` argv is untouched). Task 5 adds a T11 narrowing note only. No new endpoint, header, cookie, or env var.
- **Fail closed:** any malformed or stale answer is rejected (400) before any write; rejected attempts are still audited.
- **Copy (verbatim):** button label `Send answers`; hint `or type a reply below`; caption for resolved-without-labels `no longer pending`; answer heading `Answering your question:` (one question) / `Answering your questions:` (several); per-question line `- <header>: <label>, <label>`.
- **Commit style:** conventional, scoped, e.g. `feat(askuserquestion): …`, `refactor(claude-adapter): …`, `docs(…): …`; every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Branch:** `feature/askuserquestion-answer-mechanism` in the microviber repo (already cut from `story/microviber-track-b-8`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `daemon/src/lib/claude-adapter/ask-user-question.ts` | Create | Detection, resolution rule, `composeAnswerText`/`parseAnswerText`, `ANSWER_TEXT_MAX_CHARS` |
| `daemon/src/lib/claude-adapter/schemas.ts` | Modify | `isMeta: z.boolean().optional()` on the `user` line; export `UserTranscriptLine` type |
| `daemon/src/lib/claude-adapter/tail.ts` | Modify | Use the helper; rule (b); `resolvedBy`; keep text turns |
| `daemon/src/lib/claude-adapter/transcript-meta.ts` | Modify | Use the helper; rule (b) clears `pendingQuestion` |
| `daemon/src/lib/claude-adapter/prompt-sender.ts` | Modify | Delete `toolResultFrame`, `sendAnswer` |
| `daemon/src/lib/claude-adapter/session-manager.ts` | Modify | Delete `sendAnswer` + re-export |
| `daemon/src/domain/prompt-lifecycle.ts` | Modify | Delete answer methods; add `answerBody`, `findReplay()` |
| `daemon/src/domain/answer.ts` | Create | Pure: `canonicalAnswerBody`, `validateAnswer` |
| `daemon/src/schemas/api.ts` | Modify | `SendPromptBody` becomes a union; export `AnswerBody` type |
| `daemon/src/services/services.ts` | Modify | Answer path: replay → re-derive → validate → compose → submit; audit |
| `daemon/src/api/app.ts` | Modify | `AppDeps.sendPrompt` takes `body`; route passes it through |
| `daemon/test/ask-user-question.test.ts` | Create | Rule + compose/parse tests |
| `daemon/test/answer.test.ts` | Create | Validation tests |
| `daemon/test/{tail,transcript-meta,prompt-lifecycle,services,app,session-manager,schemas}.test.ts` | Modify | Updated for new behaviour / removals |
| `pwa/src/lib/types.ts` | Modify | `resolvedBy`, `PromptRecord.answerBody`, drop `toolUseId` |
| `pwa/src/lib/api.ts` | Modify | `postAnswer`; `sendPrompt` loses `toolUseId` |
| `pwa/src/components/AskUserQuestionCard.tsx` | Create | The card (all §7.1 states) |
| `pwa/src/components/Transcript.tsx` | Modify | Delegate `askUserQuestion` to the card; new props |
| `pwa/src/App.tsx` | Modify | In-flight slot with `kind`/`toolUseId`; `sendAnswer`; poll by kind |
| `pwa/test/ask-user-question-card.test.tsx` | Create | Card states |
| `pwa/test/transcript-askuserquestion.test.tsx`, `pwa/test/app-answer.test.tsx`, `pwa/test/api.test.ts` | Modify/Create | Wiring tests |
| `docs/architecture-spec.md`, `docs/functional-spec.md`, `docs/features/microviber-track-b/stories/story-8.md`, `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md` | Modify | F18 + addendum, §3/§4/T11, functional-spec Changed entries, pointers |

---

### Task 1: Gating spike — F18 addendum (`isMeta` / `origin` on human turns)

**Files:**
- Modify: `docs/architecture-spec.md` (§2 table — add row F18 with the addendum)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded PASS/FAIL that decides whether Task 3's rule (b) uses "no `origin` field" (PASS) or an explicit denylist (FAIL). Every later task assumes PASS unless this row says otherwise.

**Why a human runs the grep.** Transcripts live under `~/.claude/projects/`, outside the repo. The workspace's organisation policy forbids an agent from running scripts that read outside the project workspace, so the implementer does not read those files. The spike is a request to the user, who runs one command and pastes the output. (Story-8's F16/F17 evidence was gathered the same way.)

- [ ] **Step 1: Ask the user to run this on the laptop and paste the output**

```bash
# Finds, in the most recently modified transcript, every user-role line that is a HUMAN turn
# (has a text block or string content) and prints only the fields the rule keys on.
f=$(ls -t ~/.claude/projects/*/*.jsonl | head -1); echo "$f"
grep '"type":"user"' "$f" | python3 -c '
import sys, json
for line in sys.stdin:
    try: o = json.loads(line)
    except Exception: continue
    c = o.get("message", {}).get("content")
    is_text = isinstance(c, str) or (isinstance(c, list) and any(b.get("type") == "text" for b in c if isinstance(b, dict)))
    if not is_text: continue
    t = c if isinstance(c, str) else " ".join(b.get("text","") for b in c if isinstance(b, dict) and b.get("type")=="text")
    print(json.dumps({"isMeta": o.get("isMeta"), "origin": o.get("origin"), "text": t[:60]}))'
```

Ask them to run it against (a) a transcript with a laptop-typed turn and (b) one that received a phone-injected turn via MicroViber takeover (any earlier live test session works). A prior session already observed `"isMeta": true` on `Continue from where you left off.` — that line may appear; it is the excluded one.

- [ ] **Step 2: Record the outcome as row F18 in `docs/architecture-spec.md` §2**

Insert after the F17 row:

```markdown
| F18 | **The F17 handshake is conditional, not intrinsic; `AskUserQuestion` is hard-disabled in `-p`; human turns carry neither `isMeta` nor `origin`** | (1) Resuming a session whose transcript ended with `stop_reason: end_turn` via `claude -p --verbose --resume <id> --input-format stream-json --output-format stream-json`, with stdin held open but idle for 12–20 s, produced **no** synthetic turn and no `system/init` line until the first stdin frame; the "Continue from where you left off." turn fires only when the resumed transcript ends on a dangling `tool_use` (the SDK's documented `origin: "auto-continuation"`). (2) `-p` with `--tools default,AskUserQuestion`: the model's call is answered by the CLI with `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>` — no headless variant exposes it, so a daemon-owned process can never produce a pending question. (3) A headless CLI killed mid-tool writes its own `tool_result` (`Exit code 137`) before exiting, so dangling tool_uses cannot be manufactured headlessly. Observed on CLI 2.1.259, stdout only, 2026-09-03. **Addendum (spike, <DATE>):** on real transcripts, a laptop-typed user turn and a phone-injected user turn both have `isMeta` absent/false and no `origin` field — <PASS or FAIL + the observed values>. This is what the §4.1 rule in `docs/features/askuserquestion-answer-mechanism/spec.md` keys on; re-verify on every Claude Code version change. |
```

Replace `<DATE>` and the `<PASS or FAIL …>` placeholder with the pasted evidence (quote one redacted line per case). If FAIL: also list the `origin.kind` values seen on human turns, and note in the row that Task 3 uses the denylist variant.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture-spec.md
git commit -m "docs(architecture-spec): record F18 — conditional resume handshake, AskUserQuestion disabled in -p, isMeta/origin spike

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Adapter helper `ask-user-question.ts` + `isMeta` in the schema

**Files:**
- Modify: `daemon/src/lib/claude-adapter/schemas.ts:68-80` (user line) — add `isMeta`, export `UserTranscriptLine`
- Create: `daemon/src/lib/claude-adapter/ask-user-question.ts`
- Test: `daemon/test/ask-user-question.test.ts`, `daemon/test/schemas.test.ts`

**Interfaces:**
- Consumes: `ToolUseBlock`, `ToolResultBlock`, `AskUserQuestionInputSchema`, `AskUserQuestionInput`, `TranscriptLine` from `./schemas.js`.
- Produces (used by Tasks 3, 4, 6):
  ```ts
  export interface DetectedQuestion { toolUseId: string; questions: AskUserQuestionInput[] }
  export function detectAskUserQuestion(assistantContent: unknown): DetectedQuestion | null;
  export type Resolution =
    | { by: 'tool_result'; selectedLabels: string[] | undefined }
    | { by: 'text'; text: string };
  export function isResolvingUserEntry(entry: UserTranscriptLine, toolUseId: string): Resolution | null;
  export const ANSWER_TEXT_MAX_CHARS = 4000;
  export function composeAnswerText(questions: AskUserQuestionInput[], selections: string[][]): string;
  export function parseAnswerText(questions: AskUserQuestionInput[], text: string): string[] | undefined;
  ```
  and from `schemas.ts`: `export type UserTranscriptLine = Extract<TranscriptLine, { type: 'user' }>`.

- [ ] **Step 1: Write the failing tests**

`daemon/test/ask-user-question.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  detectAskUserQuestion, isResolvingUserEntry, composeAnswerText, parseAnswerText, ANSWER_TEXT_MAX_CHARS,
} from '../src/lib/claude-adapter/ask-user-question.js';
import { TranscriptLineSchema, type UserTranscriptLine, type AskUserQuestionInput } from '../src/lib/claude-adapter/schemas.js';

const q1: AskUserQuestionInput = { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false };
const q2: AskUserQuestionInput = { question: 'Which parts?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }, { label: 'Frontend, and docs', description: '' }], multiSelect: true };

function userEntry(extra: Record<string, unknown>): UserTranscriptLine {
  const parsed = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', ...extra }, timestamp: '2026-09-03T10:00:00Z', ...('isMeta' in extra ? { isMeta: extra.isMeta } : {}), ...('origin' in extra ? { origin: extra.origin } : {}) });
  if (parsed.type !== 'user') throw new Error('not a user line');
  return parsed;
}
const textEntry = (text: string, top: Record<string, unknown> = {}) => userEntry({ content: [{ type: 'text', text }], ...top });

describe('detectAskUserQuestion', () => {
  it('returns the id + questions for a well-formed AskUserQuestion tool_use', () => {
    const d = detectAskUserQuestion([{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [q1] } }]);
    expect(d?.toolUseId).toBe('toolu_1');
    expect(d?.questions[0]?.header).toBe('Confirm');
  });
  it('returns null for another tool, malformed input, or non-array content', () => {
    expect(detectAskUserQuestion([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])).toBeNull();
    expect(detectAskUserQuestion([{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { nope: 1 } }])).toBeNull();
    expect(detectAskUserQuestion('text')).toBeNull();
  });
});

describe('isResolvingUserEntry — clause (a) tool_result', () => {
  it('resolves on a matching tool_result and splits its labels', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toEqual({ by: 'tool_result', selectedLabels: ['Yes', 'No'] });
  });
  it('a tool_result for a different id, with no text, does not resolve', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_OTHER', content: 'ok' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
  });
  it('normalises non-string, empty, and <tool_use_error> content to selectedLabels: undefined', () => {
    for (const content of [{ some: 'object' }, '', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>']) {
      const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] });
      expect(isResolvingUserEntry(e, 'toolu_1')).toEqual({ by: 'tool_result', selectedLabels: undefined });
    }
  });
});

describe('isResolvingUserEntry — clause (b) human turn', () => {
  it('resolves on a plain text turn', () => {
    expect(isResolvingUserEntry(textEntry('Yes'), 'toolu_1')).toEqual({ by: 'text', text: 'Yes' });
  });
  it('resolves on string content (the interruption marker shape)', () => {
    expect(isResolvingUserEntry(userEntry({ content: '[Request interrupted by user]' }), 'toolu_1')).toEqual({ by: 'text', text: '[Request interrupted by user]' });
  });
  it('does NOT resolve on the isMeta handshake turn', () => {
    expect(isResolvingUserEntry(textEntry('Continue from where you left off.', { isMeta: true }), 'toolu_1')).toBeNull();
  });
  it('isMeta: false is a human turn', () => {
    expect(isResolvingUserEntry(textEntry('hi', { isMeta: false }), 'toolu_1')?.by).toBe('text');
  });
  it('does NOT resolve on an entry carrying an origin (task-notification)', () => {
    const e = userEntry({ content: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
  });
  it('a tool_result-only entry has no human text and does not resolve via (b)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
  });
});

describe('composeAnswerText / parseAnswerText', () => {
  it('one question: singular heading, one line', () => {
    expect(composeAnswerText([q1], [['Yes']])).toBe('Answering your question:\n- Confirm: Yes');
  });
  it('several questions: plural heading, one line each, labels joined by ", "', () => {
    expect(composeAnswerText([q1, q2], [['No'], ['Frontend', 'Backend']])).toBe('Answering your questions:\n- Confirm: No\n- Scope: Frontend, Backend');
  });
  it('round-trips, including a label that itself contains ", "', () => {
    const text = composeAnswerText([q1, q2], [['Yes'], ['Frontend, and docs', 'Backend']]);
    expect(parseAnswerText([q1, q2], text)).toEqual(['Yes', 'Frontend, and docs', 'Backend']);
  });
  it('returns undefined for free text, a wrong heading, a missing line, or an unknown label', () => {
    expect(parseAnswerText([q1], 'just do it')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1, q2], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: Maybe')).toBeUndefined();
  });
  it('exports the 4000-char backstop', () => { expect(ANSWER_TEXT_MAX_CHARS).toBe(4000); });
});
```

Append to `daemon/test/schemas.test.ts`:

```ts
import { TranscriptLineSchema } from '../src/lib/claude-adapter/schemas.js';
describe('TranscriptLineSchema user.isMeta', () => {
  it('parses isMeta when present and leaves it undefined when absent', () => {
    const withMeta = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', content: 'x' }, isMeta: true });
    const without = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', content: 'x' } });
    expect(withMeta.type === 'user' && withMeta.isMeta).toBe(true);
    expect(without.type === 'user' && without.isMeta).toBeUndefined();
  });
});
```
(Add the `describe`/`it`/`expect` import to that file's existing vitest import if it isn't already there.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/ask-user-question.test.ts test/schemas.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/claude-adapter/ask-user-question.js'`; the schema test fails on `isMeta` being stripped (`undefined` instead of `true`).

- [ ] **Step 3: Add `isMeta` to the schema and export the user-line type**

In `daemon/src/lib/claude-adapter/schemas.ts`, inside the `user` object of `TranscriptLineSchema`, after `origin: …`:

```ts
    // Claude Code stamps `isMeta: true` on the synthetic user turns it
    // injects itself — notably the "Continue from where you left off."
    // auto-continuation on resume (architecture-spec.md F17/F18). Human
    // turns leave it absent (or false). The basis of ask-user-question.ts's
    // rule (b): a meta turn never counts as a person answering.
    isMeta: z.boolean().optional(),
```

After `export type TranscriptLine = …` add:

```ts
export type UserTranscriptLine = Extract<TranscriptLine, { type: 'user' }>;
```

- [ ] **Step 4: Create the helper**

`daemon/src/lib/claude-adapter/ask-user-question.ts`:

```ts
import { ToolUseBlock, ToolResultBlock, AskUserQuestionInputSchema, type AskUserQuestionInput, type UserTranscriptLine } from './schemas.js';

/**
 * Everything MicroViber knows about AskUserQuestion in one place (spec
 * askuserquestion-answer-mechanism §4.2): detection of the tool_use, the
 * two-clause resolution rule, and the daemon-composed answer format with its
 * parser. tail.ts (per-occurrence events) and transcript-meta.ts (the rolling
 * pendingQuestion slot) both call these — never re-implement the rule.
 */
export interface DetectedQuestion { toolUseId: string; questions: AskUserQuestionInput[] }

/** First well-formed AskUserQuestion tool_use in an assistant message's content, else null. Never throws. */
export function detectAskUserQuestion(assistantContent: unknown): DetectedQuestion | null {
  if (!Array.isArray(assistantContent)) return null;
  for (const block of assistantContent) {
    const parsedBlock = ToolUseBlock.safeParse(block);
    if (!parsedBlock.success || parsedBlock.data.name !== 'AskUserQuestion') continue;
    const parsedInput = AskUserQuestionInputSchema.safeParse(parsedBlock.data.input);
    if (!parsedInput.success) continue;
    return { toolUseId: parsedBlock.data.id, questions: parsedInput.data.questions };
  }
  return null;
}

export type Resolution =
  | { by: 'tool_result'; selectedLabels: string[] | undefined }
  | { by: 'text'; text: string };

/**
 * Spec §4.1. A later user entry resolves a pending question when EITHER
 *  (a) it carries a tool_result whose tool_use_id matches (the laptop's own
 *      answer stub), or
 *  (b) it is a human turn: has text, is not `isMeta` (the resume handshake,
 *      F17/F18), and has no `origin` (synthetic task-notifications).
 * Fail-closed on (b): any entry with an `origin` field is never a person
 * (F18 addendum records that real human turns carry none).
 */
export function isResolvingUserEntry(entry: UserTranscriptLine, toolUseId: string): Resolution | null {
  const content = entry.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const r = ToolResultBlock.safeParse(block);
      if (r.success && r.data.tool_use_id === toolUseId) {
        return { by: 'tool_result', selectedLabels: labelsFromToolResult(r.data.content) };
      }
    }
  }
  if (entry.isMeta === true) return null;
  if (entry.origin !== undefined) return null;
  const text = humanText(content);
  return text === null ? null : { by: 'text', text };
}

/** One "no labels" shape for the card: undefined for non-string, empty, or CLI-error content. */
function labelsFromToolResult(content: unknown): string[] | undefined {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<tool_use_error>')) return undefined;
  const labels = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : undefined;
}

function humanText(content: unknown): string | null {
  if (typeof content === 'string') return content.length ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join(' ') : null;
}

/** Backstop only — a validated answer never approaches this (spec §5.3). */
export const ANSWER_TEXT_MAX_CHARS = 4000;

const HEADING_ONE = 'Answering your question:';
const HEADING_MANY = 'Answering your questions:';

/** Spec §5.3 — the ONE place that decides the wording of a phone answer. */
export function composeAnswerText(questions: AskUserQuestionInput[], selections: string[][]): string {
  const heading = questions.length === 1 ? HEADING_ONE : HEADING_MANY;
  const lines = questions.map((q, i) => `- ${q.header}: ${(selections[i] ?? []).join(', ')}`);
  return [heading, ...lines].join('\n');
}

/**
 * Inverse of composeAnswerText. Exact-shape only: returns the flat list of
 * matched labels, or undefined for anything else (free text, partial match,
 * unknown label). Labels are matched longest-first so a label containing
 * ", " is not split. Deliberately no heuristics (spec §5.3 accepted degrade).
 */
export function parseAnswerText(questions: AskUserQuestionInput[], text: string): string[] | undefined {
  const lines = text.split('\n');
  const heading = lines[0];
  if (heading !== (questions.length === 1 ? HEADING_ONE : HEADING_MANY)) return undefined;
  if (lines.length !== questions.length + 1) return undefined;
  const out: string[] = [];
  for (const [i, q] of questions.entries()) {
    const line = lines[i + 1] ?? '';
    const prefix = `- ${q.header}: `;
    if (!line.startsWith(prefix)) return undefined;
    let rest = line.slice(prefix.length);
    const labels = q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
    let pickedAny = false;
    while (rest.length > 0) {
      const hit = labels.find((l) => rest === l || rest.startsWith(`${l}, `));
      if (hit === undefined) return undefined;
      out.push(hit);
      pickedAny = true;
      rest = rest.slice(hit.length);
      if (rest.startsWith(', ')) rest = rest.slice(2);
    }
    if (!pickedAny) return undefined;
  }
  return out;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd microviber/daemon && npx vitest run test/ask-user-question.test.ts test/schemas.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Full gate, then commit**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green (nothing consumes the helper yet).

```bash
git add daemon/src/lib/claude-adapter/ask-user-question.ts daemon/src/lib/claude-adapter/schemas.ts daemon/test/ask-user-question.test.ts daemon/test/schemas.test.ts
git commit -m "feat(claude-adapter): shared AskUserQuestion helper — detection, two-clause resolution rule, answer text format

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `tail.ts` and `transcript-meta.ts` consume the helper (rule b lands)

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts` (lines 1–17 type, 42–95 detection, 139–205 `resolveAskUserQuestions`)
- Modify: `daemon/src/lib/claude-adapter/transcript-meta.ts` (imports; user branch ~lines 84–91; assistant branch ~lines 92–125)
- Test: `daemon/test/tail.test.ts`, `daemon/test/transcript-meta.test.ts`

**Interfaces:**
- Consumes: Task 2's `detectAskUserQuestion`, `isResolvingUserEntry`, `parseAnswerText`.
- Produces: `TranscriptEvent` `askUserQuestion` variant gains `resolvedBy?: 'tool_result' | 'text'`. `scanTranscriptMeta(...).pendingQuestion` now also clears on a human text turn. (Task 6 mirrors `resolvedBy` in the PWA.)

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/tail.test.ts` (reuses that file's `userLine`, `assistantToolUseLine`, `toolResultLine`, `askQuestionInput` helpers):

```ts
describe('parseChunk AskUserQuestion resolution — rule (b), human text turn (spec §4.1)', () => {
  const metaLine = (text: string, ts = '2026-08-23T11:00:08.000Z') =>
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const notificationLine = (ts = '2026-08-23T11:00:08.000Z') =>
    JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>x</task-notification>' }, timestamp: ts });
  const find = (events: TranscriptEvent[]) => events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');

  it('a later plain text turn resolves the question by text, KEEPS the user bubble, and highlights labels parsed from the composed format', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      userLine('Answering your question:\n- Confirm: No', '2026-08-23T11:00:20.000Z'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(2); // the human turn stays visible
    const e = find(events);
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('text');
    expect(e?.selectedLabels).toEqual(['No']);
    expect(e?.at).toBe('2026-08-23T11:00:20.000Z');
    expect(events[1]).toMatchObject({ kind: 'user', text: 'Answering your question:\n- Confirm: No' });
  });

  it('free text resolves with no labels', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), userLine('go with the first one')].join('\n') + '\n');
    const e = find(events);
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('text');
    expect(e?.selectedLabels).toBeUndefined();
  });

  it('the isMeta handshake turn and its "No response requested." reply do NOT resolve the question', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      metaLine('Continue from where you left off.'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }], stop_reason: 'end_turn' }, timestamp: '2026-08-23T11:00:09.000Z' }),
    ].join('\n') + '\n';
    const e = find(parseChunk(chunk).events);
    expect(e?.resolved).toBe(false);
  });

  it('a task-notification entry does NOT resolve the question', () => {
    const e = find(parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), notificationLine()].join('\n') + '\n').events);
    expect(e?.resolved).toBe(false);
  });

  it('the tool_result clause still wins and still drops its blank bubble, now tagged resolvedBy tool_result', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), toolResultLine('toolu_1', 'Yes')].join('\n') + '\n');
    expect(events).toHaveLength(1);
    expect(find(events)?.resolvedBy).toBe('tool_result');
  });

  it('a <tool_use_error> tool_result resolves without labels (F18 corollary)', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), toolResultLine('toolu_1', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>')].join('\n') + '\n');
    expect(find(events)?.selectedLabels).toBeUndefined();
  });
});
```

Change the existing test `'a tool_result with non-string content resolves with an empty selectedLabels array …'` (tail.test.ts ~line 173): rename to `'… resolves with selectedLabels undefined (one "no labels" shape, spec §4.1)'` and change its assertion to `expect(e?.selectedLabels).toBeUndefined();`.

Append to `daemon/test/transcript-meta.test.ts` inside `describe('scanTranscriptMeta pendingQuestion', …)`:

```ts
  it('clears pendingQuestion on a later human text turn (rule b)', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('Answering your question:\n- Confirm: Yes', '2026-08-25T10:00:20Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });
  it('clears pendingQuestion on the interruption marker', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('[Request interrupted by user]', '2026-08-25T10:00:20Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });
  it('does NOT clear pendingQuestion on the isMeta handshake turn', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] }, timestamp: '2026-08-25T10:00:11Z' });
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), meta, assistantLine('end_turn', [text('No response requested.')], '2026-08-25T10:00:12Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion?.toolUseId).toBe('toolu_1');
  });
  it('does NOT clear pendingQuestion on a task-notification entry', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), taskNotificationLine()].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion?.toolUseId).toBe('toolu_1');
  });
  it('agrees with tail.ts on a shared fixture set: pendingQuestion === null exactly when tail reports resolved', async () => {
    const { parseChunk } = await import('../src/lib/claude-adapter/tail.js');
    const fixtures = [
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')])],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), toolResultForId('toolu_1')],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('free text', '2026-08-25T10:00:20Z')],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } })],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), taskNotificationLine()],
    ];
    for (const lines of fixtures) {
      const jsonl = lines.join('\n') + '\n';
      const tailResolved = parseChunk(jsonl).events.some((e) => e.kind === 'askUserQuestion' && e.resolved);
      expect(scanTranscriptMeta(jsonl).pendingQuestion === null).toBe(tailResolved);
    }
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/tail.test.ts test/transcript-meta.test.ts`
Expected: the new rule-(b) tests FAIL (`resolved` false / `pendingQuestion` not null); `resolvedBy` undefined; the renamed non-string test fails (`[]` vs `undefined`).

- [ ] **Step 3: Rewrite `tail.ts`'s AskUserQuestion parts to use the helper**

Replace the `askUserQuestion` variant of `TranscriptEvent`:

```ts
  | {
      kind: 'askUserQuestion';
      at: string;
      toolUseId: string;
      resolved: boolean;
      /** Present iff resolved. 'tool_result' = the laptop's answer stub; 'text' = a later human turn (spec §4.1). */
      resolvedBy?: 'tool_result' | 'text';
      selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[];
    };
```

Replace the import line and delete `extractAskUserQuestion` (and its long SYNC comment); in `normalizeLine`'s assistant branch use:

```ts
import { TranscriptLineSchema } from './schemas.js';
import { detectAskUserQuestion, isResolvingUserEntry, parseAnswerText } from './ask-user-question.js';
// …
  // assistant: an AskUserQuestion tool_use gets its own event kind (spec §6,
  // AC12/13) — detection is shared with transcript-meta.ts via
  // ask-user-question.ts, so the two can never drift.
  const detected = detectAskUserQuestion(e.message.content);
  if (detected) {
    return { kind: 'askUserQuestion', at, toolUseId: detected.toolUseId, resolved: false, questions: detected.questions };
  }
```

Replace `resolveAskUserQuestions` entirely:

```ts
/**
 * Cross-line pass (spec §4.1): for each pending askUserQuestion event, the
 * FIRST later user line that isResolvingUserEntry() accepts resolves it —
 * matched by tool_use_id or by being a human turn, never by adjacency (a
 * resumed takeover writes housekeeping lines in between). A tool_result
 * resolution drops its blank bubble; a text resolution keeps the human turn
 * visible because it is a real conversational turn.
 */
function resolveAskUserQuestions(
  withIndex: { event: TranscriptEvent; lineIndex: number }[],
  rawLines: string[],
): TranscriptEvent[] {
  type AskEvent = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
  const pending = withIndex.filter((w): w is { event: AskEvent; lineIndex: number } => w.event.kind === 'askUserQuestion');
  if (pending.length === 0) return withIndex.map((w) => w.event);

  const resolutions = new Map<string, Pick<AskEvent, 'resolvedBy' | 'selectedLabels'> & { at: string | undefined }>();
  const consumedLineIndices = new Set<number>();

  rawLines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { return; }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'user') return;
    for (const p of pending) {
      if (resolutions.has(p.event.toolUseId) || i <= p.lineIndex) continue;
      const r = isResolvingUserEntry(parsed.data, p.event.toolUseId);
      if (!r) continue;
      if (r.by === 'tool_result') {
        resolutions.set(p.event.toolUseId, { resolvedBy: 'tool_result', selectedLabels: r.selectedLabels, at: parsed.data.timestamp });
        consumedLineIndices.add(i);
      } else {
        resolutions.set(p.event.toolUseId, { resolvedBy: 'text', selectedLabels: parseAnswerText(p.event.questions, r.text), at: parsed.data.timestamp });
      }
    }
  });

  if (resolutions.size === 0) return withIndex.map((w) => w.event);

  const out: TranscriptEvent[] = [];
  for (const { event, lineIndex } of withIndex) {
    if (consumedLineIndices.has(lineIndex)) continue;
    if (event.kind === 'askUserQuestion') {
      const r = resolutions.get(event.toolUseId);
      if (r) {
        // `at` becomes the resolution instant (services.ts uses it as observedAt); falls back to ask-time.
        out.push({
          ...event, resolved: true, resolvedBy: r.resolvedBy, at: r.at ?? event.at,
          ...(r.selectedLabels !== undefined ? { selectedLabels: r.selectedLabels } : {}),
        });
        continue;
      }
    }
    out.push(event);
  }
  return out;
}
```

Note the `...(r.selectedLabels !== undefined ? {…} : {})` spread — required by `exactOptionalPropertyTypes` (you cannot assign `undefined` to an optional property).

- [ ] **Step 4: Rewrite `transcript-meta.ts`'s two branches to use the helper**

Change the import line to:

```ts
import { TranscriptLineSchema, type AskUserQuestionInput } from './schemas.js';
import { detectAskUserQuestion, isResolvingUserEntry } from './ask-user-question.js';
```

In the `user` branch, replace the `const content = e.message.content; if (Array.isArray(content)) { … pendingQuestion = null … }` block with:

```ts
      // Spec askuserquestion-answer-mechanism §4.1: the laptop's tool_result
      // OR any later human turn (never the isMeta resume handshake, never a
      // synthetic origin entry) closes the pending question. Shared rule —
      // see ask-user-question.ts.
      if (pendingQuestion && isResolvingUserEntry(e, pendingQuestion.toolUseId)) pendingQuestion = null;
```

In the `assistant` branch, replace the `const content = e.message.content; if (Array.isArray(content)) { /* SYNC … */ for … }` block with:

```ts
      const detected = detectAskUserQuestion(e.message.content);
      if (detected) pendingQuestion = detected;
```

Delete the long `SYNC:` comment. (`detectAskUserQuestion` returns the first block; the old loop kept the last — a two-blocks-in-one-message case the spec §4.2 declares out of scope and the interactive CLI never produces.)

- [ ] **Step 5: Run to verify they pass**

Run: `cd microviber/daemon && npx vitest run test/tail.test.ts test/transcript-meta.test.ts`
Expected: PASS (all, including the pre-existing story-8 tests).

- [ ] **Step 6: Full gate, then commit**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green.

```bash
git add daemon/src/lib/claude-adapter/tail.ts daemon/src/lib/claude-adapter/transcript-meta.ts daemon/test/tail.test.ts daemon/test/transcript-meta.test.ts
git commit -m "feat(claude-adapter): resolve a pending AskUserQuestion on any later human turn, via the shared helper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Remove the tool_result write plumbing; `PromptLifecycle` gains `answerBody` + `findReplay()`

**Files:**
- Modify: `daemon/src/lib/claude-adapter/prompt-sender.ts` (delete `sendAnswer`, `toolResultFrame`)
- Modify: `daemon/src/lib/claude-adapter/session-manager.ts:1-2, 72-85` (delete `sendAnswer` + re-export)
- Modify: `daemon/src/domain/prompt-lifecycle.ts`
- Test: `daemon/test/prompt-lifecycle.test.ts`, `daemon/test/session-manager.test.ts` (remove any `sendAnswer`/`toolResultFrame` tests), `daemon/test/services.test.ts` (temporarily: delete the three `answer-path wiring (Task 7)` tests — Task 5 replaces them)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 5):
  ```ts
  export interface PromptRecord { id; sessionId; text; state; sentAt; observedAt?; answerBody?: string }
  PromptLifecycle.findReplay(args: { key: string; sessionId: string; text?: string; answerBody?: string }): PromptRecord | undefined  // throws ActionError('INVALID_INPUT') on mismatch
  PromptLifecycle.submit(args: { key; sessionId; text; sender; nowMs; answerBody?: string }): Promise<PromptRecord>
  ```
  `PromptSender` is back to `{ mode; send(prompt, signal?) }`.

- [ ] **Step 1: Update the tests first**

In `daemon/test/prompt-lifecycle.test.ts`: remove `sendAnswer` from every sender object (`okSender`, `failSender`, `counting`), delete `answerSender`/`answerFailSender`, delete the test starting `'a key already used by submitAnswer() …'` and the whole `describe('PromptLifecycle answer submission …')` block. Add:

```ts
describe('PromptLifecycle answer records (spec §5.2 step 2 / §5.4)', () => {
  const body = JSON.stringify({ toolUseId: 'toolu_1', selections: [['Yes']] });

  it('submit() stores answerBody atomically with the record', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submit({ key: 'k1', sessionId: 's', text: 'Answering your question:\n- Confirm: Yes', sender: okSender, nowMs: t0, answerBody: body });
    expect(r.answerBody).toBe(body);
    expect(r.state).toBe('queued');
  });

  it('findReplay() returns the record for the same key + same answerBody without any text (a status poll needs no recomposition)', async () => {
    const lc = new PromptLifecycle();
    const a = await lc.submit({ key: 'k1', sessionId: 's', text: 'Answering your question:\n- Confirm: Yes', sender: okSender, nowMs: t0, answerBody: body });
    expect(lc.findReplay({ key: 'k1', sessionId: 's', answerBody: body })).toBe(a);
  });

  it('findReplay() returns undefined for an unknown key', () => {
    expect(new PromptLifecycle().findReplay({ key: 'nope', sessionId: 's', text: 'hi' })).toBeUndefined();
  });

  it('findReplay() rejects a different answerBody under the same key', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'x', sender: okSender, nowMs: t0, answerBody: body });
    expect(() => lc.findReplay({ key: 'k1', sessionId: 's', answerBody: JSON.stringify({ toolUseId: 'toolu_1', selections: [['No']] }) })).toThrowError(/Idempotency-Key/);
  });

  it('kind mismatch is rejected both ways: text replay of an answer key, answer replay of a text key', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'x', sender: okSender, nowMs: t0, answerBody: body });
    expect(() => lc.findReplay({ key: 'k1', sessionId: 's', text: 'x' })).toThrowError(/Idempotency-Key/);
    await lc.submit({ key: 'k2', sessionId: 's', text: 'hello', sender: okSender, nowMs: t0 });
    expect(() => lc.findReplay({ key: 'k2', sessionId: 's', answerBody: body })).toThrowError(/Idempotency-Key/);
  });

  it('a text replay still returns the original record by key + text (unchanged behaviour)', async () => {
    const lc = new PromptLifecycle();
    const a = await lc.submit({ key: 'k2', sessionId: 's', text: 'hello', sender: okSender, nowMs: t0 });
    expect(lc.findReplay({ key: 'k2', sessionId: 's', text: 'hello' })).toBe(a);
  });
});
```

In `daemon/test/session-manager.test.ts`: delete any test that references `sendAnswer` or `toolResultFrame` (grep the file; if none, nothing to do). In `daemon/test/services.test.ts`: delete the `describe('createServices — answer-path wiring (Task 7, spec §6)', …)` block and its explanatory comment header lines 5–14 (keep the `vi.hoisted`/`vi.mock` scaffolding — Task 5 uses it).

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/prompt-lifecycle.test.ts`
Expected: FAIL — `findReplay is not a function`; `answerBody` undefined.

- [ ] **Step 3: Delete the plumbing**

`daemon/src/lib/claude-adapter/prompt-sender.ts` — remove the `sendAnswer` line from `PromptSender` and delete `toolResultFrame` entirely, leaving:

```ts
export interface PromptSender {
  readonly mode: 'readonly' | 'owned';
  send(prompt: string, signal?: AbortSignal): Promise<SendOutcome>;
}

/** A plain stream-json user turn — the documented transport, no wrapper (findings F11). */
export function userFrame(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}
```

`daemon/src/lib/claude-adapter/session-manager.ts` — lines 1–2 become:

```ts
import { type PromptSender, type SendOutcome, userFrame } from './prompt-sender.js';
export { userFrame } from './prompt-sender.js';
```

and delete the whole `async sendAnswer(…) { … }` method from `makeHandle`.

- [ ] **Step 4: Rewrite `PromptLifecycle`**

`daemon/src/domain/prompt-lifecycle.ts` — replace `PromptRecord`, `submit`, and delete `submitAnswer`/`observeAnswer`:

```ts
export interface PromptRecord {
  id: string;         // the Idempotency-Key doubles as the id (spec §5)
  sessionId: string;
  text: string;       // for an answer: the daemon-composed text (ask-user-question.ts composeAnswerText)
  /** Canonical answer body (domain/answer.ts canonicalAnswerBody), set only for answer records — replay matching only (spec §5.2 step 2). */
  answerBody?: string;
  state: PromptStateName;
  sentAt: number;
  observedAt?: string;
}
```

```ts
  /**
   * §16.2 idempotency, shared by submit() and services.sendPrompt's answer
   * path: an existing record for `key` is returned when the request is the
   * same one (same session; same answerBody for an answer; same text for a
   * plain prompt) and rejected otherwise. An answer replay compares ONLY the
   * canonical answerBody — the status poll re-POSTs the same body after the
   * pending question is gone, so recomposing the text is neither possible
   * nor needed. Kind mismatch (text vs answer under one key) is a mismatch.
   */
  findReplay(args: { key: string; sessionId: string; text?: string; answerBody?: string }): PromptRecord | undefined {
    const existing = this.byKey.get(args.key);
    if (!existing) return undefined;
    const sameKind = existing.answerBody === args.answerBody; // both undefined for text; equal strings for the same answer
    const sameText = args.answerBody !== undefined || existing.text === args.text;
    if (existing.sessionId !== args.sessionId || !sameKind || !sameText) {
      throw new ActionError('INVALID_INPUT', 'Idempotency-Key reused with a different prompt');
    }
    return existing;
  }

  async submit(args: {
    key: string;
    sessionId: string;
    text: string;
    sender: PromptSender;
    nowMs: number;
    answerBody?: string;
  }): Promise<PromptRecord> {
    const replay = this.findReplay({ key: args.key, sessionId: args.sessionId, text: args.text, ...(args.answerBody !== undefined ? { answerBody: args.answerBody } : {}) });
    if (replay) return replay;

    const rec: PromptRecord = {
      id: args.key,
      sessionId: args.sessionId,
      text: args.text,
      ...(args.answerBody !== undefined ? { answerBody: args.answerBody } : {}),
      state: 'sending',
      sentAt: args.nowMs,
    };
    this.byKey.set(args.key, rec);

    const outcome = await args.sender.send(args.text);
    rec.state = outcome.ok ? 'queued' : 'failed';
    return rec;
  }
```

Keep `get`, `observe`, `sweepExpired` unchanged.

- [ ] **Step 5: Fix compile errors in `services.ts` minimally (Task 5 rewrites it)**

In `daemon/src/services/services.ts`: delete the `if (e.kind === 'askUserQuestion' && e.resolved) { lifecycle.observeAnswer(…) }` block in `getTranscript`, and change `sendPrompt`'s record line to `const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.text, sender, nowMs: Date.now() });`. Leave `a.toolUseId` in `AppDeps`/`app.ts` for now (Task 5 removes it); typecheck will still pass because the field is optional and now unused.

- [ ] **Step 6: Run to verify they pass, then full gate**

Run: `cd microviber/daemon && npx vitest run test/prompt-lifecycle.test.ts test/session-manager.test.ts test/services.test.ts`
Expected: PASS.
Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green (app.test.ts's two `toolUseId` tests still pass — the field is still threaded, just unused).

- [ ] **Step 7: Commit**

```bash
git add daemon/src daemon/test
git commit -m "refactor(daemon): remove the F16 tool_result write path; PromptLifecycle gains answerBody + findReplay for answer replays

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: API body union, answer validation, composition, audit (daemon end-to-end)

**Files:**
- Modify: `daemon/src/schemas/api.ts:33-37`
- Create: `daemon/src/domain/answer.ts`
- Modify: `daemon/src/services/services.ts` (`sendPrompt`)
- Modify: `daemon/src/api/app.ts:21` (`AppDeps.sendPrompt`), `:407-421` (route)
- Test: `daemon/test/answer.test.ts` (new), `daemon/test/services.test.ts`, `daemon/test/app.test.ts`

**Interfaces:**
- Consumes: Task 2 `composeAnswerText`, `ANSWER_TEXT_MAX_CHARS`; Task 4 `findReplay`, `submit({answerBody})`; `scanTranscriptMeta` + `readTranscriptText` (existing adapter exports).
- Produces (used by Task 6/7's PWA client):
  ```ts
  // schemas/api.ts
  export const AnswerBody = z.object({ toolUseId: z.string().min(1).max(200), selections: z.array(z.array(z.string().min(1).max(500)).max(20)).min(1).max(4) });
  export type AnswerBody = z.infer<typeof AnswerBody>;
  export const SendPromptBody = z.union([ z.object({ text: z.string().min(1).max(20000) }), z.object({ answer: AnswerBody }) ]);
  export type SendPromptBody = z.infer<typeof SendPromptBody>;
  // domain/answer.ts
  export function canonicalAnswerBody(a: AnswerBody): string;
  export function validateAnswer(pending: { toolUseId: string; questions: AskUserQuestionInput[] } | null, a: AnswerBody): { ok: true } | { ok: false; message: string };
  // api/app.ts
  sendPrompt(a: { sessionId: string; key: string; body: SendPromptBody; requestId: string; clientId: string }): Promise<PromptRecord>;
  ```
  Wire: `POST /api/sessions/:id/prompt` with `{ "answer": { "toolUseId": "…", "selections": [["Yes"]] } }` → `PromptStatus` envelope; 400 `INVALID_INPUT` with the §5.2 messages.

- [ ] **Step 1: Write the failing tests**

`daemon/test/answer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalAnswerBody, validateAnswer } from '../src/domain/answer.js';

const pending = {
  toolUseId: 'toolu_1',
  questions: [
    { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false },
    { question: 'Which?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }], multiSelect: true },
  ],
};

describe('canonicalAnswerBody', () => {
  it('is a stable JSON of toolUseId + selections in submitted order', () => {
    expect(canonicalAnswerBody({ toolUseId: 't', selections: [['A'], ['B', 'C']] })).toBe('{"toolUseId":"t","selections":[["A"],["B","C"]]}');
  });
});

describe('validateAnswer (spec §5.2)', () => {
  it('accepts a complete, in-options answer', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes'], ['Frontend', 'Backend']] })).toEqual({ ok: true });
  });
  it('rejects when nothing is pending', () => {
    expect(validateAnswer(null, { toolUseId: 'toolu_1', selections: [['Yes'], ['Frontend']] })).toEqual({ ok: false, message: 'question is no longer pending' });
  });
  it('rejects a toolUseId that is not the pending one', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_OLD', selections: [['Yes'], ['Frontend']] })).toEqual({ ok: false, message: 'question is no longer pending' });
  });
  it('rejects a selections length that does not cover every question, and an empty per-question list', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes']] })).toEqual({ ok: false, message: 'answer must cover every question' });
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes'], []] })).toEqual({ ok: false, message: 'answer must cover every question' });
  });
  it('rejects several labels for a single-select question', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes', 'No'], ['Frontend']] })).toEqual({ ok: false, message: 'question Confirm accepts one option' });
  });
  it('rejects a label that is not one of that question\'s options (exact match)', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['yes'], ['Frontend']] })).toEqual({ ok: false, message: 'unknown option for Confirm' });
  });
});
```

Append to `daemon/test/services.test.ts` (uses the file's existing `state`, `config`, mocks):

```ts
const pendingTranscript = JSON.stringify({
  type: 'assistant', timestamp: '2026-09-03T12:00:00Z',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } }] },
}) + '\n';
const answer = { toolUseId: 'toolu_2', selections: [['No']] };

describe('createServices — answer path (spec §5)', () => {
  beforeEach(() => { state.transcriptText = pendingTranscript; state.writes = []; });

  it('composes the answer text and sends it as a PLAIN user turn, never a tool_result frame', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k1', body: { answer }, requestId: 'r1', clientId: 'phone' });
    expect(rec.state).toBe('queued');
    expect(rec.text).toBe('Answering your question:\n- Confirm: No');
    expect(rec.answerBody).toBe(JSON.stringify(answer));
    const wire = state.writes.join('');
    expect(wire).toContain('"type":"text"');
    expect(wire).toContain('Answering your question:');
    expect(wire).not.toContain('tool_result');
  });

  it('becomes accepted when getTranscript observes the composed text as a user turn', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k2', body: { answer }, requestId: 'r2', clientId: 'phone' });
    state.transcriptText = pendingTranscript + JSON.stringify({ type: 'user', timestamp: '2026-09-03T12:00:30Z', message: { role: 'user', content: [{ type: 'text', text: 'Answering your question:\n- Confirm: No' }] } }) + '\n';
    services.getTranscript('sess-1', undefined);
    expect(rec.state).toBe('accepted');
  });

  it('REGRESSION (review round 1): a same-key replay after the answer landed returns the original record instead of 400 "no longer pending"', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const first = await services.sendPrompt({ sessionId: 'sess-1', key: 'k3', body: { answer }, requestId: 'r3', clientId: 'phone' });
    state.transcriptText = pendingTranscript + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Answering your question:\n- Confirm: No' }] } }) + '\n';
    const replay = await services.sendPrompt({ sessionId: 'sess-1', key: 'k3', body: { answer }, requestId: 'r3b', clientId: 'phone' });
    expect(replay).toBe(first);
    expect(state.writes).toHaveLength(1);
  });

  it('a same-key replay with a different answer is rejected INVALID_INPUT', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    await services.sendPrompt({ sessionId: 'sess-1', key: 'k4', body: { answer }, requestId: 'r4', clientId: 'phone' });
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k4', body: { answer: { toolUseId: 'toolu_2', selections: [['Yes']] } }, requestId: 'r4b', clientId: 'phone' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['no pending question', '', 'question is no longer pending'],
    ['stale toolUseId', pendingTranscript, 'question is no longer pending'],
  ])('rejects INVALID_INPUT (%s), writes nothing, and audits the rejection with the canonical body', async (_name, transcript, message) => {
    state.transcriptText = transcript;
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l));
    await services.takeover('sess-1');
    const body = transcript ? { toolUseId: 'toolu_STALE', selections: [['No']] } : answer;
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k5', body: { answer: body }, requestId: 'r5', clientId: 'phone' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message });
    expect(state.writes).toHaveLength(0);
    const rejected = lines.map((l) => JSON.parse(l) as { outcome: string; promptHash: string }).find((e) => e.outcome === 'rejected');
    expect(rejected).toBeDefined();
    const { createHash } = await import('node:crypto');
    expect(rejected?.promptHash).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    // and a retry under the same key is evaluated afresh (no record was persisted)
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k5', body: { answer: body }, requestId: 'r5b', clientId: 'phone' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an unknown label and a wrong selections count before any write', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k6', body: { answer: { toolUseId: 'toolu_2', selections: [['Maybe']] } }, requestId: 'r6', clientId: 'phone' })).rejects.toMatchObject({ message: 'unknown option for Confirm' });
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k7', body: { answer: { toolUseId: 'toolu_2', selections: [['No'], ['No']] } }, requestId: 'r7', clientId: 'phone' })).rejects.toMatchObject({ message: 'answer must cover every question' });
    expect(state.writes).toHaveLength(0);
  });

  it('an answer to a not-taken-over session is 403 FORBIDDEN, audited readonly/rejected, no record', async () => {
    const lines: string[] = [];
    const services = createServices(config, (l) => lines.push(l));
    await expect(services.sendPrompt({ sessionId: 'sess-1', key: 'k8', body: { answer }, requestId: 'r8', clientId: 'phone' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'readonly', outcome: 'rejected' });
  });

  it('plain text prompts are unchanged', async () => {
    const services = createServices(config, () => {});
    await services.takeover('sess-1');
    const rec = await services.sendPrompt({ sessionId: 'sess-1', key: 'k9', body: { text: 'hello' }, requestId: 'r9', clientId: 'phone' });
    expect(rec.text).toBe('hello');
    expect(rec.answerBody).toBeUndefined();
    expect(state.writes.join('')).toContain('"text":"hello"');
  });
});
```

In `daemon/test/app.test.ts`: delete the two tests `'prompt with an optional toolUseId in the body threads it through …'` and `'prompt with no toolUseId in the body threads undefined through …'`; update every `sendPrompt: async (a) => …` fake in the file's `deps()` helper to read `a.body` (e.g. `text: 'text' in a.body ? a.body.text : 'answer'`); add:

```ts
  it('prompt accepts an {answer} body and passes it through to deps.sendPrompt as body.answer', async () => {
    let captured: unknown;
    const r = await buildApp(deps({
      sendPrompt: async (a) => { captured = a.body; return { id: a.key, sessionId: a.sessionId, text: 'Answering your question:\n- Confirm: Yes', answerBody: JSON.stringify('answer' in a.body ? a.body.answer : null), state: 'queued', sentAt: 0 }; },
    })).inject({
      method: 'POST', url: '/api/sessions/a/prompt',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-ans' },
      payload: { answer: { toolUseId: 'toolu_1', selections: [['Yes']] } },
    });
    expect(r.statusCode).toBe(200);
    expect(captured).toEqual({ answer: { toolUseId: 'toolu_1', selections: [['Yes']] } });
  });

  it('prompt rejects a body that is neither {text} nor {answer}, and one that mixes both', async () => {
    for (const payload of [{ toolUseId: 'x' }, { text: 'hi', answer: { toolUseId: 't', selections: [['a']] } }, { answer: { toolUseId: 't', selections: [] } }]) {
      const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/sessions/a/prompt', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-bad' }, payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_INPUT');
    }
  });
```

(For the "mixes both" case to be rejected, the union members must be `.strict()` — see Step 3.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/daemon && npx vitest run test/answer.test.ts test/services.test.ts test/app.test.ts`
Expected: FAIL — missing module `domain/answer.js`; `body` is not a property of the sendPrompt args (typecheck) / route ignores `answer`.

- [ ] **Step 3: Schema**

`daemon/src/schemas/api.ts` — replace `SendPromptBody`:

```ts
/** An answer to the currently pending AskUserQuestion (spec askuserquestion-answer-mechanism §5.1). selections[i] = labels chosen for question i. */
export const AnswerBody = z.object({
  toolUseId: z.string().min(1).max(200),
  selections: z.array(z.array(z.string().min(1).max(500)).max(20)).min(1).max(4),
}).strict();
export type AnswerBody = z.infer<typeof AnswerBody>;

/** POST /api/sessions/:id/prompt — a plain user turn OR an answer; exactly one. */
export const SendPromptBody = z.union([
  z.object({ text: z.string().min(1).max(20000) }).strict(),
  z.object({ answer: AnswerBody }).strict(),
]);
export type SendPromptBody = z.infer<typeof SendPromptBody>;
```

- [ ] **Step 4: Domain validation**

`daemon/src/domain/answer.ts`:

```ts
import type { AnswerBody } from '../schemas/api.js';
import type { AskUserQuestionInput } from '../lib/claude-adapter/schemas.js';

export interface PendingQuestion { toolUseId: string; questions: AskUserQuestionInput[] }

/** Stable serialization used for replay matching and for auditing pre-composition rejections (spec §5.2). */
export function canonicalAnswerBody(a: AnswerBody): string {
  return JSON.stringify({ toolUseId: a.toolUseId, selections: a.selections });
}

/**
 * Spec §5.2 checks, in order. Pure — no I/O. Labels are model-authored
 * transcript content about to be echoed back into the session; exact
 * matching against the pending question's own options is what keeps this
 * from being an arbitrary-text write path (T11 note).
 */
export function validateAnswer(pending: PendingQuestion | null, a: AnswerBody): { ok: true } | { ok: false; message: string } {
  if (!pending || pending.toolUseId !== a.toolUseId) return { ok: false, message: 'question is no longer pending' };
  if (a.selections.length !== pending.questions.length) return { ok: false, message: 'answer must cover every question' };
  for (const [i, q] of pending.questions.entries()) {
    const picked = a.selections[i] ?? [];
    if (picked.length === 0) return { ok: false, message: 'answer must cover every question' };
    if (picked.length > 1 && q.multiSelect !== true) return { ok: false, message: `question ${q.header} accepts one option` };
    const allowed = new Set(q.options.map((o) => o.label));
    if (picked.some((label) => !allowed.has(label))) return { ok: false, message: `unknown option for ${q.header}` };
  }
  return { ok: true };
}
```

- [ ] **Step 5: Services**

`daemon/src/services/services.ts` — add imports:

```ts
import { scanTranscriptMeta } from '../lib/claude-adapter/transcript-meta.js';
import { composeAnswerText, ANSWER_TEXT_MAX_CHARS } from '../lib/claude-adapter/ask-user-question.js';
import { canonicalAnswerBody, validateAnswer } from '../domain/answer.js';
```

Replace `sendPrompt` with:

```ts
    async sendPrompt(a) {
      const at = () => new Date().toISOString();
      // The audited "prompt" is the text for a plain prompt, and the
      // canonical body for an answer until it is composed (spec §5.2).
      const auditPrompt = 'text' in a.body ? a.body.text : canonicalAnswerBody(a.body.answer);
      // spec §3.2 hard rule: write-eligible only while an owned handle exists.
      // Reject BEFORE any PromptRecord exists so a retry re-checks ownership.
      const sender = registry.get(a.sessionId);
      if (!sender) {
        audit.record({ sessionId: a.sessionId, mode: 'readonly', clientId: a.clientId, prompt: auditPrompt, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error('session is read-only until taken over'), { code: 'FORBIDDEN' });
      }

      if ('text' in a.body) {
        const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.body.text, sender, nowMs: Date.now() });
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.body.text, outcome: rec.state, requestId: a.requestId, at: at() });
        return rec;
      }

      // Answer path (spec §5.2 order): 2. same-key replay BEFORE any
      // transcript access — the PWA's status poll re-POSTs this exact body
      // after the pending question is already gone.
      const answerBody = canonicalAnswerBody(a.body.answer);
      const replay = lifecycle.findReplay({ key: a.key, sessionId: a.sessionId, answerBody });
      if (replay) return replay;

      // 3. New key: re-derive the pending question from the live transcript,
      // validate, compose, submit. Rejections persist no record but are audited.
      const cwd = cwdById.get(a.sessionId) ?? (listSessions(), cwdById.get(a.sessionId));
      const transcript = cwd ? readTranscriptText(cwd, a.sessionId) : null;
      const pending = transcript === null ? null : scanTranscriptMeta(transcript).pendingQuestion;
      const verdict = validateAnswer(pending, a.body.answer);
      if (!verdict.ok || !pending) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error(verdict.ok ? 'question is no longer pending' : verdict.message), { code: 'INVALID_INPUT' });
      }
      const text = composeAnswerText(pending.questions, a.body.answer.selections);
      if (text.length > ANSWER_TEXT_MAX_CHARS) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error('answer too long'), { code: 'INVALID_INPUT' });
      }
      const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text, sender, nowMs: Date.now(), answerBody });
      audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: text, outcome: rec.state, requestId: a.requestId, at: at() });
      return rec;
    },
```

`lifecycle.findReplay` throws `ActionError('INVALID_INPUT', …)` on mismatch — it already carries `code: 'INVALID_INPUT'`, which the route maps to 400.

- [ ] **Step 6: API**

`daemon/src/api/app.ts` — change the import to include the type: `import { WebpaneTokenBody, SendPromptBody, errorEnvelope, HTTP_STATUS, type ErrorCode } from '../schemas/api.js';` and `AppDeps.sendPrompt` to:

```ts
  sendPrompt(a: { sessionId: string; key: string; body: SendPromptBody; requestId: string; clientId: string }): Promise<PromptRecord>;
```

In the route, replace the `deps.sendPrompt({ … })` call with:

```ts
      const rec = await deps.sendPrompt({ sessionId: id, key, body: parsed.data, requestId, clientId: 'phone' });
```

- [ ] **Step 7: Run to verify they pass, then full gate**

Run: `cd microviber/daemon && npx vitest run test/answer.test.ts test/services.test.ts test/app.test.ts`
Expected: PASS.
Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green. (If `security.test.ts` or `ws-hub.test.ts` build `deps()` with a `sendPrompt` fake reading `a.text`, update them to `a.body` the same way.)

- [ ] **Step 8: Commit**

```bash
git add daemon/src daemon/test
git commit -m "feat(daemon): accept {answer} on POST /prompt — validate against the pending question, compose, send as plain text

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: PWA — types, `postAnswer`, and the `AskUserQuestionCard`

**Files:**
- Modify: `pwa/src/lib/types.ts:23-33`
- Modify: `pwa/src/lib/api.ts:27-36`
- Create: `pwa/src/components/AskUserQuestionCard.tsx`
- Modify: `pwa/src/components/Transcript.tsx` (props; `askUserQuestion` case delegates)
- Test: `pwa/test/ask-user-question-card.test.tsx` (new), `pwa/test/transcript-askuserquestion.test.tsx`, `pwa/test/api.test.ts`

**Interfaces:**
- Consumes: Task 5's wire shape.
- Produces (used by Task 7):
  ```ts
  // types.ts
  askUserQuestion event: + resolvedBy?: 'tool_result' | 'text'
  PromptRecord: - toolUseId, + answerBody?: string
  // api.ts
  postAnswer(id: string, toolUseId: string, selections: string[][], idemKey: string): Promise<PromptRecord>
  sendPrompt(id: string, text: string, idemKey: string): Promise<PromptRecord>   // toolUseId param removed
  // AskUserQuestionCard.tsx
  export interface AnswerInFlight { toolUseId: string; status: PromptState; selections: string[][] }
  export function AskUserQuestionCard(props: { e: AskEvent; canAnswer: boolean; inFlight: AnswerInFlight | null; onAnswer?: (toolUseId: string, selections: string[][]) => void }): ReactElement
  // Transcript.tsx
  <Transcript events sessionId sessionCwd canAnswer={boolean} answerInFlight={AnswerInFlight | null} onAnswer={(toolUseId, selections) => void} />
  ```

- [ ] **Step 1: Write the failing tests**

`pwa/test/ask-user-question-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AskUserQuestionCard } from '../src/components/AskUserQuestionCard.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);
type Ask = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
const one: Ask = { kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };
const two: Ask = { ...one, questions: [...one.questions, { question: 'Which?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }], multiSelect: true }] };

describe('AskUserQuestionCard (spec §7.1)', () => {
  it('not taken over: options are inert, no Send button', () => {
    render(<AskUserQuestionCard e={one} canAnswer={false} inFlight={null} />);
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('taken over: chips are selectable, Send answers is disabled until every question has a pick, then submits selections in question order', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={two} canAnswer inFlight={null} onAnswer={onAnswer} />);
    const send = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Frontend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Backend' })); // multiSelect: both stay
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No'], ['Frontend', 'Backend']]);
  });

  it('single-select: picking a second option replaces the first', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
    expect(screen.getByRole('button', { name: 'Yes' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the free-text hint while answerable', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByText('or type a reply below')).toBeInTheDocument();
  });

  it('in flight: chips lock, status text shows, Send is gone', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'queued', selections: [['No']] }} onAnswer={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText(/waiting for the session to finish/i)).toBeInTheDocument();
  });

  it('failed: keeps the selections highlighted and offers Retry, which re-submits the same selections', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'failed', selections: [['No']] }} onAnswer={onAnswer} />);
    expect(screen.getByText('No').className).toMatch(/amber/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
  });

  it('an in-flight answer for a DIFFERENT question does not lock this card', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 'other', status: 'queued', selections: [['x']] }} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
  });

  it('resolved with labels: dimmed, selected highlighted, nothing interactive even when answerable', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text', selectedLabels: ['Yes'] }} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Yes').className).toMatch(/amber/);
  });

  it('resolved without labels: neutral "no longer pending" caption', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text' }} canAnswer inFlight={null} />);
    expect(screen.getByText('no longer pending')).toBeInTheDocument();
    expect(screen.queryByText('or type a reply below')).toBeNull();
  });
});
```

Update `pwa/test/transcript-askuserquestion.test.tsx`: delete the two tests that pass `onAnswerQuestion` (`'a resolved question renders its options as inert … even if onAnswerQuestion is provided'` and `'a pending question renders clickable options when onAnswerQuestion is provided …'`) and replace with:

```tsx
  it('delegates to AskUserQuestionCard: canAnswer + onAnswer make a pending question interactive and Send answers submits', () => {
    const onAnswer = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={onAnswer} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
  });
```
and update the remaining tests' `<Transcript …>` renders to pass `canAnswer={false} answerInFlight={null}` (the inert cases).

In `pwa/test/api.test.ts` add (mirroring the file's existing fetch-mock style for `sendPrompt`):

```ts
  it('postAnswer POSTs {answer:{toolUseId,selections}} with the idempotency key and bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'k', sessionId: 's', text: 'x', state: 'queued', sentAt: 0 } }) });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('http://d', 'tok');
    await api.postAnswer('s', 't1', [['Yes']], 'k');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://d/api/sessions/s/prompt');
    expect(JSON.parse(String(init.body))).toEqual({ answer: { toolUseId: 't1', selections: [['Yes']] } });
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('k');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/pwa && npx vitest run test/ask-user-question-card.test.tsx test/transcript-askuserquestion.test.tsx test/api.test.ts`
Expected: FAIL — module not found; `postAnswer` not a function; Transcript prop types.

- [ ] **Step 3: Types and API client**

`pwa/src/lib/types.ts` — the `askUserQuestion` variant becomes:

```ts
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean;
      /** SYNC daemon tail.ts: present iff resolved — 'tool_result' (laptop stub) | 'text' (later human turn). */
      resolvedBy?: 'tool_result' | 'text';
      selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean }[] };
```

and `PromptRecord`:

```ts
export interface PromptRecord {
  id: string; sessionId: string; text: string; answerBody?: string; state: PromptStateName; sentAt: number; observedAt?: string;
}
```

`pwa/src/lib/api.ts` — `sendPrompt` loses its `toolUseId` parameter and body spread (`body: JSON.stringify({ text })`); add after it:

```ts
    /** Answer the pending AskUserQuestion (spec askuserquestion-answer-mechanism §5.1). Same route, same key semantics as sendPrompt. */
    postAnswer: async (id: string, toolUseId: string, selections: string[][], idemKey: string): Promise<PromptRecord> => {
      const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify({ answer: { toolUseId, selections } }),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
      return body.data as PromptRecord;
    },
```

- [ ] **Step 4: The card**

`pwa/src/components/AskUserQuestionCard.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { promptDisplay, type PromptState } from '../lib/prompt-display.js';

type AskEvent = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;

/** The one answer the app currently has in flight, if any (App.tsx's shared prompt slot, kind 'answer'). */
export interface AnswerInFlight { toolUseId: string; status: PromptState; selections: string[][] }

const CHIP = 'rounded-full border px-3 py-1 text-[13px]';
const CHIP_ON = 'border-amber-400 bg-amber-400/10 text-amber-300 font-semibold';
const CHIP_OFF = 'border-zinc-600 text-zinc-300';

/**
 * Spec askuserquestion-answer-mechanism §7.1. Pick per question (radio, or
 * checkbox when multiSelect), one "Send answers" button once every question
 * has a pick; the composer stays the free-text path. Interactive only for a
 * pending question on a taken-over session (canAnswer) with a handler.
 */
export function AskUserQuestionCard({ e, canAnswer, inFlight, onAnswer }: {
  e: AskEvent;
  canAnswer: boolean;
  inFlight: AnswerInFlight | null;
  onAnswer?: ((toolUseId: string, selections: string[][]) => void) | undefined;
}): ReactElement {
  const [picks, setPicks] = useState<string[][]>(() => e.questions.map(() => []));
  const mine = inFlight && inFlight.toolUseId === e.toolUseId ? inFlight : null;
  const interactive = !e.resolved && canAnswer && !!onAnswer && !mine;
  const shown = mine ? mine.selections : picks; // while in flight, show what was sent
  const complete = picks.every((p) => p.length > 0);
  const disp = mine ? promptDisplay(mine.status) : null;

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicks((prev) => prev.map((p, i) => {
      if (i !== qi) return p;
      if (!multi) return [label];
      return p.includes(label) ? p.filter((l) => l !== label) : [...p, label];
    }));
  };

  const isOn = (qi: number, label: string): boolean =>
    e.resolved ? !!e.selectedLabels?.includes(label) : !!shown[qi]?.includes(label);

  return (
    <div className={`rounded-lg border border-fuchsia-700/50 bg-fuchsia-500/5 p-3 ${e.resolved ? 'opacity-80' : ''}`}>
      {e.questions.map((q, qi) => (
        <div key={qi} className="mb-2 last:mb-0">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-fuchsia-400">{q.header}</div>
          <div className="mb-2 text-[15px] text-zinc-100">{q.question}</div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o, oi) => {
              const on = isOn(qi, o.label);
              const cls = `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;
              return interactive ? (
                <button key={`${qi}-${oi}`} type="button" aria-pressed={on} onClick={() => toggle(qi, o.label, q.multiSelect === true)} className={cls}>{o.label}</button>
              ) : (
                <span key={`${qi}-${oi}`} className={cls}>{o.label}{on && <span className="sr-only"> (selected)</span>}</span>
              );
            })}
          </div>
        </div>
      ))}
      {e.resolved && e.selectedLabels === undefined && (
        <div className="mt-2 text-[12px] text-zinc-500">no longer pending</div>
      )}
      {interactive && onAnswer && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-zinc-500">or type a reply below</span>
          <button type="button" disabled={!complete} onClick={() => onAnswer(e.toolUseId, picks)}
            className="rounded-lg bg-amber-400 px-3 py-1.5 text-[13px] font-semibold text-amber-950 disabled:opacity-50">
            Send answers
          </button>
        </div>
      )}
      {mine && disp && (
        <div className={`mt-3 flex items-center gap-2 text-[12.5px] ${disp.tone === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
          {disp.message || 'Sent'}
          {disp.showResend && onAnswer && (
            <button type="button" onClick={() => onAnswer(e.toolUseId, mine.selections)} className="ml-auto font-bold underline">Retry</button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Transcript delegates**

`pwa/src/components/Transcript.tsx` — import the card: `import { AskUserQuestionCard, type AnswerInFlight } from './AskUserQuestionCard.js';`. Change the `Transcript` props to:

```tsx
export function Transcript({ events, sessionId, sessionCwd, canAnswer, answerInFlight, onAnswer }: {
  events: TranscriptEvent[]; sessionId: string | null; sessionCwd: string;
  /** True only when the session is taken over (mode === 'owned') — the card never decides ownership itself. */
  canAnswer: boolean;
  answerInFlight: AnswerInFlight | null;
  onAnswer?: ((toolUseId: string, selections: string[][]) => void) | undefined;
}): ReactElement {
```

pass them to `EventRow` (`<EventRow key={i} e={e} sessionCwd={sessionCwd} canAnswer={canAnswer} answerInFlight={answerInFlight} onAnswer={onAnswer} />`), update `EventRow`'s props type accordingly, and replace the entire `case 'askUserQuestion': { … }` body with:

```tsx
    case 'askUserQuestion':
      return <AskUserQuestionCard e={e} canAnswer={canAnswer} inFlight={answerInFlight} onAnswer={onAnswer} />;
```

Remove the now-unused `onAnswerQuestion` prop and the story-8 comment about it.

- [ ] **Step 6: Run to verify they pass**

Run: `cd microviber/pwa && npx vitest run test/ask-user-question-card.test.tsx test/transcript-askuserquestion.test.tsx test/api.test.ts`
Expected: PASS. (`App.tsx` will fail typecheck until Task 7 — run only these vitest files now; do NOT run the full gate yet.)

- [ ] **Step 7: Commit (PWA typecheck intentionally deferred to Task 7 — note it in the message)**

```bash
git add pwa/src/lib/types.ts pwa/src/lib/api.ts pwa/src/components/AskUserQuestionCard.tsx pwa/src/components/Transcript.tsx pwa/test/ask-user-question-card.test.tsx pwa/test/transcript-askuserquestion.test.tsx pwa/test/api.test.ts
git commit -m "feat(pwa): AskUserQuestionCard with selectable chips + Send answers; postAnswer client (App wiring follows)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: PWA — App wiring (shared in-flight slot by kind, `sendAnswer`, poll, Retry with a fresh key)

**Files:**
- Modify: `pwa/src/App.tsx` (`pendingPrompt` state ~line 37; poll effect ~86–103; `send` ~143–158; `<Transcript …>`/`<Composer …>` ~228–233)
- Test: `pwa/test/app-answer.test.tsx` (new)

**Interfaces:**
- Consumes: Task 6's `postAnswer`, `AnswerInFlight`, Transcript props.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

`pwa/test/app-answer.test.tsx` (same mock scaffolding as `composer-gate.test.tsx`):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { SessionSummary, TranscriptEvent } from '../src/lib/types.js';

const mockApi = { listSessions: vi.fn(), getTranscript: vi.fn(), sendPrompt: vi.fn(), postAnswer: vi.fn(), takeover: vi.fn(), handback: vi.fn(), openStream: vi.fn() };
vi.mock('../src/lib/api.js', () => ({ createApi: () => mockApi }));
vi.mock('../src/lib/auth.js', () => ({ captureTokenFromUrl: () => 'test-token' }));
const { App } = await import('../src/App.js');

const owned: SessionSummary = { id: 's1', title: 'T', folder: 'p', cwd: '/p', host: 'vscode', writable: true, state: 'awaiting-input', lastActivityAt: null, lastPrompt: null, lastPromptAt: null, mode: 'owned', takenOver: true, devServerPorts: [] };
const pending: TranscriptEvent = { kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };

describe('App — answering a pending AskUserQuestion (spec §7)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
    vi.clearAllMocks();
    mockApi.listSessions.mockResolvedValue([owned]);
    mockApi.getTranscript.mockResolvedValue({ events: [pending], nextCursor: null });
  });
  afterEach(cleanup);

  it('tapping an option then Send answers calls postAnswer with the toolUseId, selections, and a fresh key; the card shows the queued state', async () => {
    mockApi.postAnswer.mockResolvedValue({ id: 'k', sessionId: 's1', text: 'x', state: 'queued', sentAt: 0 });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(mockApi.postAnswer).toHaveBeenCalledTimes(1));
    const [id, toolUseId, selections, key] = mockApi.postAnswer.mock.calls[0] as [string, string, string[][], string];
    expect([id, toolUseId, selections]).toEqual(['s1', 't1', [['No']]]);
    expect(key).toMatch(/[0-9a-f-]{36}/);
    await screen.findByText(/waiting for the session to finish/i);
    // the composer still shows no status for a text prompt
    expect(screen.getByPlaceholderText(/message this session/i)).toBeInTheDocument();
  });

  it('a failed answer offers Retry, and Retry re-posts the same selections under a NEW key', async () => {
    mockApi.postAnswer.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: 'k2', sessionId: 's1', text: 'x', state: 'queued', sentAt: 0 });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockApi.postAnswer).toHaveBeenCalledTimes(2));
    const k1 = (mockApi.postAnswer.mock.calls[0] as string[])[3];
    const k2 = (mockApi.postAnswer.mock.calls[1] as string[])[3];
    expect(k1).not.toBe(k2);
    expect((mockApi.postAnswer.mock.calls[1] as unknown[])[2]).toEqual([['No']]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd microviber/pwa && npx vitest run test/app-answer.test.tsx`
Expected: FAIL — no `Send answers` button (App still passes no `canAnswer`), typecheck errors on Transcript props.

- [ ] **Step 3: Wire App.tsx**

Replace the `pendingPrompt` state declaration with:

```tsx
  // The ONE prompt awaiting its queued -> accepted transition (spec §7.1: a
  // shared slot). kind tells the composer and the question card which of
  // them owns the current `status`; toolUseId lets a card recognise its own
  // answer. Tracked as state so the recheck below runs as long as the
  // record can legitimately stay 'queued' server-side (up to 10 minutes).
  type InFlight =
    | { kind: 'text'; sessionId: string; text: string; key: string }
    | { kind: 'answer'; sessionId: string; toolUseId: string; selections: string[][]; key: string };
  const [pendingPrompt, setPendingPrompt] = useState<InFlight | null>(null);
  // Which kind `status` currently describes — set by send()/sendAnswer(), kept after pendingPrompt clears so failed/expired keep showing.
  const [statusKind, setStatusKind] = useState<{ kind: 'text' } | { kind: 'answer'; toolUseId: string; selections: string[][] } | null>(null);
```

In the poll effect, replace the `api.sendPrompt(pendingPrompt.sessionId, pendingPrompt.text, pendingPrompt.key)` call with:

```tsx
      // Same idempotency-key + same body returns the current record instead
      // of resubmitting (for an answer, the daemon matches on the canonical
      // body — spec §5.2 step 2 — so this is safe after the question resolves).
      const replay = pendingPrompt.kind === 'text'
        ? api.sendPrompt(pendingPrompt.sessionId, pendingPrompt.text, pendingPrompt.key)
        : api.postAnswer(pendingPrompt.sessionId, pendingPrompt.toolUseId, pendingPrompt.selections, pendingPrompt.key);
      void replay
```

(keep the existing `.then(…)`/`.catch(…)` chain on it unchanged).

Replace `send` with:

```tsx
  const send = async (text: string) => {
    if (!api || !selected) return;
    const sessionId = selected;
    const key = crypto.randomUUID();
    setStatusKind({ kind: 'text' });
    setStatus('sending');
    let rec;
    try {
      rec = await api.sendPrompt(sessionId, text, key);
    } catch {
      if (selectedRef.current === sessionId) setStatus('failed');
      return;
    }
    if (selectedRef.current === sessionId) setStatus(rec.state as PromptState);
    if (rec.state === 'queued') setPendingPrompt({ kind: 'text', sessionId, text, key });
  };

  // Spec §7.1: one composed answer per Send answers tap. Retry calls this
  // again with the same selections — always a FRESH key (replaying a failed
  // record's key would return the failed record forever).
  const sendAnswer = async (toolUseId: string, selections: string[][]) => {
    if (!api || !selected) return;
    const sessionId = selected;
    const key = crypto.randomUUID();
    setStatusKind({ kind: 'answer', toolUseId, selections });
    setStatus('sending');
    let rec;
    try {
      rec = await api.postAnswer(sessionId, toolUseId, selections, key);
    } catch {
      if (selectedRef.current === sessionId) setStatus('failed');
      return;
    }
    if (selectedRef.current === sessionId) setStatus(rec.state as PromptState);
    if (rec.state === 'queued') setPendingPrompt({ kind: 'answer', sessionId, toolUseId, selections, key });
  };
```

Derive, just before the `return (`:

```tsx
  const answerInFlight = status && statusKind?.kind === 'answer' && status !== 'accepted'
    ? { toolUseId: statusKind.toolUseId, status, selections: statusKind.selections }
    : null;
  const composerStatus = statusKind?.kind === 'text' ? status : null;
```

Update the two JSX call sites:

```tsx
              : <Transcript events={events} sessionId={selected} sessionCwd={current?.cwd ?? ''}
                  canAnswer={current?.mode === 'owned' && current.writable}
                  answerInFlight={answerInFlight}
                  onAnswer={(toolUseId, selections) => void sendAnswer(toolUseId, selections)} />}
```

```tsx
              <Composer mode={current.mode} status={composerStatus} onSend={(t) => void send(t)}
                onHandback={() => void handbackSession()} handingBack={handingBack} />
```

Everywhere `setStatus(null); setPendingPrompt(null);` appears (takeover, picker `onPick`), also add `setStatusKind(null);`. Delete the big story-8 `{/* onAnswerQuestion stays undefined … */}` comment.

- [ ] **Step 4: Run to verify it passes, then full gate**

Run: `cd microviber/pwa && npx vitest run test/app-answer.test.tsx test/composer-gate.test.tsx`
Expected: PASS.
Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green (this is where the PWA typecheck deferred from Task 6 must go green).

- [ ] **Step 5: Commit**

```bash
git add pwa/src/App.tsx pwa/test/app-answer.test.tsx
git commit -m "feat(pwa): wire Send answers through a shared in-flight slot; Retry uses a fresh Idempotency-Key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Documentation, brief/story pointers, manual verification

**Files:**
- Modify: `docs/architecture-spec.md` (§2 F17 pointer; §3 `lib/claude-adapter/` list; §4 API table `/prompt` row; §5 T11 row)
- Modify: `docs/functional-spec.md` §3 (Transcript view; Composer gating on idle)
- Modify: `docs/features/microviber-track-b/stories/story-8.md` (AC15 note pointer)
- Modify: `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md` (Outcome line)

**Interfaces:** none.

- [ ] **Step 1: architecture-spec.md**

In the F17 row's "Practical effect" text, append: ` **Resolved by the AskUserQuestion answer mechanism (F18, `docs/features/askuserquestion-answer-mechanism/spec.md`): answers go out as plain text and the daemon resolves the question from any later human turn; the tool_result write path was removed.**`

In §3's `lib/claude-adapter/` sub-module list add after `transcript-meta.ts`:

```markdown
- `ask-user-question.ts` — everything about `AskUserQuestion` in one place: tool_use
  detection (shared by `tail.ts` and `transcript-meta.ts`), the two-clause resolution rule
  (a matching `tool_result`, OR a later human turn — text present, `isMeta !== true`, no
  `origin` — F18), and the daemon-composed answer text format with its parser.
```

In §4's API table, replace the `/api/sessions/:id/prompt` row's purpose with:

```markdown
| `/api/sessions/:id/prompt` | POST | bearer | Send a user turn. **Requires `Idempotency-Key` header** — 400 `INVALID_INPUT` if absent. Body is exactly one of `{ text }` (a plain prompt) or `{ answer: { toolUseId, selections: string[][] } }` (an answer to the currently pending `AskUserQuestion`; the daemon validates it against that question — 400 `INVALID_INPUT` `question is no longer pending` / `answer must cover every question` / `question <header> accepts one option` / `unknown option for <header>` — composes the text `Answering your question(s):` + one `- <header>: <labels>` line per question, and sends it as a plain user turn; a same-key replay is matched on the canonical answer body before any re-validation). Delegates to `sendPrompt`, which throws a typed `FORBIDDEN` error for a session that has not been taken over — **HTTP 403**, no `PromptRecord` persisted, still audited. Success returns `{success:true, data:<PromptStatus>}`. |
```

In §5's T11 row, append: ` **Narrowed (askuserquestion-answer-mechanism, <DATE>):** the daemon now echoes model-authored `AskUserQuestion` option labels back into the session as a user prompt — only on an explicit user tap, only labels validated exactly against the pending question's own options (`domain/answer.ts`), in a fixed format, length-capped; the composer already allows arbitrary user text on the same route, so no new capability is granted.`

- [ ] **Step 2: functional-spec.md §3**

Under **Transcript view**, after the last `**Changed**` entry, add:

```markdown
**Changed (<DATE>, askuserquestion-answer-mechanism):** a pending `AskUserQuestion` on a
**taken-over** session is answerable in place: its options become selectable chips (one per
question, several when the question allows multi-select) and a single **Send answers**
button, enabled once every question has a pick, sends all answers as one message. The card
shows the same sending / waiting / failed-with-Retry states as a normal prompt and never
shows the question as answered until the message is seen in the transcript. Once answered
— from the phone, from the composer as free text, or on the laptop — the card dims with
the chosen options highlighted (or a neutral "no longer pending" caption when no option can
be matched). Before takeover the options stay inert and the bottom bar's **Take over** is
the only action. Right after takeover the transcript may show Claude's short "No response
requested." reply to its own resume handshake; that is real transcript content and is not
hidden.
```

Under **Composer gating on idle**, add:

```markdown
**Changed (<DATE>, askuserquestion-answer-mechanism):** while a question is pending on a
taken-over session the composer stays available and is the free-text ("Other") path — any
message typed there is a real reply and closes the question.
```

- [ ] **Step 3: Pointers**

`story-8.md`, at the end of the "AC15 resolution note" paragraph, append: ` **Follow-up shipped as `docs/features/askuserquestion-answer-mechanism/` (F18).**`

`askuserquestion-answer-mechanism-brief.md`, directly under the `**Status:**` line, add: `**Outcome (2026-09-03):** brainstormed — see [`../askuserquestion-answer-mechanism/spec.md`](../askuserquestion-answer-mechanism/spec.md). The §6 hybrid was adopted with transcript-derived resolution instead of daemon-side state; F18 records that the handshake is conditional and that `AskUserQuestion` is disabled in `-p`.`

- [ ] **Step 4: Full gate and commit**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green.

```bash
git add docs
git commit -m "docs(askuserquestion-answer-mechanism): F17/F18 pointers, adapter module list, /prompt body, T11 note, functional-spec Changed entries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification (real session — recorded in the story's checklist, not automatable)**

1. Start the daemon (`daemon/`, per `INSTALL.md`; see the MicroViber daemon-ops memory: `pgrep` before restarting, pidfile can be stale). Open the PWA on the phone.
2. In a laptop Claude Code session, get the model to call `AskUserQuestion` (e.g. "Ask me with AskUserQuestion whether to proceed, options Yes/No"). Confirm the phone lists the session as `awaiting-input` (fuchsia dot) and renders the question inert.
3. Tap **Take over**. Confirm the transcript soon shows the model's "No response requested." turn and the card becomes interactive.
4. Pick an option, tap **Send answers**. Confirm: status goes waiting → clears; the user turn `Answering your question:` appears; the model's next reply acts on the answer; the card dims with the chosen option highlighted; the session state leaves `awaiting-input`.
5. **Restart the daemon and reload the PWA.** Confirm the card is still resolved and the state is not `awaiting-input`.
6. Repeat 2–3 on a fresh question, then answer by typing free text in the composer. Confirm the card dims with "no longer pending" and the model acts on the text.
7. Repeat 2–3, then answer **on the laptop** (`/resume` the session there if needed). Confirm the phone's card resolves with the laptop's pick highlighted (clause a).
8. Multi-question: get the model to ask two questions in one call (one multi-select). Confirm Send answers stays disabled until both have picks, and the composed message lists both lines.

---

## Self-Review

**Spec coverage.** §2 findings → Task 1 (F18 row) + Task 8 (pointers). §4.1 rule, `<tool_use_error>` normalisation, `origin` direction → Task 2/3. §4.2 shared helper → Task 2/3 (SYNC comments deleted). §4.3 `isMeta` → Task 2. §4.4 `resolvedBy`, text turn kept, PWA mirror → Task 3/6. §5.1 body union → Task 5. §5.2 order (ownership → replay → validate), messages, audit prompt → Task 4 (`findReplay`) + Task 5. §5.3 compose/parse, cap, degrade → Task 2 (+ cap enforced in Task 5). §5.4 `answerBody` atomic in `submit()` → Task 4. §5.5 no `deriveState` change → none needed. §6 removals → Task 4 (adapter/domain), Task 5 (`toolUseId` in api/app), Task 6 (PWA prop/types). §7.1 card states, fresh Retry key, slot with kind/toolUseId → Task 6/7. §7.2 composer available → Task 7 (unchanged rendering). §7.3 handshake visible → nothing to build; documented in Task 8. §8 tests → Tasks 2–7 + manual in Task 8. §9/§10 → Task 8 T11 note; no transport/auth change anywhere. §11 docs → Task 8. §12 out of scope → nothing planned for those.

**Placeholder scan.** The only intentional placeholders are `<DATE>` and the F18 addendum's `<PASS or FAIL …>` in Tasks 1 and 8, which the implementer fills from real evidence; both are called out where they appear.

**Type consistency.** `detectAskUserQuestion` / `isResolvingUserEntry` / `composeAnswerText` / `parseAnswerText` / `ANSWER_TEXT_MAX_CHARS` names match across Tasks 2, 3, 5. `findReplay({ key, sessionId, text?, answerBody? })` and `submit({ …, answerBody? })` match between Tasks 4 and 5. `AnswerBody`, `SendPromptBody`, `AppDeps.sendPrompt({ body })` match between Task 5's schema, services, app, and tests. `AnswerInFlight { toolUseId, status, selections }` and Transcript props `canAnswer` / `answerInFlight` / `onAnswer(toolUseId, selections)` match between Tasks 6 and 7. `postAnswer(id, toolUseId, selections, idemKey)` matches Tasks 6 and 7.
