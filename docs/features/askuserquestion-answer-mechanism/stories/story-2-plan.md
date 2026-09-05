# askuserquestion-answer-mechanism-2 — PWA Answer Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a phone user answer a pending `AskUserQuestion` on a taken-over session by picking radio/checkbox options and tapping one **Send answers** button, wired through the daemon's already-shipped `{ answer: { toolUseId, selections } }` API.

**Architecture:** A new `AskUserQuestionCard.tsx` (extracted from `Transcript.tsx`'s inline rendering) owns all card states from spec §7.1. `Transcript.tsx` delegates to it and gains `canAnswer`/`answerInFlight`/`onAnswer` props in place of the old `onAnswerQuestion`. `App.tsx`'s existing `pendingPrompt`/status-poll machinery becomes a discriminated union by `kind: 'text' | 'answer'` so one slot serves both the composer and the card. `api.ts` gains `postAnswer`; `sendPrompt` drops its now-rejected `toolUseId` parameter.

**Tech Stack:** Vite + React 19 + Tailwind 4 (PWA); vitest + @testing-library/react (jsdom) for tests. Daemon side (Tasks 1-5 of the parent plan) is already shipped — this plan touches PWA + docs only.

**Judge:** `docs/architecture-spec.md` §5 threat model (no change needed — no new endpoint/transport) + §6 engineering standards (layering fence: PWA never imports from `daemon/`; `pwa/src/lib/types.ts` stays a hand-maintained mirror).

**Spec:** `docs/features/askuserquestion-answer-mechanism/spec.md` §7 (PWA). **Parent plan:** `docs/features/askuserquestion-answer-mechanism/plan.md` Tasks 6-8 (superseded on one point — see below).

## Global Constraints

- **Testing gate:** `cd microviber && npm run typecheck && npm run lint && npm test` must be green before every commit. Fast iteration: `cd microviber/pwa && npx vitest run test/<file>.test.tsx`.
- **Layering fence:** PWA never imports from `daemon/` (FENCE 1); `pwa/src/lib/types.ts` is a hand-maintained mirror of the daemon's wire shapes — verified against the actual shipped daemon code below, not the parent plan's draft.
- **zod at every boundary; no `any`, no non-null assertions (`!`)** — matches the rest of this codebase.
- **Copy (verbatim, per parent plan's Global Constraints, still binding):** button label `Send answers`; hint `or type a reply below`; caption for resolved-without-labels `no longer pending`.
- **Commit style:** conventional, scoped (e.g. `feat(pwa): …`, `docs(…): …`); every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Branch:** `story/askuserquestion-answer-mechanism-2` (already checked out).

### ⚠ Design deviation from the parent plan — read before Task 1

The story's AC3 (amended 2026-09-04) requires the card's options to render as **radio buttons (single-select) or checkboxes (`multiSelect: true`)** — matching the VS Code chat extension's own `AskUserQuestion` rendering — showing **both the label and the description text**, explicitly **not** the "chips with `aria-pressed`" design that `plan.md`'s Task 6 (lines 1211-1524) and `spec.md`'s §7.1 table (line 157) still describe. Neither `plan.md` nor `spec.md` was actually updated when the issue was amended — confirmed by grep (no "Amended"/"radio"/"checkbox" text in `spec.md`) and `git log` (untouched since). This plan implements the amended (radio/checkbox) design as authoritative and includes a task to bring `spec.md` §7.1 in line with it, so the story's "see spec.md §7.1" pointer stops dangling.

Everything else in `plan.md` Tasks 6-8 not touching option rendering (types/api shapes, `AnswerInFlight`, the shared in-flight slot, Retry-with-fresh-key, doc pointers) is unaffected and is followed as written.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `pwa/src/lib/types.ts` | Modify | `askUserQuestion.resolvedBy?`, `questions[].multiSelect?`; `PromptRecord` drops `toolUseId`, gains `answerBody?` |
| `pwa/src/lib/api.ts` | Modify | `postAnswer`; `sendPrompt` loses `toolUseId` param |
| `pwa/src/components/AskUserQuestionCard.tsx` | Create | All §7.1 card states, radio/checkbox options with label + description |
| `pwa/src/components/Transcript.tsx` | Modify | Delegate `askUserQuestion` to the card; new props (`canAnswer`, `answerInFlight`, `onAnswer`) |
| `pwa/src/App.tsx` | Modify | In-flight slot by `kind`; `sendAnswer`; poll re-POSTs by kind; wiring to `Transcript`/`Composer` |
| `pwa/test/ask-user-question-card.test.tsx` | Create | Card states incl. radio/checkbox roles + description text |
| `pwa/test/transcript-askuserquestion.test.tsx` | Modify | Delegate wiring test; inert cases pass `canAnswer={false}` |
| `pwa/test/api.test.ts` | Modify | `postAnswer` request-shape test |
| `pwa/test/app-answer.test.tsx` | Create | End-to-end App wiring: pick → send → retry |
| `docs/architecture-spec.md` | Modify | F17 pointer; §3 module list; §4 `/prompt` row; §5 T11 note |
| `docs/functional-spec.md` | Modify | §3 Transcript view / Composer gating — radio/checkbox copy, not chips |
| `docs/features/askuserquestion-answer-mechanism/spec.md` | Modify | §7.1 table amended to radio/checkbox (closes the dangling pointer) |
| `docs/features/microviber-track-b/stories/story-8.md` | Modify | AC15 pointer |
| `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md` | Modify | Outcome pointer |

---

### Task 1: PWA types, `postAnswer`, and `AskUserQuestionCard` (radio/checkbox design)

**Files:**
- Modify: `pwa/src/lib/types.ts:22-34`
- Modify: `pwa/src/lib/api.ts:27-36`
- Create: `pwa/src/components/AskUserQuestionCard.tsx`
- Modify: `pwa/src/components/Transcript.tsx` (whole file — see Step 6)
- Test: `pwa/test/ask-user-question-card.test.tsx` (new), `pwa/test/transcript-askuserquestion.test.tsx`, `pwa/test/api.test.ts`

**Interfaces:**
- Consumes: daemon's already-shipped wire shape — `AnswerBody = { toolUseId: string; selections: string[][] }` (`daemon/src/schemas/api.ts:34-38`), `PromptRecord` with `answerBody?: string` and no `toolUseId` (`daemon/src/domain/prompt-lifecycle.ts:5-11`), `TranscriptEvent`'s `askUserQuestion` variant with `resolvedBy?: 'tool_result' | 'text'` (`daemon/src/lib/claude-adapter/tail.ts:12-19`), `AskUserQuestionInputSchema` with `multiSelect: z.boolean().optional()` (`daemon/src/lib/claude-adapter/schemas.ts:55-71`).
- Produces (used by Task 2):
  ```ts
  // AskUserQuestionCard.tsx
  export interface AnswerInFlight { toolUseId: string; status: PromptState; selections: string[][] }
  export function AskUserQuestionCard(props: {
    e: Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    canAnswer: boolean;
    inFlight: AnswerInFlight | null;
    onAnswer?: (toolUseId: string, selections: string[][]) => void;
  }): ReactElement
  // Transcript.tsx
  <Transcript events sessionId sessionCwd canAnswer={boolean} answerInFlight={AnswerInFlight | null} onAnswer={(toolUseId, selections) => void} />
  // api.ts
  postAnswer(id: string, toolUseId: string, selections: string[][], idemKey: string): Promise<PromptRecord>
  sendPrompt(id: string, text: string, idemKey: string): Promise<PromptRecord>   // toolUseId param removed
  ```

- [ ] **Step 1: Write the failing card tests**

Create `pwa/test/ask-user-question-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AskUserQuestionCard } from '../src/components/AskUserQuestionCard.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);
type Ask = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
const one: Ask = {
  kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1', resolved: false,
  questions: [{ question: 'Proceed?', header: 'Confirm', options: [
    { label: 'Yes', description: 'Continue with the plan as written' },
    { label: 'No', description: 'Stop and let me revise it' },
  ] }],
};
const two: Ask = { ...one, questions: [...one.questions, {
  question: 'Which parts?', header: 'Scope', multiSelect: true,
  options: [{ label: 'Frontend', description: 'UI code only' }, { label: 'Backend', description: 'Server code only' }],
}] };

describe('AskUserQuestionCard (spec §7.1, amended 2026-09-04: radio/checkbox, not chips)', () => {
  it('not taken over: options are inert, no Send button', () => {
    render(<AskUserQuestionCard e={one} canAnswer={false} inFlight={null} />);
    expect(screen.queryByRole('radio', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('uses radio inputs for single-select questions and checkboxes for multiSelect questions (AC3)', () => {
    render(<AskUserQuestionCard e={two} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'No' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Frontend' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Backend' })).toBeInTheDocument();
  });

  it("shows each option's label AND its description text (AC3)", () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Continue with the plan as written')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('Stop and let me revise it')).toBeInTheDocument();
  });

  it('taken over: options are selectable, Send answers is disabled until every question has a pick, then submits selections in question order', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={two} canAnswer inFlight={null} onAnswer={onAnswer} />);
    const send = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Frontend' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Backend' })); // multiSelect: both stay checked
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No'], ['Frontend', 'Backend']]);
  });

  it('single-select: picking a second radio unchecks the first', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
    expect(screen.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'No' })).toBeChecked();
  });

  it('shows the free-text hint while answerable', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByText('or type a reply below')).toBeInTheDocument();
  });

  it('in flight: options lock (read-only), status text shows, Send is gone', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'queued', selections: [['No']] }} onAnswer={() => {}} />);
    expect(screen.queryByRole('radio', { name: 'Yes' })).toBeNull();
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
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
  });

  it('resolved with labels: dimmed, selected highlighted, nothing interactive even when answerable', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text', selectedLabels: ['Yes'] }} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.queryByRole('radio')).toBeNull();
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

- [ ] **Step 2: Run to verify they fail**

Run: `cd microviber/pwa && npx vitest run test/ask-user-question-card.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/AskUserQuestionCard.js'`.

- [ ] **Step 3: Update `types.ts` and `api.ts`**

`pwa/src/lib/types.ts` — replace the `askUserQuestion` variant (line 28-29) and `PromptRecord` (lines 31-34):

```ts
export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean;
      /** SYNC daemon tail.ts: present iff resolved — 'tool_result' (laptop stub) | 'text' (later human turn, incl. free text and the interruption marker). */
      resolvedBy?: 'tool_result' | 'text';
      selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean }[] };

export type PromptStateName = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';
export interface PromptRecord {
  id: string; sessionId: string; text: string; answerBody?: string; state: PromptStateName; sentAt: number; observedAt?: string;
}
```

`pwa/src/lib/api.ts` — replace `sendPrompt` (lines 27-36) and add `postAnswer` right after it:

```ts
    sendPrompt: async (id: string, text: string, idemKey: string): Promise<PromptRecord> => {
      const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify({ text }),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
      return body.data as PromptRecord;
    },
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

- [ ] **Step 4: Create the card (radio/checkbox design, AC3)**

`pwa/src/components/AskUserQuestionCard.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { promptDisplay, type PromptState } from '../lib/prompt-display.js';

type AskEvent = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;

/** The one answer the app currently has in flight, if any (App.tsx's shared prompt slot, kind 'answer'). */
export interface AnswerInFlight { toolUseId: string; status: PromptState; selections: string[][] }

const LABEL = 'text-[14px] text-zinc-100';
const LABEL_ON = 'text-amber-300 font-semibold';
const DESCRIPTION = 'text-[12px] text-zinc-500';
const CONTROL = 'mt-0.5 h-4 w-4 shrink-0 accent-amber-400';

/**
 * Spec askuserquestion-answer-mechanism §7.1 (amended 2026-09-04). Options
 * render as real radio inputs (single-select) or checkboxes (multiSelect),
 * matching the VS Code chat extension's own AskUserQuestion UI — not chips —
 * each showing its label AND its description. One "Send answers" button
 * once every question has a pick; the composer stays the free-text path.
 * Interactive only for a pending question on a taken-over session
 * (canAnswer) with a handler, and only when no answer for THIS question is
 * already in flight.
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
      {e.questions.map((q, qi) => {
        const multi = q.multiSelect === true;
        const groupName = `${e.toolUseId}-q${qi}`;
        return (
          <div key={qi} className="mb-3 last:mb-0">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-fuchsia-400">{q.header}</div>
            <div className="mb-2 text-[15px] text-zinc-100">{q.question}</div>
            <div className="flex flex-col gap-2">
              {q.options.map((o, oi) => {
                const on = isOn(qi, o.label);
                const id = `${groupName}-o${oi}`;
                const labelCls = `${LABEL} ${on ? LABEL_ON : ''}`;
                return (
                  <div key={id} className="flex items-start gap-2">
                    {interactive && (
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        id={id}
                        name={multi ? undefined : groupName}
                        checked={on}
                        onChange={() => toggle(qi, o.label, multi)}
                        className={CONTROL}
                      />
                    )}
                    <div>
                      {interactive ? (
                        <label htmlFor={id} className={labelCls}>{o.label}</label>
                      ) : (
                        <span className={labelCls}>{o.label}</span>
                      )}
                      {o.description && <div className={DESCRIPTION}>{o.description}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
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

- [ ] **Step 5: Run to verify the card tests pass**

Run: `cd microviber/pwa && npx vitest run test/ask-user-question-card.test.tsx`
Expected: PASS (all).

- [ ] **Step 6: Update `Transcript.tsx` to delegate, and its tests**

Replace the whole file `pwa/src/components/Transcript.tsx`:

```tsx
import { useEffect, useRef, type ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { SafeMarkdown } from '../lib/markdown.js';
import { AskUserQuestionCard, type AnswerInFlight } from './AskUserQuestionCard.js';

/**
 * Matches the Claude Code VS Code extension: a flowing single column with
 * left-gutter markers (not chat bubbles), user prompts as bordered blocks,
 * tool calls collapsed to one line, thinking as a marker. Phone-injected
 * prompts stay visually distinct (the one deliberate departure — R5 guard).
 */
export function Transcript({ events, sessionId, sessionCwd, canAnswer, answerInFlight, onAnswer }: {
  events: TranscriptEvent[]; sessionId: string | null; sessionCwd: string;
  /** True only when the session is taken over (mode === 'owned') — the card never decides ownership itself. */
  canAnswer: boolean;
  answerInFlight: AnswerInFlight | null;
  onAnswer?: ((toolUseId: string, selections: string[][]) => void) | undefined;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  // Scroll to the bottom once, the first time a newly-picked session's
  // transcript actually loads (events arrive async after the id changes) —
  // not on every later poll, so it doesn't yank the user back down while
  // they're reading up-thread.
  const pendingRef = useRef<string | null>(null);

  useEffect(() => { pendingRef.current = sessionId; }, [sessionId]);

  useEffect(() => {
    if (pendingRef.current === sessionId && events.length > 0 && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
      pendingRef.current = null;
    }
  }, [events, sessionId]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-[16.5px] leading-relaxed">
      {events.map((e, i) => <EventRow key={i} e={e} sessionCwd={sessionCwd} canAnswer={canAnswer} answerInFlight={answerInFlight} onAnswer={onAnswer} />)}
    </div>
  );
}

function EventRow({ e, sessionCwd, canAnswer, answerInFlight, onAnswer }: {
  e: TranscriptEvent; sessionCwd: string;
  canAnswer: boolean;
  answerInFlight: AnswerInFlight | null;
  onAnswer?: ((toolUseId: string, selections: string[][]) => void) | undefined;
}): ReactElement {
  switch (e.kind) {
    case 'user':
      return (
        <div className={`rounded-md border px-3 py-2 text-[16px] ${e.injected ? 'border-amber-700/60 bg-amber-500/10 text-zinc-100' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>
          {e.injected && <span className="block text-[10.5px] font-bold uppercase tracking-wider text-amber-400 mb-1">From phone</span>}
          {e.text}
        </div>
      );
    case 'assistant':
      return <Gutter><div className="text-[16.5px]"><SafeMarkdown sessionCwd={sessionCwd}>{e.text}</SafeMarkdown></div></Gutter>;
    case 'tool':
      return <Gutter><span className="font-mono text-[14.5px] text-zinc-400"><span className="text-zinc-500">▸ </span><span className="text-amber-400 font-semibold">{e.name}</span>{e.summary ? ` · ${e.summary}` : ''}</span></Gutter>;
    case 'thinking':
      return <Gutter><span className="italic text-zinc-500 text-[14.5px]">thinking…</span></Gutter>;
    case 'error':
      return <Gutter><span className="text-red-400 text-[15px]">{e.message}</span></Gutter>;
    case 'askUserQuestion':
      return <AskUserQuestionCard e={e} canAnswer={canAnswer} inFlight={answerInFlight} onAnswer={onAnswer} />;
  }
}

function Gutter({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="flex gap-2 items-start">
      <span className="text-zinc-600 text-[9.5px] leading-[1.9] shrink-0">●</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
```

In `pwa/test/transcript-askuserquestion.test.tsx`, delete the two tests that pass `onAnswerQuestion` (`'a resolved question renders its options as inert…'` and `'a pending question renders clickable options when onAnswerQuestion is provided…'`), replace with:

```tsx
  it('delegates to AskUserQuestionCard: canAnswer + onAnswer make a pending question interactive and Send answers submits', () => {
    const onAnswer = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={onAnswer} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
  });
```

and add `canAnswer={false} answerInFlight={null}` to every remaining `<Transcript …>` render in that file (the inert-case tests at lines 9-16, 18-24, 26-35, and the now-renamed `'a pending question renders inert options when onAnswerQuestion is absent'` — rename that last one to `'a pending question renders inert options when canAnswer is false'` and drop the now-nonexistent `onAnswerQuestion` reference from its body, keeping the `queryByRole('radio', { name: 'No' })` assertion instead of `'button'`).

In `pwa/test/api.test.ts`, add a new `describe` block after the existing `api.handback` one:

```ts
describe('api.postAnswer (askuserquestion-answer-mechanism-2)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs {answer:{toolUseId,selections}} to /prompt with the idempotency key and bearer header', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'k', sessionId: 's', text: 'x', state: 'queued', sentAt: 0 } }) });
    const api = createApi('http://x.test', 'tok-123');
    const result = await api.postAnswer('s', 't1', [['Yes']], 'k');
    expect(result.state).toBe('queued');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/sessions/s/prompt');
    expect(JSON.parse(String(init.body))).toEqual({ answer: { toolUseId: 't1', selections: [['Yes']] } });
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('k');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });
});
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd microviber/pwa && npx vitest run test/ask-user-question-card.test.tsx test/transcript-askuserquestion.test.tsx test/api.test.ts`
Expected: PASS. (`App.tsx` will fail typecheck until Task 2 — do NOT run the full gate yet.)

- [ ] **Step 8: Commit (PWA typecheck intentionally deferred to Task 2 — note it in the message)**

```bash
git add pwa/src/lib/types.ts pwa/src/lib/api.ts pwa/src/components/AskUserQuestionCard.tsx pwa/src/components/Transcript.tsx pwa/test/ask-user-question-card.test.tsx pwa/test/transcript-askuserquestion.test.tsx pwa/test/api.test.ts
git commit -m "feat(pwa): AskUserQuestionCard with radio/checkbox options + Send answers (AC3 amendment); postAnswer client (App wiring follows)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: App wiring — shared in-flight slot by kind, `sendAnswer`, poll, Retry with a fresh key

**Files:**
- Modify: `pwa/src/App.tsx` (`pendingPrompt` state at line 40; poll effect at lines 81-97; `send` at lines 143-161; JSX at lines 216-234 and the `onPick`/`takeoverSession` reset call sites)
- Test: `pwa/test/app-answer.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's `postAnswer`, `AnswerInFlight`, `Transcript`'s new props.
- Produces: nothing downstream (final task before docs).

- [ ] **Step 1: Write the failing test**

Create `pwa/test/app-answer.test.tsx` (same mock scaffolding as `composer-gate.test.tsx`):

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

  it('picking an option then Send answers calls postAnswer with the toolUseId, selections, and a fresh key; the card shows the queued state', async () => {
    mockApi.postAnswer.mockResolvedValue({ id: 'k', sessionId: 's1', text: 'x', state: 'queued', sentAt: 0 });
    render(<App />);
    fireEvent.click(await screen.findByRole('radio', { name: 'No' }));
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
    fireEvent.click(await screen.findByRole('radio', { name: 'No' }));
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
Expected: FAIL — no `Send answers` button (`App` passes no `canAnswer` to `Transcript` yet; typecheck errors on the new required props).

- [ ] **Step 3: Wire `App.tsx`**

Replace the `pendingPrompt` state declaration (line 40) with:

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

In the poll effect (lines 81-97), replace the `api.sendPrompt(pendingPrompt.sessionId, pendingPrompt.text, pendingPrompt.key)` call with:

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

Replace `send` (lines 143-161) with:

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

Derive, just before the `return (` (after `togglePicker`):

```tsx
  const answerInFlight = status && statusKind?.kind === 'answer' && status !== 'accepted'
    ? { toolUseId: statusKind.toolUseId, status, selections: statusKind.selections }
    : null;
  const composerStatus = statusKind?.kind === 'text' ? status : null;
```

Update the two JSX call sites (lines 216-234) — delete the story-8 `{/* onAnswerQuestion stays undefined … */}` comment block and replace the `Transcript`/`Composer` render with:

```tsx
            {sessions.length === 0 ? <EmptyState onRefresh={() => void refresh()} />
              : loadingTranscript && events.length === 0 ? <TranscriptLoading />
              : <Transcript events={events} sessionId={selected} sessionCwd={current?.cwd ?? ''}
                  canAnswer={current?.mode === 'owned' && current.writable === true}
                  answerInFlight={answerInFlight}
                  onAnswer={(toolUseId, selections) => void sendAnswer(toolUseId, selections)} />}

            {current && current.writable && current.mode === 'owned' && (
              <Composer mode={current.mode} status={composerStatus} onSend={(t) => void send(t)}
                onHandback={() => void handbackSession()} handingBack={handingBack} />
            )}
```

Everywhere `setStatus(null); setPendingPrompt(null);` appears (`takeoverSession` at line 115, `onPick` at line 258), add `setStatusKind(null);` right after.

- [ ] **Step 4: Run to verify it passes, then full gate**

Run: `cd microviber/pwa && npx vitest run test/app-answer.test.tsx test/composer-gate.test.tsx`
Expected: PASS.
Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green (this is where the PWA typecheck deferred from Task 1 must go green).

- [ ] **Step 5: Commit**

```bash
git add pwa/src/App.tsx pwa/test/app-answer.test.tsx
git commit -m "feat(pwa): wire Send answers through a shared in-flight slot; Retry uses a fresh Idempotency-Key

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Documentation — close the dangling spec.md §7.1 pointer, plus the parent plan's pointers

**Files:**
- Modify: `docs/architecture-spec.md` (§2 F17 pointer; §3 `lib/claude-adapter/` list — already present from story-1, verify only; §4 API table `/prompt` row; §5 T11 row)
- Modify: `docs/functional-spec.md` §3 (Transcript view; Composer gating on idle)
- Modify: `docs/features/askuserquestion-answer-mechanism/spec.md` §7.1 (the actual amendment the story's AC3 points to)
- Modify: `docs/features/microviber-track-b/stories/story-8.md` (AC15 note pointer)
- Modify: `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md` (Outcome line)

**Interfaces:** none — docs only, no test.

- [ ] **Step 1: Fix `spec.md` §7.1 — this is the amendment the story's AC3 claims already exists**

Replace the "Pending, taken over" table row (currently line 157):

```markdown
| Pending, taken over (`mode === 'owned'`) | **Amended 2026-09-04** (supersedes the original "chips with `aria-pressed`" design): options render as radio buttons (single-select per question) or checkboxes (`multiSelect: true`), matching the VS Code chat extension's own `AskUserQuestion` rendering — each option shows its label AND its `description` text. A **Send answers** button sits at the card's bottom-right, enabled only once every question has ≥ 1 selection. Below it, one quiet line: *or type a reply below*. | Pick radio/checkbox options; tap **Send answers** once |
```

And in the "Sending" row (currently line 158), change `Chips lock;` to `Options lock (read-only);`.

- [ ] **Step 2: `docs/architecture-spec.md`**

Verify the F17 row already carries the "Resolved by the AskUserQuestion answer mechanism…" pointer and §3's `lib/claude-adapter/` list already has `ask-user-question.ts` (both landed in story-1/PR #33 — `grep -n "ask-user-question.ts\|Resolved by the AskUserQuestion" docs/architecture-spec.md` should find both). If either is missing, add it verbatim from `plan.md` lines 1727-1736.

In §4's API table, replace the `/api/sessions/:id/prompt` row's purpose with (if not already present from story-1):

```markdown
| `/api/sessions/:id/prompt` | POST | bearer | Send a user turn. **Requires `Idempotency-Key` header** — 400 `INVALID_INPUT` if absent. Body is exactly one of `{ text }` (a plain prompt) or `{ answer: { toolUseId, selections: string[][] } }` (an answer to the currently pending `AskUserQuestion`; the daemon validates it against that question — 400 `INVALID_INPUT` `question is no longer pending` / `answer must cover every question` / `question <header> accepts one option` / `unknown option for <header>` — composes the text `Answering your question(s):` + one `- <header>: <labels>` line per question, and sends it as a plain user turn; a same-key replay is matched on the canonical answer body before any re-validation). Delegates to `sendPrompt`, which throws a typed `FORBIDDEN` error for a session that has not been taken over — **HTTP 403**, no `PromptRecord` persisted, still audited. Success returns `{success:true, data:<PromptStatus>}`. |
```

In §5's T11 row, verify the "Narrowed (askuserquestion-answer-mechanism, …)" note landed in story-1; if not, append it verbatim from `plan.md` line 1744, using `2026-09-05` for `<DATE>`.

- [ ] **Step 3: `docs/functional-spec.md` §3**

Under **Transcript view**, after the last `**Changed**` entry, add (radio/checkbox copy, not chips):

```markdown
**Changed (2026-09-05, askuserquestion-answer-mechanism):** a pending `AskUserQuestion` on a
**taken-over** session is answerable in place: its options render as radio buttons (one per
question) or checkboxes (when the question allows multi-select), each showing its label and
description, and a single **Send answers** button, enabled once every question has a pick,
sends all answers as one message. The card shows the same sending / waiting / failed-with-Retry
states as a normal prompt and never shows the question as answered until the message is seen
in the transcript. Once answered — from the phone, from the composer as free text, or on the
laptop — the card dims with the chosen options highlighted (or a neutral "no longer pending"
caption when no option can be matched). Before takeover the options stay inert and the bottom
bar's **Take over** is the only action. Right after takeover the transcript may show Claude's
short "No response requested." reply to its own resume handshake; that is real transcript
content and is not hidden.
```

Under **Composer gating on idle**, add:

```markdown
**Changed (2026-09-05, askuserquestion-answer-mechanism):** while a question is pending on a
taken-over session the composer stays available and is the free-text ("Other") path — any
message typed there is a real reply and closes the question.
```

- [ ] **Step 4: Pointers**

`docs/features/microviber-track-b/stories/story-8.md`, at the end of the "AC15 resolution note" paragraph, append (if not already present from story-1): ` **Follow-up shipped as `docs/features/askuserquestion-answer-mechanism/` (F18).**`

`docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md`, directly under the `**Status:**` line, add (if not already present from story-1): `**Outcome (2026-09-03):** brainstormed — see [`../askuserquestion-answer-mechanism/spec.md`](../askuserquestion-answer-mechanism/spec.md). The §6 hybrid was adopted with transcript-derived resolution instead of daemon-side state; F18 records that the handshake is conditional and that `AskUserQuestion` is disabled in `-p`.`

- [ ] **Step 5: Full gate and commit**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: green.

```bash
git add docs
git commit -m "docs(askuserquestion-answer-mechanism): amend spec.md §7.1 to radio/checkbox (closes AC3's pointer); functional-spec Changed entries; verify architecture-spec pointers from story-1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Manual verification (real session — not automatable, recorded in the story's checklist)**

1. Start the daemon (`daemon/`, per `INSTALL.md`; see the MicroViber daemon-ops memory: `pgrep` before restarting, pidfile can be stale). Open the PWA on the phone.
2. In a laptop Claude Code session, get the model to call `AskUserQuestion` (e.g. "Ask me with AskUserQuestion whether to proceed, options Yes/No"). Confirm the phone lists the session as `awaiting-input` (fuchsia dot) and renders the question inert.
3. Tap **Take over**. Confirm the transcript soon shows the model's "No response requested." turn and the card becomes interactive with radio buttons.
4. Pick an option, tap **Send answers**. Confirm: status goes waiting → clears; the user turn `Answering your question:` appears; the model's next reply acts on the answer; the card dims with the chosen option highlighted; the session state leaves `awaiting-input`.
5. **Restart the daemon and reload the PWA.** Confirm the card is still resolved and the state is not `awaiting-input`.
6. Repeat 2-3 on a fresh question, then answer by typing free text in the composer. Confirm the card dims with "no longer pending" and the model acts on the text.
7. Repeat 2-3, then answer **on the laptop** (`/resume` the session there if needed). Confirm the phone's card resolves with the laptop's pick highlighted (clause a).
8. Multi-question: get the model to ask two questions in one call (one multi-select). Confirm Send answers stays disabled until both have picks, checkboxes allow multiple picks on the multi-select question, and the composed message lists both lines.
9. Kill the daemon mid-send to force `failed` — confirm selections stay highlighted, **Retry** appears; restart daemon; confirm Retry succeeds under a new key (check the audit log shows two distinct request ids).

---

## Self-Review

**Spec coverage.** AC1 (card + Transcript delegation) → Task 1. AC2 (not-taken-over inert) → Task 1 card test 1. AC3 (radio/checkbox, label+description, amended design) → Task 1 card + the spec.md fix in Task 3 Step 1. AC4 (in-flight lock, promptDisplay states, Retry) → Task 1 card tests 7-8 + Task 2. AC5 (resolved with/without labels) → Task 1 card tests 9-10. AC6 (types.ts/api.ts mirror) → Task 1 Step 3. AC7 (in-flight slot union by kind) → Task 2. AC8 (fresh key per sendAnswer/Retry call) → Task 2. AC9 (`canAnswer` derivation, composer stays usable) → Task 2 Step 3. AC10 (slot clears on session switch/takeover) → Task 2 Step 3 (`setStatusKind(null)` at both reset sites). AC11 (docs Changed entries + pointers) → Task 3.

**Placeholder scan.** No TBD/TODO; the only intentionally-reused parent-plan text is in Task 3's "verify already present from story-1" steps, each with an exact grep/line pointer to confirm before acting.

**Type consistency.** `AnswerInFlight { toolUseId, status, selections }`, `AskUserQuestionCard` props, and `postAnswer(id, toolUseId, selections, idemKey)` match between Task 1 and Task 2. `InFlight` union's `kind: 'text' | 'answer'` and `statusKind` match the `Transcript` props (`canAnswer`, `answerInFlight`, `onAnswer`) defined in Task 1.
