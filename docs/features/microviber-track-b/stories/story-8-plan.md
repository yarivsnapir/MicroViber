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
