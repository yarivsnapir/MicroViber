import type { ReactElement } from 'react';
import type { TranscriptEvent } from '../lib/types.js';
import { SafeMarkdown } from '../lib/markdown.js';

/**
 * Matches the Claude Code VS Code extension: a flowing single column with
 * left-gutter markers (not chat bubbles), user prompts as bordered blocks,
 * tool calls collapsed to one line, thinking as a marker. Phone-injected
 * prompts stay visually distinct (the one deliberate departure — R5 guard).
 */
export function Transcript({ events }: { events: TranscriptEvent[] }): ReactElement {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-[14.5px] leading-relaxed">
      {events.map((e, i) => <EventRow key={i} e={e} />)}
    </div>
  );
}

function EventRow({ e }: { e: TranscriptEvent }): ReactElement {
  switch (e.kind) {
    case 'user':
      return (
        <div className={`rounded-md border px-3 py-2 text-[14px] ${e.injected ? 'border-amber-700/60 bg-amber-500/10 text-zinc-100' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>
          {e.injected && <span className="block text-[10.5px] font-bold uppercase tracking-wider text-amber-400 mb-1">From phone</span>}
          {e.text}
        </div>
      );
    case 'assistant':
      return <Gutter><div className="prose-invert"><SafeMarkdown>{e.text}</SafeMarkdown></div></Gutter>;
    case 'tool':
      return <Gutter><span className="font-mono text-[13px] text-zinc-400"><span className="text-zinc-500">▸ </span><span className="text-amber-400 font-semibold">{e.name}</span>{e.summary ? ` · ${e.summary}` : ''}</span></Gutter>;
    case 'thinking':
      return <Gutter><span className="italic text-zinc-500 text-[13px]">thinking…</span></Gutter>;
    case 'error':
      return <Gutter><span className="text-red-400 text-[13.5px]">{e.message}</span></Gutter>;
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
