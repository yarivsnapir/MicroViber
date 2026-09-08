import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

/**
 * The extension's collapsed tool line, expandable on tap — finally
 * implementing functional-spec.md's long-standing promise (story-1 AC18).
 * Input is rendered as plain text inside <pre>, never as markdown or HTML: it
 * is arbitrary model output (T7/T11), and it is displayed, never acted on.
 */
export function ToolCall({ e }: { e: Extract<TranscriptEvent, { kind: 'tool' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(e.input);

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
