import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * functional-spec.md: "Thinking renders as a marker, not a wall of text." The
 * marker stays the default; the text is now available on tap, which it never
 * was before — the event carried no text at all (story-1 AC9/AC19). Plain
 * text, never markdown and never HTML (T7/T11).
 */
export function Thinking({ e }: { e: Extract<TranscriptEvent, { kind: 'thinking' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="italic text-zinc-500 text-[14.5px] text-left">
        {open ? '▾ ' : '▸ '}thinking…
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-zinc-800 pl-2 italic whitespace-pre-wrap text-[14px] text-zinc-500">
          {e.text}
        </div>
      )}
    </div>
  );
}
