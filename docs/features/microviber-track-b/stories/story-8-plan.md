# AskUserQuestion Support (microviber-track-b-8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a pending `AskUserQuestion` tool call in a session's transcript, fix the real bug that keeps such a session unreachable from the phone for up to an hour, and let the phone see and (if the transport allows it) answer the question.

**Architecture:** Four layers, each depending on the one before: (1) an empirical spike settles whether an answer can even be written back into a resumed session; (2) `transcript-meta.ts` gains passive detection of a pending/resolved `AskUserQuestion`; (3) `session-state.ts`/`ownership.ts`/`notify-policy.ts` consume that detection to add a structural `awaiting-input` state that overrides the existing timing heuristics and unblocks takeover; (4) the PWA renders the new state and (gated on the spike's outcome) wires answer submission through the existing `send()` path. No new write mechanism is introduced anywhere — answer submission, if it ships, reuses the exact takeover-gated write path an ordinary prompt already uses.

**Tech Stack:** Node 22 + TypeScript, daemon = Fastify, pwa = Vite + React 19 + Tailwind 4, tests = vitest.

## Global Constraints

- Full quality gate — `npm run typecheck && npm run lint && npm test` from `microviber/` root — must pass before any commit (`microviber/CLAUDE.md`).
- Every parse boundary is validated through a defensive zod schema regardless of how trusted the source is — Claude Code writes the transcript, not the end user, but the standard applies anyway (architecture-spec.md §6 engineering standards; spec.md §6).
- All Claude Code internals stay behind `daemon/src/lib/claude-adapter/`'s quarantine — code outside that directory must not read `~/.claude/` or spawn `claude` directly (`microviber/CLAUDE.md` security rules). Task 1's spike is an investigation performed manually/via a scratch script outside the shipped codebase, not a new production write path.
- The `awaiting-input` override in `deriveState` is a **structural** signal, not a heuristic: it is evaluated immediately after the existing `!alive → stale` check and unconditionally before every timing-based rule (`notify_idle`, the 20s/60min growth windows) (spec.md §6; story AC8).
- Composer: **no shortcut**, per the confirmed decision in spec.md §9 — `awaiting-input` maps to the exact same "Take over — send from phone" button as `idle`; a question's options only become tappable after an explicit take-over (story AC14).
- `NotifyPolicy` scope boundary: this plan makes its state-comparison logic correct and ready. It does **not** wire `NotifyPolicy` into `app.ts`/`services.ts` and does **not** build a `web-push`-based sender — neither exists today even for plain `idle`, and building one is out of scope here (story Technical Notes; spec.md §7).
- No new trust boundary: answer submission (if the spike passes) reuses the existing takeover-gated write path and its existing protections — it is "another kind of write," not a new one (spec.md §7).

---

## Task 1: SPIKE — verify `tool_result`-over-stdin write mechanism — ✅ DONE (PASS)

**Completed 2026-09-03**, against a real interactive session (not a disposable scratch one — the
question was asked and answered in a live `claude-vscode` session at cwd `/Users/yariv_s/Harness-2`,
sessionId `10c30571-5429-4bc5-a749-857d08fc6aa1`, tool_use_id `toolu_01PcTak2uxLBQJYH7gY5DJy6`).
**Outcome: PASS**, with one caveat — see the F16 row in `microviber/docs/architecture-spec.md` §2
for the full transcript evidence. Two earlier automation attempts (spawning a nested nested test
session from inside another live Claude Code session) produced misleading results — transcript
writes for assistant messages didn't appear at all in that nested setup — before a genuinely
independent session settled it cleanly. Do not read those as a separate finding; the real,
non-nested test is authoritative.

Proceed to Tasks 2-5 as written — Task 5's answer-submission step is **not** gated off (spike
outcome is PASS), but keep the caveat in mind: a resumed `-p` process's own next turn doesn't
have `AskUserQuestion` in its own tool list, so Task 5's `send()`-based answer submission must be
tested against a real end-to-end takeover (per its own Manual Test Checklist item), not assumed
correct from this spike alone.

**Files:**
- Modify: `microviber/docs/architecture-spec.md` (§2 verified-claims table — new F16 row)
- No shipped code changes — this is an investigation task performed against a disposable scratch session.

**Interfaces:**
- Produces: a recorded PASS/FAIL finding in architecture-spec.md §2 that Task 5's answer-submission step is gated on. **Do not implement answer submission (Task 5's last step) before this task's outcome is known.**

- [x] **Step 1: Set up a real, disposable test session**

In a scratch directory, start a real Claude Code session and get it to reach a state where the *next* model turn calls `AskUserQuestion`: run `claude` interactively in a scratch folder and prompt it with *"Call the AskUserQuestion tool right now with a single yes/no question, verbatim, no other action."* Confirm in the terminal that it calls the tool and is now waiting.

- [x] **Step 2: Resume the session headlessly, matching MicroViber's exact takeover invocation**

```bash
# Find the session id from the terminal's own output, or via
# `ls ~/.claude/projects/<encoded-cwd>/` for the newest .jsonl.
claude -p --verbose --resume <sessionId> --input-format stream-json --output-format stream-json --dangerously-skip-permissions
```

Leave this process running in the foreground — do not background it, you need to watch what it does live.

- [x] **Step 3: Inspect the transcript's pending tool_use to get the exact `tool_use_id`**

```bash
tail -5 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

Find the `assistant` entry whose content includes a `tool_use` block with `"name":"AskUserQuestion"` — copy its `"id"` field (the `tool_use_id` the answer must reference).

- [x] **Step 4: Attempt the write — send a `tool_result` frame on the resumed process's stdin**

Mirror exactly what `daemon/src/lib/claude-adapter/session-manager.ts`'s `stdinWrite` does — a small Node harness spawning the same command and writing directly to `child.stdin`, matching `prompt-sender.ts`'s `userFrame()` framing (one JSON object per line):

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"<the id from Step 3>","content":"yes"}]}}
```

- [x] **Step 5: Observe and record the outcome**

Watch both the process's stdout and `tail -f` the transcript file. Record exactly one outcome:
- **PASS** — the transcript grows with a new `user` entry containing the `tool_result`, immediately followed by a new `assistant` entry acknowledging the answer.
- **FAIL (rejected)** — the process errors, exits, or the transcript doesn't grow / grows with something indicating an invalid frame.
- **FAIL (silently ignored)** — the write returns success but nothing happens (matches the I6 peer-socket pattern — a superficially successful write with no effect).

- [x] **Step 6: Document the finding and commit**

Append to `microviber/docs/architecture-spec.md` §2's verified-claims table, matching the existing F11-style row format exactly:

```markdown
| F16 | `tool_result` content blocks can be written over the same takeover stdin transport as plain user turns | <PASS/FAIL — paste the actual transcript excerpt observed in Step 5> |
```

**If PASS:** proceed to Tasks 2-5 as written — Task 5's answer-submission step reuses the existing `send()`/`userFrame()`-style path with a `tool_result` frame instead of a `text` frame.

**If FAIL:** do not implement Task 5's answer-submission step as scoped (story AC15's FAIL branch — render options inert, flag it in the PR description, and file a follow-up for `syncounter-brainstorming` to resolve the submission mechanism). Tasks 2-4 remain valid either way — they only touch state *derivation*, not submission.

```bash
cd microviber && git add docs/architecture-spec.md
git commit -m "docs: record F16 finding — tool_result-over-stdin spike for AskUserQuestion answers"
```

---

## Task 2: `transcript-meta.ts` — `AskUserQuestion` detection

**Files:**
- Modify: `daemon/src/lib/claude-adapter/transcript-meta.ts`, `daemon/src/lib/claude-adapter/schemas.ts`
- Test: extend `daemon/test/transcript-meta.test.ts`, extend `daemon/test/schemas.test.ts`

**Interfaces:**
- Consumes: nothing new — reads existing transcript JSONL lines.
- Produces: `TranscriptMeta.pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null`, consumed by Task 3's `deriveState`/`buildSummary`. `schemas.ts` exports `ToolResultBlock`, `AskUserQuestionInputSchema`, and type `AskUserQuestionInput`. `ToolUseBlock` gains a required `id: string` field.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/schemas.test.ts`:

```ts
import { ToolResultBlock, AskUserQuestionInputSchema } from '../src/lib/claude-adapter/schemas.js';

describe('ToolResultBlock', () => {
  it('parses a tool_result content block', () => {
    const r = ToolResultBlock.safeParse({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'yes' });
    expect(r.success).toBe(true);
  });
});

describe('AskUserQuestionInputSchema', () => {
  it("parses the tool's documented input shape", () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
    });
    expect(r.success).toBe(true);
  });
  it('rejects a shape missing required fields', () => {
    expect(AskUserQuestionInputSchema.safeParse({ questions: [{ question: 'x' }] }).success).toBe(false);
  });
});
```

Add to `daemon/test/transcript-meta.test.ts` (match the file's existing fixture-line-building helper style — if it has a `toolUseLine()`/similar helper, extend that pattern rather than hand-writing raw JSON each time):

```ts
it('detects a pending AskUserQuestion (tool_use with no matching tool_result yet)', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }], multiSelect: false }] } }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' }),
  ].join('\n');
  const meta = scanTranscriptMeta(jsonl);
  expect(meta.pendingQuestion).not.toBeNull();
  expect(meta.pendingQuestion?.toolUseId).toBe('toolu_1');
  expect(meta.pendingQuestion?.questions[0]?.question).toBe('Proceed?');
});

it('clears pendingQuestion once a matching tool_result arrives', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }], multiSelect: false }] } }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] }, timestamp: '2026-01-01T00:00:02Z' }),
  ].join('\n');
  const meta = scanTranscriptMeta(jsonl);
  expect(meta.pendingQuestion).toBeNull();
});

it('ignores a tool_use for any tool other than AskUserQuestion', () => {
  const jsonl = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' });
  expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/schemas.test.ts test/transcript-meta.test.ts`
Expected: FAIL — `ToolResultBlock`/`AskUserQuestionInputSchema` don't exist, `pendingQuestion` isn't on `TranscriptMeta`, `ToolUseBlock` rejects the `id` field with strict parsing if the fixtures include it before the schema is updated.

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/schemas.ts`, add `id` to `ToolUseBlock` (a real, necessary fix — without it, tool_use/tool_result matching by id is impossible) and add the two new exports:

```ts
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string().max(128),
  input: z.unknown(),
});

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
});

export const AskUserQuestionInputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean().optional(),
  })),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>['questions'][number];
```

In `daemon/src/lib/claude-adapter/transcript-meta.ts`, splice into the existing function body at the marked points (do not duplicate the existing `extractText`/title logic already there):

```ts
import { TranscriptLineSchema, ToolResultBlock, AskUserQuestionInputSchema, type AskUserQuestionInput } from './schemas.js';

export interface TranscriptMeta {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null;
}

export function scanTranscriptMeta(jsonl: string): TranscriptMeta {
  // ...existing local vars...
  let pendingQuestion: TranscriptMeta['pendingQuestion'] = null;

  for (const line of jsonl.split('\n')) {
    // ...existing parse/skip logic...

    if (e.type === 'assistant') {
      turnOpen = e.message.stop_reason !== 'end_turn';
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use' && (block as { name?: string }).name === 'AskUserQuestion') {
            const parsedInput = AskUserQuestionInputSchema.safeParse((block as { input?: unknown }).input);
            if (parsedInput.success) {
              pendingQuestion = { toolUseId: (block as { id: string }).id, questions: parsedInput.data.questions };
            }
          }
        }
      }
    } else if (e.type === 'user') {
      // ...existing extractText/turnOpen logic...
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const parsed = ToolResultBlock.safeParse(block);
          if (parsed.success && pendingQuestion && parsed.data.tool_use_id === pendingQuestion.toolUseId) {
            pendingQuestion = null;
          }
        }
      }
    }
  }

  return { title: customTitle ?? aiTitle, lastPrompt, lastPromptAt, lastActivityAt, turnOpen, pendingQuestion };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/schemas.test.ts test/transcript-meta.test.ts`
Expected: PASS (all existing tests plus the 5 new ones)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/lib/claude-adapter/transcript-meta.ts daemon/src/lib/claude-adapter/schemas.ts daemon/test/transcript-meta.test.ts daemon/test/schemas.test.ts
git commit -m "feat(askuserquestion): detect pending/resolved AskUserQuestion in transcript-meta (spec §6)"
```

---

## Task 3: `session-state.ts` `awaiting-input` state + `ownership.ts` gate extension — the actual bug fix

**Files:**
- Modify: `daemon/src/domain/session-state.ts`, `daemon/src/domain/ownership.ts`, `daemon/src/domain/registry.ts`, `daemon/src/lib/claude-adapter/discovery.ts`
- Test: extend `daemon/test/session-state.test.ts`, `daemon/test/ownership.test.ts`, `daemon/test/registry.test.ts`

**Interfaces:**
- Consumes: Task 2's `TranscriptMeta.pendingQuestion`.
- Produces: `SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input'`. `deriveState` gains a `hasPendingQuestion: boolean` input. `assertIdleForTakeover` accepts `'idle' | 'awaiting-input'`. `SessionSummary.pendingQuestion`, consumed by Task 5's PWA rendering.

- [ ] **Step 1: Reproduce the pre-fix bug against current `main`**

Get a real session to call `AskUserQuestion` (as in Task 1 Step 1), then confirm against the current (unmodified) code: the daemon reports it as `working`, and `POST /api/sessions/:id/takeover` returns 403. Record this before writing any new code, per story AC6 ("verify this bug reproduces against the actual pre-fix code before claiming it's fixed").

- [ ] **Step 2: Write the failing tests**

Add to `daemon/test/session-state.test.ts`:

```ts
it('a pending AskUserQuestion overrides every timing-based rule — awaiting-input even with fresh growth', () => {
  const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: true, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
  expect(state).toBe('awaiting-input');
});

it('a dead session is still stale even with a pending question — !alive is checked first', () => {
  const state = deriveState({ alive: false, lastActivityAt: null, notifyIdleAt: null, turnOpen: true, hasPendingQuestion: true, nowMs: 0 });
  expect(state).toBe('stale');
});

it('without a pending question, behavior is unchanged from before (regression guard)', () => {
  const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
  expect(state).toBe('working');
});
```

Add to `daemon/test/ownership.test.ts`:

```ts
it('assertIdleForTakeover accepts awaiting-input alongside idle (the actual bug fix)', () => {
  expect(() => assertIdleForTakeover('awaiting-input')).not.toThrow();
});
it('assertIdleForTakeover still rejects working and stale', () => {
  expect(() => assertIdleForTakeover('working')).toThrow(ForbiddenTakeoverError);
  expect(() => assertIdleForTakeover('stale')).toThrow(ForbiddenTakeoverError);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd daemon && npx vitest run test/session-state.test.ts test/ownership.test.ts`
Expected: FAIL — `deriveState` doesn't accept `hasPendingQuestion`, `assertIdleForTakeover` still rejects `'awaiting-input'`

- [ ] **Step 4: Implement**

In `daemon/src/domain/session-state.ts`:

```ts
export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';

export function deriveState(input: {
  alive: boolean;
  lastActivityAt: string | null;
  notifyIdleAt: string | null;
  turnOpen: boolean;
  /** A structural override (spec Feature 5 §6): a session genuinely blocked
   * on AskUserQuestion is awaiting-input regardless of transcript timing —
   * this is NOT a heuristic like the growth-window rules below it, so it's
   * checked right after the only other structural check (!alive) and before
   * every timing-based rule, including notify_idle. */
  hasPendingQuestion: boolean;
  nowMs: number;
}): SessionState {
  if (!input.alive) return 'stale';
  if (input.hasPendingQuestion) return 'awaiting-input';

  if (input.notifyIdleAt) {
    const idleAt = Date.parse(input.notifyIdleAt);
    const growthAt = input.lastActivityAt ? Date.parse(input.lastActivityAt) : -Infinity;
    if (!Number.isNaN(idleAt) && idleAt >= growthAt) return 'idle';
  }

  if (input.lastActivityAt) {
    const growthAt = Date.parse(input.lastActivityAt);
    if (!Number.isNaN(growthAt)) {
      const sinceGrowth = input.nowMs - growthAt;
      if (sinceGrowth < IDLE_AFTER_MS) return 'working';
      if (input.turnOpen && sinceGrowth < OPEN_TURN_MAX_MS) return 'working';
    }
  }

  return 'idle';
}
```

In `daemon/src/domain/ownership.ts`:

```ts
export function assertIdleForTakeover(state: SessionState): void {
  if (state !== 'idle' && state !== 'awaiting-input') throw new ForbiddenTakeoverError(state);
}
```

In `daemon/src/domain/registry.ts`, thread `pendingQuestion` through so `buildSummary` can pass `hasPendingQuestion` to `deriveState`:

```ts
export interface DiscoveredLike {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
}

export interface SessionSummary {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
}

export function buildSummary(d: DiscoveredLike, ctx: { /* ...existing... */ }): SessionSummary {
  return {
    // ...existing fields...
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      turnOpen: d.turnOpen,
      hasPendingQuestion: d.pendingQuestion !== null,
      nowMs: ctx.nowMs,
    }),
    pendingQuestion: d.pendingQuestion,
  };
}
```

`DiscoveredLike` is populated from `discoverSessions()` (in `lib/claude-adapter/discovery.ts`), which already reads `scanTranscriptMeta`'s output for `turnOpen`/`lastActivityAt`/etc. Extend that same call site to also pass through `pendingQuestion` (find where `discovery.ts` destructures `scanTranscriptMeta`'s return value and constructs its own discovered-session object; add `pendingQuestion: meta.pendingQuestion` alongside the existing fields it already copies).

- [ ] **Step 5: Run to verify pass**

Run: `cd daemon && npx vitest run test/session-state.test.ts test/ownership.test.ts test/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Repeat the real-session reproduction from Step 1 against the fixed code**

Confirm: the session now reports `awaiting-input` and `POST /api/sessions/:id/takeover` succeeds (story AC6/AC9). Also confirm a session with a genuinely open non-question tool call (e.g. mid-`Bash`) still correctly reports `working`, not `awaiting-input` — no regression to the existing open-turn heuristic.

- [ ] **Step 7: Full typecheck (this touches discovery.ts too) and commit**

```bash
cd daemon && npm run typecheck && npx vitest run
git add daemon/src/domain/session-state.ts daemon/src/domain/ownership.ts daemon/src/domain/registry.ts daemon/src/lib/claude-adapter/discovery.ts daemon/test/session-state.test.ts daemon/test/ownership.test.ts daemon/test/registry.test.ts
git commit -m "fix(askuserquestion): add awaiting-input state, unblock takeover during AskUserQuestion (spec §6 — the actual bug)"
```

---

## Task 4: `notify-policy.ts` — extend state type (logic only, no push dispatch)

**Files:**
- Modify: `daemon/src/domain/notify-policy.ts`
- Test: extend `daemon/test/notify-policy.test.ts`

**Interfaces:**
- Consumes: nothing new from Tasks 2-3 — `NotifyPolicy` keeps its own independent `State` type, not imported from `session-state.ts` (spec.md §7 explicitly calls this out as easy to miss).
- Produces: `NotifyPolicy`'s `State` type gains `'awaiting-input'` as a second notify-triggering value alongside `'idle'`, via a new `isWaitingForYou` helper.

**Explicit scope note (Global Constraints):** this task makes the logic correct. It does **not** wire `NotifyPolicy` into `app.ts`/`services.ts`, and does **not** build a push-dispatch mechanism.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/notify-policy.test.ts`:

```ts
it('notifies when a session transitions into awaiting-input, same as transitioning into idle', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  expect(intents).toEqual([{ type: 'notify', sessionId: 's1', tag: 'session:s1', title: 'T', body: '' }]);
});

it('does not double-notify transitioning directly from idle to awaiting-input or back', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  expect(intents).toEqual([]); // both are "waiting for you" states — no re-notify between them
});

it('dismisses when leaving awaiting-input for working', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
  expect(intents).toEqual([{ type: 'dismiss', tag: 'session:s1' }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/notify-policy.test.ts`
Expected: FAIL — `'awaiting-input'` isn't assignable to the current `State` type; the idle-to-awaiting-input case incorrectly re-notifies.

- [ ] **Step 3: Implement**

```ts
// daemon/src/domain/notify-policy.ts
type State = 'working' | 'idle' | 'stale' | 'awaiting-input';
interface SessionLite { id: string; state: State; title: string; statusLine?: string }

// ...NotifyIntent, tagOf unchanged...

function isWaitingForYou(s: State): boolean {
  return s === 'idle' || s === 'awaiting-input';
}

export class NotifyPolicy {
  private last = new Map<string, State>();

  reconcile(sessions: readonly SessionLite[]): NotifyIntent[] {
    const intents: NotifyIntent[] = [];
    const seen = new Set<string>();

    for (const s of sessions) {
      seen.add(s.id);
      const prev = this.last.get(s.id);
      const prevWaiting = prev !== undefined && isWaitingForYou(prev);
      const nowWaiting = isWaitingForYou(s.state);
      if (nowWaiting && !prevWaiting) {
        intents.push({ type: 'notify', sessionId: s.id, tag: tagOf(s.id), title: s.title, body: s.statusLine ?? '' });
      } else if (!nowWaiting && prevWaiting) {
        intents.push({ type: 'dismiss', tag: tagOf(s.id) });
      }
      this.last.set(s.id, s.state);
    }

    for (const [id, prev] of this.last) {
      if (!seen.has(id)) {
        if (isWaitingForYou(prev)) intents.push({ type: 'dismiss', tag: tagOf(id) });
        this.last.delete(id);
      }
    }
    return intents;
  }

  onOpened(sessionId: string): NotifyIntent {
    return { type: 'dismiss', tag: tagOf(sessionId) };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/notify-policy.test.ts`
Expected: PASS (all existing tests, unchanged behavior for plain idle transitions, plus the 3 new ones)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/domain/notify-policy.ts daemon/test/notify-policy.test.ts
git commit -m "feat(askuserquestion): treat awaiting-input as a notify-triggering state in NotifyPolicy (logic only — no push dispatch exists yet, filed separately)"
```

---

## Task 5: PWA — `awaiting-input` UI (session list, Transcript rendering, Composer, answer submission)

**Files:**
- Modify: `pwa/src/lib/types.ts`, `pwa/src/components/Transcript.tsx`, `pwa/src/components/Composer.tsx`, `pwa/src/App.tsx`
- No change expected: `pwa/src/components/SessionPicker.tsx` (its `STATE_DOT` map already reserves `'awaiting-input': 'bg-fuchsia-400'` from story microviber-track-b-6 — verify this at Step 1, don't assume).
- Test: extend `pwa/test/session-picker.test.tsx`; new `pwa/test/transcript-askuserquestion.test.tsx`; extend composer/App tests.

**Interfaces:**
- Consumes: Task 3's `SessionSummary.pendingQuestion` (daemon) mapped to the PWA's own `TranscriptEvent`; Task 1's spike outcome gates the last step below.
- Produces: `SessionState` (PWA) gains `'awaiting-input'`. `TranscriptEvent` gains `{ kind: 'askUserQuestion'; at: string; toolUseId: string; questions: {...}[]; resolved: boolean; selectedLabels?: string[] }`.

**Gated on Task 1's spike outcome:** the final "answer submission" step below assumes PASS. If Task 1 recorded FAIL, implement every other step in this task, and leave the option list read-only/inert even when taken over — flag in the PR description (not the code) that submission is pending a resolved design (story AC15 FAIL branch).

- [ ] **Step 1: Write the failing tests**

Session-list dot (add to `pwa/test/session-picker.test.tsx`):

```tsx
it('renders a distinct dot color for awaiting-input, different from idle and working', () => {
  render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ state: 'awaiting-input' })]} onPick={() => {}} />);
  const dot = screen.getByText('A').parentElement!.previousElementSibling!;
  expect(dot.className).toMatch(/bg-fuchsia-400/);
});
```

Transcript rendering (new `pwa/test/transcript-askuserquestion.test.tsx`):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';

afterEach(cleanup);

describe('Transcript AskUserQuestion rendering (spec §6)', () => {
  it('renders a pending question expanded, never collapsed to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders a resolved question read-only with the selected option highlighted', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    const yes = screen.getByText('Yes');
    expect(yes.className).toMatch(/amber|selected/);
  });

  it('a non-AskUserQuestion tool call is unaffected — still collapses to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'tool', at: '2026-01-01T00:00:00Z', name: 'Bash', summary: 'ran a command' },
    ]} />);
    expect(screen.getByText('ran a command')).toBeInTheDocument();
  });
});
```

Composer mapping — find App.tsx's existing readonly-mode ternary (`working`/`idle`/`stale`) and its existing test coverage (likely `composer-gate.test.tsx` via full App render); add an equivalent case asserting `awaiting-input` renders the same "Take over — send from phone" button as `idle`.

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run`
Expected: FAIL — `'askUserQuestion'` isn't a valid `TranscriptEvent` kind, `'awaiting-input'` isn't a valid `SessionState`

- [ ] **Step 3: Implement types and Transcript rendering**

In `pwa/src/lib/types.ts`:

```ts
export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';

export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean; selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[] };
```

In `pwa/src/components/Transcript.tsx`, add a case to `EventRow`'s switch:

```tsx
case 'askUserQuestion':
  return (
    <div className="rounded-lg border border-fuchsia-700/50 bg-fuchsia-500/5 p-3">
      {e.questions.map((q, qi) => (
        <div key={qi} className="mb-2 last:mb-0">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-fuchsia-400">{q.header}</div>
          <div className="mb-2 text-[15px] text-zinc-100">{q.question}</div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => {
              const isSelected = e.resolved && e.selectedLabels?.includes(o.label);
              return (
                <span key={o.label} className={`rounded-full border px-3 py-1 text-[13px] ${isSelected ? 'border-amber-400 bg-amber-400/10 text-amber-300 font-semibold' : 'border-zinc-600 text-zinc-300'} ${e.resolved ? 'opacity-80' : ''}`}>
                  {o.label}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
```

- [ ] **Step 4: Implement Composer/App.tsx mapping**

Verify `pwa/src/components/SessionPicker.tsx`'s `STATE_DOT` map already has an `'awaiting-input'` entry (from story microviber-track-b-6); if it's missing, add `'awaiting-input': 'bg-fuchsia-400'` there.

In `pwa/src/App.tsx`, find the existing readonly-mode ternary (`current.state === 'idle' ? ... : current.state === 'stale' ? ... : ...` — the block rendering "Take over" / "session has ended" / "still working") and add `awaiting-input` as mapping to the same branch as `idle`:

```tsx
current.state === 'idle' || current.state === 'awaiting-input' ? (
  <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
    <button onClick={() => void takeoverSession()} disabled={takingOver}
      className="w-full rounded-lg bg-amber-400 py-2.5 text-[14px] font-semibold text-amber-950 disabled:opacity-60">
      {takingOver ? 'Taking over…' : 'Take over — send from phone'}
    </button>
  </div>
) : current.state === 'stale' ? (
  // ...unchanged...
```

- [ ] **Step 5: Run to verify pass (except answer submission, not yet wired)**

Run: `cd pwa && npx vitest run`
Expected: PASS (full suite)

- [ ] **Step 6: Answer submission — only if Task 1's spike recorded PASS**

Wire tapping an option in a *pending* (`resolved: false`) question to call `send()` with the option's label as plain text, reusing the exact existing `send` function in `App.tsx` unchanged (per spec §6: "follows the same accepted/queued/failed lifecycle as an ordinary sent prompt"). Thread a new `onAnswerQuestion: (toolUseId: string, label: string) => void` prop through `Transcript`/`EventRow`, wired in `App.tsx` to `(toolUseId, label) => void send(label)`. Only render options as clickable when `current.mode === 'owned'` (taken over) and `!e.resolved`; otherwise render them as the inert, non-interactive spans from Step 3.

If Task 1 recorded FAIL, skip this step entirely — options stay inert per the Gate note above.

- [ ] **Step 7: Full typecheck, full test suite both workspaces, lint, commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add pwa/src/lib/types.ts pwa/src/components/Transcript.tsx pwa/src/components/SessionPicker.tsx pwa/src/App.tsx pwa/test/
git commit -m "feat(askuserquestion): render pending/resolved questions in transcript, wire answer submission through existing send() (spec §6)"
```

---

## Task 6: `tail.ts` — emit a real `askUserQuestion` event over the wire (plan gap found during Task 5 review)

**Added 2026-09-03, after Task 5 landed.** Task 5's implementer correctly flagged a real gap: nothing in the original plan wired the daemon's *live* transcript event stream to actually produce an `askUserQuestion`-kind event. `daemon/src/lib/claude-adapter/tail.ts` (consumed by `services.ts`'s `getTranscript()`, which the PWA polls) still collapses an `AskUserQuestion` tool_use into the generic `{ kind: 'tool', name, summary }` shape — the exact "collapse to one line" treatment story AC12 says must never apply to this tool. Without this task, Task 5's PWA rendering code is real and tested, but nothing in the real daemon ever produces the event it renders — AC12/AC13 do not work end-to-end.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/tail.ts`
- Test: extend `daemon/test/tail.test.ts`

**Interfaces:**
- Consumes: `ToolUseBlock`, `ToolResultBlock`, `AskUserQuestionInputSchema`, `TranscriptLineSchema` (all already exported from `schemas.ts` by Task 2 — no new schema needed).
- Produces: `TranscriptEvent` gains `{ kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean; selectedLabels?: string[]; questions: {...}[] }` — the exact shape Task 5 already defined on the PWA side (`pwa/src/lib/types.ts`), so no wire-format translation is needed at the API layer.

**Design note:** `normalizeLine` is single-line and stateless (its own existing tests call it directly on one line) — it can detect a *pending* `AskUserQuestion` tool_use on its own, but it cannot know whether a *later* line resolves it. `parseChunk` is where multiple lines are available together (and per its only real caller, `services.ts`'s `getTranscript()`, it's always called with the *entire* transcript text, not a true incremental delta) — so cross-line resolution matching belongs there, not in `normalizeLine`. Resolution is matched by exact line index, not by "the next line" adjacency — a real resumed-takeover answer (this story's own mechanism!) writes several session-housekeeping lines between the `tool_use` and its `tool_result`, so adjacency would silently fail for exactly the primary use case this story exists to support.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/tail.test.ts`:

```ts
const assistantToolUseLine = (id: string, name: string, input: unknown, ts = '2026-08-23T11:00:06.000Z') =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: ts });

const toolResultLine = (toolUseId: string, content: string, ts = '2026-08-23T11:00:10.000Z') =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }, timestamp: ts });

const askQuestionInput = { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] };

describe('normalizeLine AskUserQuestion', () => {
  it('emits an unresolved askUserQuestion event for a bare AskUserQuestion tool_use (single-line, no lookahead)', () => {
    const e = normalizeLine(assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput)) as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.kind).toBe('askUserQuestion');
    expect(e.toolUseId).toBe('toolu_1');
    expect(e.resolved).toBe(false);
    expect(e.questions[0]?.question).toBe('Proceed?');
  });

  it('a non-AskUserQuestion tool_use is unaffected — still collapses to the generic tool kind', () => {
    const e = normalizeLine(assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' })) as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
  });
});

describe('parseChunk AskUserQuestion resolution (cross-line)', () => {
  it('marks a pending AskUserQuestion resolved when its matching tool_result appears later, and drops the blank answer bubble', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(1); // the blank tool_result-only user bubble is dropped
    const e = events[0] as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.resolved).toBe(true);
    expect(e.selectedLabels).toEqual(['Yes']);
  });

  it('resolves correctly even with housekeeping lines between the tool_use and its tool_result (the real resumed-takeover-answer shape)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Some session' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual(['Yes']);
  });

  it('stays unresolved with no matching tool_result yet', () => {
    const chunk = assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput) + '\n';
    const { events } = parseChunk(chunk);
    const e = events[0] as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.resolved).toBe(false);
    expect(e.selectedLabels).toBeUndefined();
  });

  it('an ordinary tool_result for a non-AskUserQuestion tool is unaffected (pre-existing behavior, untouched)', () => {
    const chunk = [
      assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' }),
      toolResultLine('toolu_2', 'file1\nfile2'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(2); // tool event + the pre-existing blank user bubble — unchanged, out of this task's scope
    expect(events[0]!.kind).toBe('tool');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/tail.test.ts`
Expected: FAIL — `'askUserQuestion'` isn't a valid `TranscriptEvent` kind yet, resolution logic doesn't exist.

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/tail.ts`:

```ts
import { TranscriptLineSchema, ToolUseBlock, ToolResultBlock, AskUserQuestionInputSchema } from './schemas.js';

export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean; selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[] };

export function normalizeLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = TranscriptLineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  if (e.type !== 'user' && e.type !== 'assistant') return null;

  const at = e.timestamp ?? '';
  const blocks = normalizeContent(e.message.content);

  if (e.type === 'user') {
    return { kind: 'user', at, text: blocks.text ?? '', injected: false };
  }
  if (blocks.tool) {
    if (blocks.tool.name === 'AskUserQuestion' && blocks.tool.id) {
      const parsedInput = AskUserQuestionInputSchema.safeParse(blocks.tool.input);
      if (parsedInput.success) {
        return { kind: 'askUserQuestion', at, toolUseId: blocks.tool.id, resolved: false, questions: parsedInput.data.questions };
      }
    }
    return { kind: 'tool', at, name: blocks.tool.name, summary: blocks.tool.summary };
  }
  return { kind: 'assistant', at, text: blocks.text ?? '' };
}

interface NormalizedContent {
  text?: string;
  tool?: { id?: string; name: string; summary: string; input?: unknown };
}

function normalizeContent(content: unknown): NormalizedContent {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  let tool: NormalizedContent['tool'];
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; name?: string; input?: unknown; id?: string };
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.name === 'string') {
      tool = { id: block.id, name: block.name, summary: summarizeToolInput(block.input), input: block.input };
    }
  }
  const out: NormalizedContent = {};
  if (texts.length) out.text = texts.join(' ');
  if (tool) out.tool = tool;
  return out;
}

function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const v = o[key];
    if (typeof v === 'string' && v) return v.length > 120 ? `${v.slice(0, 119)}…` : v;
  }
  return '';
}

/**
 * Cross-line pass: parseChunk (unlike normalizeLine) sees every line
 * together, so it can match a pending AskUserQuestion to a LATER tool_result
 * by exact line index — never by "next line" adjacency. A real
 * resumed-takeover answer (this story's own write path) writes several
 * session-housekeeping lines between the tool_use and its tool_result, so
 * adjacency would silently fail for exactly the case this exists to serve.
 */
function resolveAskUserQuestions(
  withIndex: { event: TranscriptEvent; lineIndex: number }[],
  rawLines: string[],
): TranscriptEvent[] {
  const pendingIds = new Set(
    withIndex
      .filter((w): w is { event: Extract<TranscriptEvent, { kind: 'askUserQuestion' }>; lineIndex: number } => w.event.kind === 'askUserQuestion')
      .map((w) => w.event.toolUseId),
  );
  if (pendingIds.size === 0) return withIndex.map((w) => w.event);

  const resolutions = new Map<string, string>(); // toolUseId -> raw answer content
  const consumedLineIndices = new Set<number>();

  rawLines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'user') return;
    const content = parsed.data.message.content;
    if (!Array.isArray(content) || content.length !== 1) return;
    const resultParsed = ToolResultBlock.safeParse(content[0]);
    if (!resultParsed.success || !pendingIds.has(resultParsed.data.tool_use_id)) return;
    resolutions.set(resultParsed.data.tool_use_id, typeof resultParsed.data.content === 'string' ? resultParsed.data.content : '');
    consumedLineIndices.add(i);
  });

  if (resolutions.size === 0) return withIndex.map((w) => w.event);

  const out: TranscriptEvent[] = [];
  for (const { event, lineIndex } of withIndex) {
    if (consumedLineIndices.has(lineIndex)) continue; // drop the now-redundant blank answer bubble
    if (event.kind === 'askUserQuestion' && resolutions.has(event.toolUseId)) {
      const rawAnswer = resolutions.get(event.toolUseId)!;
      const selectedLabels = rawAnswer.split(',').map((s) => s.trim()).filter(Boolean);
      out.push({ ...event, resolved: true, selectedLabels });
      continue;
    }
    out.push(event);
  }
  return out;
}

export function parseChunk(chunk: string): { events: TranscriptEvent[]; remainder: string } {
  const lastNl = chunk.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : chunk.slice(0, lastNl);
  const remainder = lastNl === -1 ? chunk : chunk.slice(lastNl + 1);
  const lines = complete ? complete.split('\n') : [];

  const withIndex: { event: TranscriptEvent; lineIndex: number }[] = [];
  lines.forEach((line, i) => {
    const ev = normalizeLine(line);
    if (ev) withIndex.push({ event: ev, lineIndex: i });
  });

  return { events: resolveAskUserQuestions(withIndex, lines), remainder };
}
```

(`ToolUseBlock` is imported but not directly referenced by name in this snippet — `normalizeContent`'s own inline shape check plays that role for backward-compat with the existing generic `tool` handling; drop the import if your linter flags it unused after implementing, or use it if you find a cleaner way to validate the tool_use block. Use your judgment — the exact validation approach matters less than that every parse boundary stays defensive, matching Task 2's precedent.)

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/tail.test.ts`
Expected: PASS (all existing tests unchanged, plus the new ones)

- [ ] **Step 5: Full workspace gate and commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/tail.ts daemon/test/tail.test.ts
git commit -m "feat(askuserquestion): emit askUserQuestion transcript events over the wire, resolve by tool_use_id not line adjacency (spec §6 — closes the Task 5 wire-format gap)"
```

---

## Task 7: switch answer submission to a real `tool_result` frame (CRITICAL fix, found during the final whole-branch review)

**Added 2026-09-03, after the final whole-branch review.** The review flagged (Important) that `pendingQuestion` has no exit condition other than a `tool_result` matching the pending `toolUseId` — and Task 5's answer submission (matching AC15's literal wording) sends a **plain-text prompt** via `send()`, not a `tool_result` frame. The review asked for empirical verification before deciding severity. That verification was done directly: a real live session was driven to a pending `AskUserQuestion`, answered with a plain-text `"Yes"` (the exact frame shape the shipped code sends), and the transcript was inspected. **Confirmed: no `tool_result` is ever backfilled.** The model responds sensibly in conversation ("Got it — noted as 'yes.'"), but the original `tool_use_id` never gets a matching `tool_result` anywhere in the transcript — `pendingQuestion` stays non-null **forever** after every phone-answered question, and the session shows `awaiting-input` indefinitely even though it's fine. This upgrades the finding from Important to **Critical**: the story's core value proposition (answer from your phone) currently leaves the UI permanently lying about session state.

**The fix:** switch answer submission to send an actual `tool_result` frame — the exact mechanism Task 1's F16 spike verified works (a `tool_result` written to a `--resume`'d process's stdin lands correctly, matched by `tool_use_id`). This is real write-path work across both daemon and PWA, reusing the existing takeover-gated send path and its existing protections (no new trust boundary) — it changes *what* gets written, not *who* is allowed to write.

**Files:**
- Modify: `daemon/src/lib/claude-adapter/prompt-sender.ts`, `daemon/src/lib/claude-adapter/session-manager.ts`, `daemon/src/domain/prompt-lifecycle.ts`, `daemon/src/services/services.ts`, `daemon/src/api/app.ts`, `daemon/src/schemas/api.ts`, `pwa/src/lib/api.ts`, `pwa/src/App.tsx`
- Test: extend `daemon/test/prompt-lifecycle.test.ts`, `daemon/test/session-manager.test.ts` (or wherever `spawnHandle`/`startTakeoverSession` is currently tested — check the existing file name first), `daemon/test/services.test.ts`, `daemon/test/app.test.ts`; extend `pwa/test/` coverage for `App.tsx`'s answer flow (find the existing composer/answer test, likely `composer-gate.test.tsx`, and extend it rather than duplicating).

**Interfaces:**
- `PromptSender` gains `sendAnswer(toolUseId: string, label: string, signal?: AbortSignal): Promise<SendOutcome>` alongside the existing `send(prompt: string, signal?: AbortSignal)`. Two clearly separate methods, not one overloaded — matches the existing `userFrame`/`toolResultFrame` split at the wire-framing level.
- `PromptRecord` gains `toolUseId?: string`.
- `PromptLifecycle` gains `submitAnswer({key, sessionId, toolUseId, label, sender, nowMs})` and `observeAnswer({sessionId, toolUseId, atISO})`, siblings to the existing `submit`/`observe`.
- `AppDeps.sendPrompt`'s arg type gains an optional `toolUseId?: string`.
- `SendPromptBody` (wire schema) gains an optional `toolUseId: z.string().max(200).optional()`.
- PWA `api.sendPrompt` gains an optional 4th param `toolUseId?: string`, included in the POST body when present.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/prompt-lifecycle.test.ts` (mirroring the existing `submit`/`observe` tests immediately above):

```ts
const answerSender: PromptSender = { mode: 'owned', send: async () => ({ ok: true }), sendAnswer: async () => ({ ok: true }) };
const answerFailSender: PromptSender = { mode: 'owned', send: async () => ({ ok: true }), sendAnswer: async () => ({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'refused', retryable: true }) };

describe('PromptLifecycle answer submission (tool_result path, spec §6)', () => {
  it('write ok => queued, NOT accepted (accepted requires observing the question resolve)', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_1', label: 'Yes', sender: answerSender, nowMs: t0 });
    expect(r.state).toBe('queued');
    expect(r.toolUseId).toBe('toolu_1');
  });

  it('observing the matching resolved askUserQuestion => accepted', async () => {
    const lc = new PromptLifecycle();
    await lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_1', label: 'Yes', sender: answerSender, nowMs: t0 });
    lc.observeAnswer({ sessionId: 's', toolUseId: 'toolu_1', atISO: '2026-08-23T12:00:01Z' });
    expect(lc.get('k1')?.state).toBe('accepted');
  });

  it('observing an unrelated toolUseId does not accept it', async () => {
    const lc = new PromptLifecycle();
    await lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_1', label: 'Yes', sender: answerSender, nowMs: t0 });
    lc.observeAnswer({ sessionId: 's', toolUseId: 'toolu_OTHER', atISO: '2026-08-23T12:00:01Z' });
    expect(lc.get('k1')?.state).toBe('queued');
  });

  it('write failure => failed', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_1', label: 'Yes', sender: answerFailSender, nowMs: t0 });
    expect(r.state).toBe('failed');
  });

  it('plain submit() and submitAnswer() use independent idempotency-key space consistently — a key reused with a different toolUseId is rejected same as a different text', async () => {
    const lc = new PromptLifecycle();
    await lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_1', label: 'Yes', sender: answerSender, nowMs: t0 });
    await expect(lc.submitAnswer({ key: 'k1', sessionId: 's', toolUseId: 'toolu_2', label: 'Yes', sender: answerSender, nowMs: t0 })).rejects.toThrow();
  });
});
```

Add a test near `prompt-sender.ts`'s existing `userFrame` coverage (check `daemon/test/` for the file that already tests `userFrame` — likely `prompt-sender.test.ts` or folded into `session-manager.test.ts` — extend whichever exists):

```ts
describe('toolResultFrame', () => {
  it('matches the exact stream-json shape verified by the F16 spike (architecture-spec.md §2)', () => {
    const frame = JSON.parse(toolResultFrame('toolu_1', 'Yes'));
    expect(frame).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] },
    });
  });
});
```

Find the existing test(s) for `spawnHandle`/`startTakeoverSession`'s `send()` (writes `userFrame(prompt)` to `child.stdinWrite`) and add a sibling test for `sendAnswer`:

```ts
it('sendAnswer writes a tool_result frame to stdin, not a plain text frame', async () => {
  // Adapt to this file's existing fake-spawner/fake-child pattern — find how
  // the existing send() test asserts on child.stdinWrite's captured argument
  // and mirror it exactly, just asserting the tool_result shape instead.
  // ... (existing test harness setup) ...
  await handle.sendAnswer('toolu_1', 'Yes');
  expect(capturedStdinWrites[0]).toContain('"type":"tool_result"');
  expect(capturedStdinWrites[0]).toContain('"tool_use_id":"toolu_1"');
});
```

Find `services.ts`'s existing `sendPrompt` test coverage (likely `daemon/test/services.test.ts`) and add:

```ts
it('sendPrompt with a toolUseId routes through submitAnswer / sendAnswer, not the plain-text path', async () => {
  // Build the same createServices() harness the existing sendPrompt tests use.
  // Take over a session (or use the existing owned-session test fixture),
  // then call services.sendPrompt({ sessionId, key, text: 'Yes', toolUseId: 'toolu_1', requestId, clientId }).
  // Assert: the record's toolUseId is set, and the fake sender's sendAnswer
  // (not send) was called with ('toolu_1', 'Yes').
});

it('getTranscript observes a newly-resolved askUserQuestion and marks the matching queued answer accepted', async () => {
  // Extend the existing getTranscript test harness: seed a transcript whose
  // tail.ts-parsed events include a resolved askUserQuestion for toolu_1,
  // submit a queued answer for toolu_1 first, call getTranscript(), then
  // assert the PromptRecord transitioned to 'accepted'.
});
```

Find `daemon/test/app.test.ts`'s existing `/api/sessions/:id/prompt` coverage and add a test asserting the route accepts an optional `toolUseId` in the body and threads it through to `deps.sendPrompt`.

Find the PWA's existing composer/answer-submission test (from Task 5 — `composer-gate.test.tsx` per its own test asserting `mockApi.sendPrompt` was called with `('s1', 'No', <key>)`) and extend it (or add a sibling test) asserting `onAnswerQuestion` now calls `api.sendPrompt(sessionId, label, key, toolUseId)` — i.e. the real `toolUseId`, not the discarded `_toolUseId` placeholder from Task 5.

- [ ] **Step 2: Run to verify failure**

Run the daemon and pwa test files touched above. Expected: FAIL — `sendAnswer`/`toolResultFrame`/`submitAnswer`/`observeAnswer` don't exist yet; `onAnswerQuestion`'s wiring still discards `toolUseId`.

- [ ] **Step 3: Implement — `prompt-sender.ts`**

```ts
/** A tool_result frame answering a pending AskUserQuestion — the mechanism
 * verified by architecture-spec.md §2's F16 finding. Same one-line-JSON
 * framing as userFrame(), just a tool_result content block instead of text. */
export function toolResultFrame(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

export interface PromptSender {
  readonly mode: 'readonly' | 'owned';
  send(prompt: string, signal?: AbortSignal): Promise<SendOutcome>;
  sendAnswer(toolUseId: string, label: string, signal?: AbortSignal): Promise<SendOutcome>;
}
```

- [ ] **Step 4: Implement — `session-manager.ts`**

In `makeHandle`, alongside the existing `send` method, add:

```ts
async sendAnswer(toolUseId: string, label: string, signal?: AbortSignal): Promise<SendOutcome> {
  if (!alive) {
    return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'session has exited', retryable: true };
  }
  if (signal?.aborted) {
    return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'aborted', retryable: true };
  }
  try {
    child.stdinWrite(toolResultFrame(toolUseId, label) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: String(err), retryable: true };
  }
},
```

(Add `toolResultFrame` to the existing `import { type PromptSender, type SendOutcome, userFrame } from './prompt-sender.js'` line, and re-export it the same way `userFrame` already is if any other file needs it — check first.)

- [ ] **Step 5: Implement — `prompt-lifecycle.ts`**

```ts
export interface PromptRecord {
  id: string;
  sessionId: string;
  text: string;
  toolUseId?: string;
  state: PromptStateName;
  sentAt: number;
  observedAt?: string;
}

// ... inside class PromptLifecycle ...

async submitAnswer(args: {
  key: string;
  sessionId: string;
  toolUseId: string;
  label: string;
  sender: PromptSender;
  nowMs: number;
}): Promise<PromptRecord> {
  const existing = this.byKey.get(args.key);
  if (existing) {
    if (existing.toolUseId !== args.toolUseId || existing.sessionId !== args.sessionId || existing.text !== args.label) {
      throw new ActionError('INVALID_INPUT', 'Idempotency-Key reused with a different answer');
    }
    return existing;
  }

  const rec: PromptRecord = {
    id: args.key,
    sessionId: args.sessionId,
    text: args.label,
    toolUseId: args.toolUseId,
    state: 'sending',
    sentAt: args.nowMs,
  };
  this.byKey.set(args.key, rec);

  const outcome = await args.sender.sendAnswer(args.toolUseId, args.label);
  rec.state = outcome.ok ? 'queued' : 'failed';
  return rec;
}

/** The tailer calls this when tail.ts reports a pending AskUserQuestion just
 * resolved — matches a queued ANSWER by session+toolUseId, never by text
 * (a plain-text observation would never fire for a tool_result frame, since
 * tail.ts's resolution path drops the blank tool_result-only user bubble
 * from the emitted event stream entirely — see tail.ts's resolveAskUserQuestions). */
observeAnswer(ev: { sessionId: string; toolUseId: string; atISO: string }): void {
  for (const rec of this.byKey.values()) {
    if (rec.state === 'queued' && rec.sessionId === ev.sessionId && rec.toolUseId === ev.toolUseId) {
      rec.state = 'accepted';
      rec.observedAt = ev.atISO;
      return;
    }
  }
}
```

- [ ] **Step 6: Implement — `services.ts`**

In `sendPrompt`, branch on whether `a.toolUseId` is present (keep the existing ownership/ForbiddenError/audit-record logic identical for both branches — only the lifecycle call and the audited `prompt` value differ):

```ts
async sendPrompt(a) {
  const sender = registry.get(a.sessionId);
  if (!sender) {
    audit.record({ sessionId: a.sessionId, mode: 'readonly', clientId: a.clientId, prompt: a.text, outcome: 'rejected', requestId: a.requestId, at: new Date().toISOString() });
    throw Object.assign(new Error('session is read-only until taken over'), { code: 'FORBIDDEN' });
  }
  const rec = a.toolUseId
    ? await lifecycle.submitAnswer({ key: a.key, sessionId: a.sessionId, toolUseId: a.toolUseId, label: a.text, sender, nowMs: Date.now() })
    : await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.text, sender, nowMs: Date.now() });
  audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.text, outcome: rec.state, requestId: a.requestId, at: new Date().toISOString() });
  return rec;
},
```

In `getTranscript`, alongside the existing `if (e.kind === 'user') lifecycle.observe(...)` line, add:

```ts
if (e.kind === 'askUserQuestion' && e.resolved) {
  lifecycle.observeAnswer({ sessionId: id, toolUseId: e.toolUseId, atISO: e.at });
}
```

Update `AppDeps.sendPrompt`'s type in `app.ts` (or wherever it's declared) to accept the optional `toolUseId`.

- [ ] **Step 7: Implement — `schemas/api.ts` and the route**

```ts
export const SendPromptBody = z.object({
  text: z.string().min(1).max(20000),
  toolUseId: z.string().max(200).optional(),
});
```

In `app.ts`'s `/api/sessions/:id/prompt` route, pass `toolUseId: parsed.data.toolUseId` through to `deps.sendPrompt(...)`.

- [ ] **Step 8: Implement — PWA `api.ts` and `App.tsx`**

```ts
// pwa/src/lib/api.ts
sendPrompt: async (id: string, text: string, idemKey: string, toolUseId?: string): Promise<PromptRecord> => {
  // ... existing fetch call, with body: JSON.stringify({ text, ...(toolUseId ? { toolUseId } : {}) }) ...
},
```

```ts
// pwa/src/App.tsx
const send = async (text: string, toolUseId?: string) => {
  if (!api || !selected) return;
  const sessionId = selected;
  const key = crypto.randomUUID();
  setStatus('sending');
  let rec;
  try {
    rec = await api.sendPrompt(sessionId, text, key, toolUseId);
  } catch {
    if (selectedRef.current === sessionId) setStatus('failed');
    return;
  }
  if (selectedRef.current === sessionId) setStatus(rec.state as PromptState);
  if (rec.state === 'queued') setPendingPrompt({ sessionId, text, key });
};
```

And change the `onAnswerQuestion` wiring from `(_toolUseId, label) => void send(label)` to `(toolUseId, label) => void send(label, toolUseId)`.

- [ ] **Step 9: Run to verify pass, full workspace gate, commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add daemon/src/lib/claude-adapter/prompt-sender.ts daemon/src/lib/claude-adapter/session-manager.ts daemon/src/domain/prompt-lifecycle.ts daemon/src/services/services.ts daemon/src/api/app.ts daemon/src/schemas/api.ts pwa/src/lib/api.ts pwa/src/App.tsx daemon/test/ pwa/test/
git commit -m "fix(askuserquestion): submit phone answers as a real tool_result frame, not plain text (spec §6 — closes the sticky-awaiting-input bug found in final review, verified empirically against a real session)"
```

- [ ] **Step 10: Re-verify against a real session (do this yourself, not a subagent — mirrors the empirical verification that found this bug)**

Repeat exactly the test that found this bug: get a real session to a pending `AskUserQuestion`, take it over (or resume it directly), submit an answer through the new `sendAnswer` path (either via a live PWA + daemon, or by directly exercising `services.sendPrompt` with a `toolUseId`), and confirm a `tool_result` now appears in the transcript matching the pending `tool_use_id`, and that `pendingQuestion`/`awaiting-input` correctly clears afterward. Record the outcome — this is the acceptance test for the whole fix, not optional.

---

## Post-plan checklist (not a task — final gate before manual testing / code review)

- [ ] Full quality gate: `cd microviber && npm run typecheck && npm run lint && npm test` — all green.
- [ ] Manual/real-session verification per story's Manual Test Checklist (before/after takeover repro, phone-side dot + expanded question, resolved-question highlight, non-question tool call unaffected).
- [ ] File a follow-up story for the push-dispatch subsystem gap noted in Task 4's Global Constraints — do not let it silently disappear.
- [ ] `microviber/docs/functional-spec.md` §3's composer-gating table reconciliation (idle/working/stale → +awaiting-input) is handled by `syncounter-code-review`'s "update functional-specs + architecture spec" step, not this plan — do not duplicate it here.

---

## Self-Review Notes

**Spec/AC coverage:**
- AC1 (spike + F16 row) → Task 1.
- AC2-5 (`pendingQuestion` detection) → Task 2.
- AC6 (bug repro before/after) → Task 3 Steps 1 and 6.
- AC7-9 (`awaiting-input` state, structural override ordering, takeover gate) → Task 3 Steps 4-5.
- AC10 (`NotifyPolicy` extension, no double-notify) → Task 4.
- AC11 (session-list dot) → Task 5 Step 4 (verify-or-add, since story microviber-track-b-6 may have already shipped it).
- AC12-13 (expanded pending / read-only resolved rendering) → Task 5 Steps 1 and 3.
- AC14 (composer no-shortcut mapping) → Task 5 Step 4.
- AC15 (gated answer submission) → Task 5 Step 6, explicitly conditioned on Task 1's outcome.

**Placeholder scan:** no TBD/TODO/"add appropriate handling" left in any step; all code blocks are concrete, taken from the feature plan's already-designed Tasks 17-21 and cross-checked against spec.md §6-§9 and architecture-spec.md §2's F-row format.

**Type consistency:** `SessionState`, `TranscriptMeta.pendingQuestion`, `SessionSummary.pendingQuestion`, `deriveState`'s `hasPendingQuestion` input, `NotifyPolicy`'s independent `State` type, and the PWA's `TranscriptEvent`/`SessionState` all use matching names and shapes across tasks (verified against the feature plan's own Interfaces blocks for Tasks 17-21).
