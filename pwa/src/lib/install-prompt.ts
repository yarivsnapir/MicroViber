let capturedEvent: Event | null = null;
let listenerAttached = false;

/** Captures the one-shot `beforeinstallprompt` event and exposes standalone-mode detection (spec §2). */
export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean; clearEvent: () => void } {
  if (!listenerAttached) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      capturedEvent = e;
    });
    listenerAttached = true;
  }
  return {
    getEvent: () => capturedEvent,
    isStandalone: () => window.matchMedia('(display-mode: standalone)').matches,
    // beforeinstallprompt is one-shot: once .prompt() has been called on it,
    // calling it again throws/rejects. Consumers must clear the module-level
    // singleton after consuming the event so no other consumer can retrieve
    // a stale, already-consumed reference via getEvent().
    clearEvent: () => { capturedEvent = null; },
  };
}
