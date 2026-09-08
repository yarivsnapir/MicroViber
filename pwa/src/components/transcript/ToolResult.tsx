import { useState, type ReactElement } from 'react';
import type { TranscriptEvent } from '../../lib/types.js';

const PREVIEW_CHARS = 100;

/**
 * Before this component every non-AskUserQuestion tool result rendered as an
 * EMPTY GREY BORDERED BOX, because the daemon modelled no tool_result kind at
 * all (story-1 AC6/AC17). Plain text in a <pre>, never markdown and never
 * HTML: a tool result is arbitrary model/command output (T7/T11).
 */
export function ToolResult({ e }: { e: Extract<TranscriptEvent, { kind: 'toolResult' }> }): ReactElement {
  const [open, setOpen] = useState(false);
  const firstLine = e.text.split('\n', 1)[0] ?? '';
  const preview = firstLine.length > PREVIEW_CHARS ? `${firstLine.slice(0, PREVIEW_CHARS)}…` : firstLine;
  const tone = e.ok ? 'text-zinc-500' : 'text-red-400';

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className={`w-full text-left font-mono text-[13.5px] ${tone}`}>
        <span>{open ? '▾ ' : '▸ '}</span>
        {e.ok ? '' : 'error · '}
        {preview || '(empty result)'}
      </button>
      {open && (
        <pre className={`mt-1 rounded border border-zinc-800 bg-zinc-900/60 p-2 overflow-x-auto whitespace-pre-wrap font-mono text-[13px] ${e.ok ? 'text-zinc-300' : 'text-red-300'}`}>
          {e.text}
          {e.truncated ? '\n\n[truncated]' : ''}
        </pre>
      )}
    </div>
  );
}
