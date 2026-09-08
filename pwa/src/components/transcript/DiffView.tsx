import type { ReactElement } from 'react';
import { lineDiff } from '../../lib/diff.js';

const TONE = {
  ctx: 'text-zinc-500',
  del: 'bg-red-950/40 text-red-300',
  add: 'bg-emerald-950/40 text-emerald-300',
} as const;

const SIGIL = { ctx: '  ', del: '- ', add: '+ ' } as const;

/**
 * Inline red/green diff, matching how the extension shows a file edit
 * (story-1 AC20). `overflow-x-auto` on the <pre> is load bearing: a long
 * edited line must scroll INSIDE this box, never scroll the whole transcript
 * sideways (AC22). Diff text is arbitrary model output — plain children of a
 * <pre>, never markdown, never HTML (T7/T11).
 */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }): ReactElement {
  const lines = lineDiff(oldText, newText);
  return (
    <pre className="mt-1 overflow-x-auto rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[12.5px] leading-snug">
      {lines.map((l, i) => (
        <div key={`${i}:${l.type}`} className={TONE[l.type]}>
          {SIGIL[l.type]}
          {l.text}
        </div>
      ))}
    </pre>
  );
}
