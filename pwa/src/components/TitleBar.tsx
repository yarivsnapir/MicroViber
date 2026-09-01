// pwa/src/components/TitleBar.tsx
import { useEffect, useState, type ReactElement } from 'react';
import { captureInstallPrompt } from '../lib/install-prompt.js';

/** Dedicated app-identity bar (spec §4) — icon + wordmark + conditional install button. */
export function TitleBar(): ReactElement {
  const [installEvent, setInstallEvent] = useState<Event | null>(null);

  useEffect(() => {
    const { getEvent, isStandalone } = captureInstallPrompt();
    if (isStandalone()) return;
    const check = () => setInstallEvent(getEvent());
    check(); // covers the case where the event was already captured before mount
    window.addEventListener('beforeinstallprompt', check);
    return () => window.removeEventListener('beforeinstallprompt', check);
  }, []);

  const install = () => {
    (installEvent as unknown as { prompt: () => void } | null)?.prompt();
  };

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3.5 py-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-gradient-to-br from-amber-400 to-amber-700 text-[11px] font-black text-zinc-950">◈</span>
      <span className="flex-1 text-[12.5px] font-bold tracking-wide text-zinc-400">MICROVIBER</span>
      {installEvent && (
        <button onClick={install} className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-bold text-amber-400">
          ⇩ Install
        </button>
      )}
    </div>
  );
}
