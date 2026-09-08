import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';
import { DiffView } from './DiffView.js';

/** Tools whose input describes a file edit the extension renders as a diff. */
function diffOf(e: Extract<TranscriptEvent, { kind: 'tool' }>): { oldText: string; newText: string } | null {
  const { old_string: oldS, new_string: newS, content } = e.input;
  if (typeof oldS === 'string' && typeof newS === 'string') return { oldText: oldS, newText: newS };
  // A Write replaces the whole file: everything is an addition.
  if (e.name === 'Write' && typeof content === 'string') return { oldText: '', newText: content };
  return null;
}

/**
 * The extension's collapsed tool line, expandable on tap — finally
 * implementing functional-spec.md's long-standing promise (story-1 AC18).
 * Input is rendered as plain text inside <pre>, never as markdown or HTML: it
 * is arbitrary model output (T7/T11), and it is displayed, never acted on.
 *
 * An Edit-shaped input additionally renders a red/green diff ABOVE the
 * key/value list (AC20). The list keeps EVERY field, `old_string` and
 * `new_string` included: a payload capped by the daemon would otherwise be
 * undiagnosable, and a MultiEdit's `edits` array or a TodoWrite's todos only
 * ever appear there (AC23).
 */
export function ToolCall({ e }: { e: Extract<TranscriptEvent, { kind: 'tool' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(e.input);
  const diff = diffOf(e);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left font-mono text-[14.5px] text-zinc-400"
      >
        <span className="text-zinc-500">{open ? '▾ ' : '▸ '}</span>
        <span className="text-amber-400 font-semibold">{e.name}</span>
        {e.summary ? ` · ${e.summary}` : ''}
      </button>
      {open && (
        <div className="mt-1 rounded border border-zinc-800 bg-zinc-900/60 p-2 overflow-x-auto">
          {diff && <DiffView oldText={diff.oldText} newText={diff.newText} />}
          {entries.length === 0 && <div className="text-[13px] text-zinc-500">no input</div>}
          {entries.map(([k, v]) => (
            <div key={k} className="text-[13px]">
              <span className="text-zinc-500">{k}: </span>
              <pre className="inline whitespace-pre-wrap font-mono text-zinc-300">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </pre>
            </div>
          ))}
          {e.truncated && <div className="mt-1 text-[12px] text-amber-500">payload truncated</div>}
        </div>
      )}
    </div>
  );
}
