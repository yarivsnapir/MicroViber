import type { ReactElement } from 'react';

/**
 * The one dropdown-trigger button style used identically by the session
 * picker header and the Web pane's address bar (spec §4/§3) — rounded
 * square, SVG chevron, amber when open. Keep this the single source of that
 * visual language; do not fork it per-caller.
 */
export function CaretButton({ open, onClick }: { open: boolean; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border transition-colors ${
        open ? 'border-amber-400 bg-amber-400 text-amber-950' : 'border-zinc-700 bg-zinc-800 text-zinc-200'
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
      </svg>
    </button>
  );
}
