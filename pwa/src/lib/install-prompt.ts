let capturedEvent: Event | null = null;
let listenerAttached = false;

/** Captures the one-shot `beforeinstallprompt` event and exposes standalone-mode detection (spec §2). */
export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean } {
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
  };
}
