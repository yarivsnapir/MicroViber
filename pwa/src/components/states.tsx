import type { ReactElement } from 'react';

export function EmptyState({ onRefresh }: { onRefresh: () => void }): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-3xl opacity-50">◈</div>
      <h3 className="text-[16.5px] font-semibold text-zinc-100">No sessions running</h3>
      <p className="text-[14px] leading-relaxed text-zinc-400">Start a Claude Code session on your laptop and it’ll appear here within a few seconds.</p>
      <button onClick={onRefresh} className="mt-1 rounded-lg border border-amber-700 px-4 py-2 text-[13.5px] text-amber-400">Refresh</button>
    </div>
  );
}

export function TranscriptLoading(): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-8 text-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-400" />
      <p className="text-[13.5px] text-zinc-500">Loading conversation…</p>
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }): ReactElement {
  const cls = tone === 'error' ? 'bg-red-500/10 border-red-700/40 text-red-400' : 'bg-amber-500/10 border-amber-700/50 text-amber-400';
  return <div className={`border-b px-3.5 py-2 text-[13px] leading-snug ${cls}`}>{children}</div>;
}

export function PaneSwitch({ pane, onChange }: { pane: 'claude' | 'web'; onChange: (pane: 'claude' | 'web') => void }): ReactElement {
  return (
    <div className="flex border-t border-zinc-800 bg-zinc-900">
      <button
        onClick={() => onChange('claude')}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[12.5px] ${pane === 'claude' ? 'text-amber-400' : 'text-zinc-600'}`}
      >
        <span className="text-[17.5px]">◈</span>Claude
      </button>
      <button
        onClick={() => onChange('web')}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[12.5px] ${pane === 'web' ? 'text-amber-400' : 'text-zinc-600'}`}
      >
        <span className="text-[17.5px]">⬡</span>Web
      </button>
    </div>
  );
}

export function PairingScreen(): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-3xl opacity-50">🔗</div>
      <h3 className="text-[16.5px] font-semibold text-zinc-100">Pair with your laptop</h3>
      <p className="text-[14px] leading-relaxed text-zinc-400">Start the MicroViber daemon on your laptop and scan the QR code it prints, or open the pairing link on this phone.</p>
    </div>
  );
}
