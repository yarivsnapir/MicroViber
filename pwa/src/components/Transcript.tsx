import { useEffect, useRef, type ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { SafeMarkdown } from '../lib/markdown.js';

/**
 * Matches the Claude Code VS Code extension: a flowing single column with
 * left-gutter markers (not chat bubbles), user prompts as bordered blocks,
 * tool calls collapsed to one line, thinking as a marker. Phone-injected
 * prompts stay visually distinct (the one deliberate departure — R5 guard).
 */
export function Transcript({ events, sessionId, sessionCwd, onAnswerQuestion }: {
  events: TranscriptEvent[]; sessionId: string | null; sessionCwd: string;
  /** Only meaningful for a pending (unresolved) askUserQuestion event — see EventRow. */
  onAnswerQuestion?: ((toolUseId: string, label: string) => void) | undefined;
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
      {events.map((e, i) => <EventRow key={i} e={e} sessionCwd={sessionCwd} onAnswerQuestion={onAnswerQuestion} />)}
    </div>
  );
}

function EventRow({ e, sessionCwd, onAnswerQuestion }: {
  e: TranscriptEvent; sessionCwd: string; onAnswerQuestion?: ((toolUseId: string, label: string) => void) | undefined;
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
    case 'askUserQuestion': {
      // Interactive only for a pending question with a wired handler — the
      // handler is only passed down from App.tsx when the session is taken
      // over (mode === 'owned'), so this component doesn't need its own
      // notion of ownership (spec §6 answer-submission step).
      const clickable = !e.resolved && !!onAnswerQuestion;
      return (
        <div className="rounded-lg border border-fuchsia-700/50 bg-fuchsia-500/5 p-3">
          {e.questions.map((q, qi) => (
            <div key={qi} className="mb-2 last:mb-0">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-fuchsia-400">{q.header}</div>
              <div className="mb-2 text-[15px] text-zinc-100">{q.question}</div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((o, oi) => {
                  const isSelected = e.resolved && e.selectedLabels?.includes(o.label);
                  const cls = `rounded-full border px-3 py-1 text-[13px] ${isSelected ? 'border-amber-400 bg-amber-400/10 text-amber-300 font-semibold' : 'border-zinc-600 text-zinc-300'} ${e.resolved ? 'opacity-80' : ''}`;
                  const key = `${qi}-${oi}`;
                  const handler = onAnswerQuestion;
                  return clickable && handler ? (
                    <button key={key} type="button" aria-pressed={false} onClick={() => handler(e.toolUseId, o.label)} className={cls}>
                      {o.label}
                    </button>
                  ) : (
                    <span key={key} className={cls}>
                      {o.label}
                      {isSelected && <span className="sr-only"> (selected)</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      );
    }
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
