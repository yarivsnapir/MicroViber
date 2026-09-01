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
    // The event is one-shot, but the app can also be installed via the
    // browser's own UI (address-bar icon, menu) without ever going through
    // our button — hide the button immediately in that case too, without
    // requiring a reload.
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', check);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = () => {
    const { clearEvent } = captureInstallPrompt();
    // beforeinstallprompt is one-shot: once .prompt() resolves, the event is
    // consumed either way (accepted or dismissed) and must not be reused —
    // clear both the local button state and the module-level singleton so no
    // other consumer can retrieve a stale reference via getEvent().
    void (installEvent as unknown as { prompt: () => Promise<{ outcome: string }> } | null)
      ?.prompt()
      .then(() => { clearEvent(); setInstallEvent(null); });
  };

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3.5 py-2">
      <img src="/icon-192.png" alt="" className="h-5 w-5 rounded-[6px]" />
      <span className="flex-1 text-[12.5px] font-bold tracking-wide text-zinc-400">MICROVIBER</span>
      {installEvent && (
        <button onClick={install} className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-bold text-amber-400">
          ⇩ Install
        </button>
      )}
    </div>
  );
}
