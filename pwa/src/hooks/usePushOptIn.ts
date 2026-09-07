import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../lib/api.js';
import { ensurePushSubscription, isPushSupported } from '../lib/push.js';

export const PUSH_OPTIN_DISMISSED_KEY = 'microviber.pushOptInDismissed';

export interface PushOptInDeps {
  ensure: typeof ensurePushSubscription;
  supported: () => boolean;
  permission: () => NotificationPermission;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return localStorage; } catch { return null; }
}

const defaultDeps = (): PushOptInDeps => ({
  ensure: ensurePushSubscription,
  supported: isPushSupported,
  permission: () => Notification.permission,
  storage: safeStorage(),
});

/**
 * When and whether to offer push notifications (AC6). Offer = paired (api
 * present), browser supports push, permission not yet decided, daemon has
 * VAPID keys, not previously dismissed. Already-granted permission means a
 * silent re-sync on every load instead (keeps the daemon's on-disk store
 * current after a restart or a key rotation); never a prompt on cold load.
 */
export function usePushOptIn(api: Api | null, deps: PushOptInDeps = defaultDeps()): { offer: boolean; busy: boolean; enable(): Promise<void>; dismiss(): void } {
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api || !deps.supported()) { setOffer(false); return; }
    const permission = deps.permission();
    if (permission === 'granted') { setOffer(false); void deps.ensure(api, { interactive: false }); return; }
    if (permission === 'denied' || deps.storage?.getItem(PUSH_OPTIN_DISMISSED_KEY)) { setOffer(false); return; }
    let stale = false;
    api.getPushConfig().then((c) => { if (!stale) setOffer(c.enabled); }).catch(() => { if (!stale) setOffer(false); });
    return () => { stale = true; };
    // deps is a stable default or a test-provided object; only `api` identity matters here.
  }, [api]);

  const enable = useCallback(async () => {
    if (!api) return;
    setBusy(true);
    try {
      const r = await deps.ensure(api, { interactive: true });
      // 'not-granted' (prompt closed) and 'failed' keep the offer so they can retry; everything else settles it.
      if (r !== 'not-granted' && r !== 'failed') setOffer(false);
    } finally {
      setBusy(false);
    }
  }, [api, deps]);

  const dismiss = useCallback(() => {
    setOffer(false);
    try { deps.storage?.setItem(PUSH_OPTIN_DISMISSED_KEY, '1'); } catch { /* storage disabled */ }
  }, [deps]);

  return { offer, busy, enable, dismiss };
}
