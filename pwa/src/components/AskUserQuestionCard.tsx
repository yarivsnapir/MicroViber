import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { promptDisplay, type PromptState } from '../lib/prompt-display.js';

type AskEvent = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;

/** The one answer the app currently has in flight, if any (App.tsx's shared prompt slot, kind 'answer'). */
export interface AnswerInFlight {
  toolUseId: string;
  status: PromptState;
  selections: string[][];
  /** Set only for a daemon INVALID_INPUT rejection (e.g. "question is no longer pending") — the
   * daemon's own message, shown verbatim with no Retry instead of the generic failed/showResend UI
   * (code-review Fix I1: a validation rejection is not a network failure). */
  rejection?: string;
}

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
      {mine && mine.rejection !== undefined && (
        <div className="mt-3 text-[12.5px] text-red-400">{mine.rejection}</div>
      )}
      {mine && mine.rejection === undefined && disp && (
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
