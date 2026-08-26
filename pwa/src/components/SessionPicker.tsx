import type { ReactElement } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { firstSentence } from '../lib/text.js';

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };

/** A sheet, not a tab strip (spec §7). Sorted newest-prompt-first by the daemon. */
export function SessionPicker({ sessions, onPick, onClose }: {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end bg-black/55" onClick={onClose}>
      <div className="rounded-t-2xl border-t border-zinc-700 bg-zinc-900 pb-3 pt-2" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto my-2 h-1 w-9 rounded-full bg-zinc-700" />
        <div className="px-4 pb-2">
          <span className="text-[12px] font-bold uppercase tracking-wider text-zinc-500">Live sessions · {sessions.length}</span>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {sessions.map((s) => (
            <button key={s.id} onClick={() => onPick(s.id)} className="flex w-full items-start gap-3 border-b border-zinc-800 px-4 py-3 text-left">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-zinc-100">{s.title}</span>
                <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state} · {s.mode}</span>
                {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
              </span>
              {!s.writable && <span className="mt-0.5 shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-zinc-500">read-only</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
