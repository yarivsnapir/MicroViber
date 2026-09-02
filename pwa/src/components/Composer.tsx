import { useState, type ReactElement } from 'react';
import { promptDisplay, type PromptState } from '../lib/prompt-display.js';

/** 7 lines resting, growing to 10 (spec §7). Mode-aware hint for readonly limits. */
export function Composer({ mode, status, onSend, onHandback, handingBack }: {
  mode: 'readonly' | 'owned';
  status: PromptState | null;
  onSend: (text: string) => void;
  /** Only rendered in 'owned' mode — the taken-over gate's one affordance (story AC 5/6). */
  onHandback: () => void;
  handingBack?: boolean;
}): ReactElement {
  const [text, setText] = useState('');
  const disp = status ? promptDisplay(status) : null;

  const submit = () => { if (text.trim()) { onSend(text.trim()); if (!disp?.keepText) setText(''); } };

  return (
    <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-3">
      <div className={`rounded-xl border bg-zinc-950 px-3 py-2.5 ${disp?.tone === 'error' ? 'border-red-700' : disp?.tone === 'warn' ? 'border-amber-700' : 'border-zinc-700'}`}>
        <textarea
          className="w-full resize-none bg-transparent text-[16.5px] text-zinc-100 outline-none placeholder:text-zinc-500"
          rows={7} style={{ maxHeight: '15rem' }}
          placeholder="Message this session…"
          value={text} onChange={(ev) => setText(ev.target.value)}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {mode === 'readonly' && <span className="mr-auto text-[11.5px] text-zinc-500">sends as message — can’t answer prompts</span>}
          {mode === 'owned' && (
            <button onClick={onHandback} disabled={handingBack}
              className="rounded-lg border border-zinc-700 px-3 py-1 text-[12.5px] font-semibold text-zinc-400 disabled:opacity-60">
              {handingBack ? 'Handing back…' : 'Hand back'}
            </button>
          )}
          <button onClick={submit} className="grid h-7 w-7 place-items-center rounded-full bg-amber-400 text-[15.5px] font-bold text-amber-950">↑</button>
        </div>
      </div>
      {disp?.message && (
        <div className={`mt-2 flex items-center gap-2 text-[12.5px] ${disp.tone === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
          {disp.message}
          {disp.showResend && <button onClick={submit} className="ml-auto font-bold underline">Resend</button>}
        </div>
      )}
    </div>
  );
}
