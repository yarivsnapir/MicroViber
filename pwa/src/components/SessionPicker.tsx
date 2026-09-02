import { useState, type ReactElement } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { firstSentence } from '../lib/text.js';

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };
const RECENT_CAP = 5;

type View = { kind: 'recent' } | { kind: 'folders' } | { kind: 'folder'; folder: string };

/**
 * A top-anchored dropdown panel (spec §4), not a bottom sheet — same
 * expand-directly-below metaphor as the Web pane's address bar dropdown.
 * Default view: Recent (flat, cross-folder, capped, sorted newest-prompt-first
 * — unchanged sort key from the original bottom-sheet picker).
 * With internal state machine: 'recent' → 'folders' → 'folder: string' with back navigation.
 */
export function SessionPicker({ open, onOpenChange, sessions, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onPick: (id: string) => void;
}): ReactElement | null {
  const [view, setView] = useState<View>({ kind: 'recent' });
  if (!open) return null;

  const recent = [...sessions].sort((a, b) => (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '')).slice(0, RECENT_CAP);
  const folderNames = Array.from(new Set(sessions.map((s) => s.folder)));

  const pick = (id: string) => { onPick(id); setView({ kind: 'recent' }); };

  const Row = ({ s }: { s: SessionSummary }): ReactElement => (
    <button onClick={() => pick(s.id)} className="flex w-full items-start gap-3 border-t border-zinc-800 px-4 py-3 text-left">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-zinc-100">{s.title}</span>
        <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state} · {s.mode}</span>
        {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
      </span>
      {!s.writable && <span className="mt-0.5 shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-zinc-500">read-only</span>}
    </button>
  );

  let body: ReactElement;
  if (view.kind === 'recent') {
    body = (
      <>
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Recent · {recent.length}</span>
          {folderNames.length > 1 && (
            <button onClick={() => setView({ kind: 'folders' })} className="text-[12px] font-bold text-amber-400">Browse by folder ›</button>
          )}
        </div>
        {recent.map((s) => <Row key={s.id} s={s} />)}
      </>
    );
  } else if (view.kind === 'folders') {
    body = (
      <>
        <button onClick={() => setView({ kind: 'recent' })} className="block w-full border-b border-zinc-800 px-4 py-3 text-left text-[13px] text-zinc-400">‹ Recent</button>
        <div className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Projects · {folderNames.length}</div>
        {folderNames.map((folder) => {
          const inFolder = sessions.filter((s) => s.folder === folder);
          const dot = inFolder.some((s) => s.state === 'working') ? STATE_DOT.working
            : inFolder.some((s) => s.state === 'idle') ? STATE_DOT.idle
            : STATE_DOT.stale;
          return (
            <button key={folder} onClick={() => setView({ kind: 'folder', folder })} className="flex w-full items-center gap-3 border-t border-zinc-800 px-4 py-3.5 text-left">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-zinc-100">{folder}</span>
                <span className="block text-[12px] text-zinc-500">{inFolder.length} session{inFolder.length === 1 ? '' : 's'}</span>
              </span>
              <span className="text-zinc-600">›</span>
            </button>
          );
        })}
      </>
    );
  } else {
    const inFolder = sessions.filter((s) => s.folder === view.folder);
    body = (
      <>
        <button onClick={() => setView({ kind: 'folders' })} className="block w-full border-b border-zinc-800 px-4 py-3 text-left text-[13px] text-zinc-400">‹ Projects</button>
        <div className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">{view.folder} · {inFolder.length} session{inFolder.length === 1 ? '' : 's'}</div>
        {inFolder.map((s) => <Row key={s.id} s={s} />)}
      </>
    );
  }

  return (
    <div className="absolute inset-0 z-10" onClick={() => onOpenChange(false)}>
      <div className="absolute inset-x-3 top-[52px] max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
