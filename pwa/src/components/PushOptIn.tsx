import type { ReactElement } from 'react';

/** Push opt-in offer (AC6). Same chrome as states.tsx's Banner (border-b px-3.5 py-2 text-[13px] leading-snug), neutral tone. */
export function PushOptIn({ busy, onEnable, onDismiss }: { busy: boolean; onEnable: () => void; onDismiss: () => void }): ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3.5 py-2 text-[13px] leading-snug text-zinc-300">
      <span className="flex-1">Get a push when a session needs you.</span>
      <button onClick={onEnable} disabled={busy}
        className="rounded-md bg-emerald-500 px-3 py-1.5 font-semibold text-emerald-950 disabled:opacity-60">
        {busy ? 'Enabling…' : 'Enable'}
      </button>
      <button onClick={onDismiss} className="px-1 text-zinc-500">Not now</button>
    </div>
  );
}
