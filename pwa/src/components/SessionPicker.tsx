import { useState, useEffect, type ReactElement } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { firstSentence } from '../lib/text.js';

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };
const RECENT_CAP = 10;

type View = { kind: 'recent' } | { kind: 'folders' } | { kind: 'folder'; folder: string };

// Hoisted to module scope (final whole-branch review, story
// microviber-track-b-6, Finding 4): as a function expression inside
// SessionPicker's body this was a fresh component TYPE every render, so React
// unmounted/remounted every row on each state change. App.tsx polls sessions
// every ~4s while the panel may be open, so this churn is real, not
// hypothetical — a tap whose `pointerdown` lands right before a poll can
// fail to produce a `click` because its DOM node got replaced underneath it.
function Row({ s, onPick }: { s: SessionSummary; onPick: (id: string) => void }): ReactElement {
  return (
    <button onClick={() => onPick(s.id)} className="flex w-full items-start gap-3 border-t border-zinc-800 px-4 py-3 text-left">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-zinc-100">{s.title}</span>
        <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state} · {s.mode}</span>
        {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
      </span>
      {!s.writable && <span className="mt-0.5 shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-zinc-500">read-only</span>}
    </button>
  );
}

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

  // Reset to the default Recent view whenever the panel transitions from
  // open to closed, by ANY path — scrim tap, caret re-tap, a future second
  // consumer — not just the `pick()` happy path below (final whole-branch
  // review, story microviber-track-b-6, Finding 3). Repro this fixes: open →
  // "Browse by folder" → close via scrim → reopen used to land back in the
  // folder list instead of Recent, violating AC #2's "default view".
  useEffect(() => { if (!open) setView({ kind: 'recent' }); }, [open]);

  if (!open) return null;

  const recent = [...sessions].sort((a, b) => (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '')).slice(0, RECENT_CAP);
  const folderNames = Array.from(new Set(sessions.map((s) => s.folder)));

  // Closes the panel itself (Finding 5) — `onPick` closing it too (App.tsx's
  // onPick handler also calls setPickerOpen(false)) is harmless, since
  // closing an already-closed picker is a no-op.
  const pick = (id: string) => { onPick(id); onOpenChange(false); setView({ kind: 'recent' }); };

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
        {recent.map((s) => <Row key={s.id} s={s} onPick={pick} />)}
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
        {inFolder.map((s) => <Row key={s.id} s={s} onPick={pick} />)}
      </>
    );
  }

  // Positioned against the `relative` wrapper App.tsx mounts this in
  // (everything below the session header — see App.tsx), NOT against
  // WebPane's own dropdown pattern this was originally copied from: that
  // wrapper's first child is a fixed-height address bar, so a hardcoded
  // `top-[52px]` there does not translate here — the session header's height
  // isn't fixed (it grows by up to two extra conditional lines), and a
  // hardcoded offset landed the panel on top of the header and the very
  // CaretButton that opened it (final whole-branch review, story
  // microviber-track-b-6, Finding 1). `inset-0`/`top-1` anchor to the
  // wrapper's own box instead, which always starts exactly below the header
  // regardless of its current height. `bg-black/55` restores the scrim dim
  // dropped in the dropdown rewrite (spec §4, Finding 2) — dims the
  // transcript/composer without covering the header above this box.
  return (
    <div className="absolute inset-0 z-10 bg-black/55" onClick={() => onOpenChange(false)}>
      {/* Flush with the header (inset-x-0, top-0, no top rounding): reads as
          the header extending downward, not a separate floating card
          (manual-test feedback — inset-x-3/top-1/rounded-xl on every corner
          made it look narrower than the header and detached from it). */}
      <div className="absolute inset-x-0 top-0 max-h-[70vh] overflow-y-auto rounded-b-xl border-x border-b border-zinc-700 bg-zinc-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
