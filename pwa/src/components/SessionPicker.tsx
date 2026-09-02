import type { ReactElement } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { firstSentence } from '../lib/text.js';

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };
const RECENT_CAP = 5;

/**
 * A top-anchored dropdown panel (spec §4), not a bottom sheet — same
 * expand-directly-below metaphor as the Web pane's address bar dropdown.
 * Default view: Recent (flat, cross-folder, capped, sorted newest-prompt-first
 * — unchanged sort key from the original bottom-sheet picker).
 */
export function SessionPicker({ open, onOpenChange, sessions, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onPick: (id: string) => void;
}): ReactElement | null {
  if (!open) return null;

  const recent = [...sessions].sort((a, b) => (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '')).slice(0, RECENT_CAP);
  const folders = new Set(sessions.map((s) => s.folder));

  return (
    <div className="absolute inset-0 z-10" onClick={() => onOpenChange(false)}>
      <div className="absolute inset-x-3 top-[52px] max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Recent · {recent.length}</span>
          {folders.size > 1 && <span className="text-[12px] font-bold text-amber-400">Browse by folder ›</span>}
        </div>
        {recent.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} className="flex w-full items-start gap-3 border-t border-zinc-800 px-4 py-3 text-left">
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
  );
}
