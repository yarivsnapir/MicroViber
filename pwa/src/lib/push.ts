import type { Api } from './api.js';

/**
 * Web Push client side (story push-notification-dispatch-1, AC5/AC6). The
 * service worker (public/sw.js) already shows/dismisses notifications and
 * routes taps; this module (1) gets the browser subscribed and registered with
 * the daemon and (2) gives App.tsx the deep-link plumbing sw.js expects.
 */
export type PushSetupResult = 'subscribed' | 'disabled' | 'unsupported' | 'denied' | 'not-granted' | 'failed';

export function isPushSupported(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in g && 'Notification' in g;
}

/** VAPID public keys travel as URL-safe base64; PushManager.subscribe wants the raw 65-byte P-256 point. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** True when the subscription was created for exactly this daemon's key — a rotated VAPID key needs a fresh subscription. */
export function applicationServerKeyMatches(sub: PushSubscription, publicKey: string): boolean {
  const current = sub.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = urlBase64ToUint8Array(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Subscribe this browser to the daemon's pushes and register the subscription.
 * Safe to call on every load once permission is granted: an existing
 * subscription is re-POSTed (cheap; keeps the daemon's on-disk store in sync).
 * `interactive` means "called from a user tap": only then may this prompt for
 * permission — never on cold load (browsers penalize unprompted requests, and
 * iOS requires a gesture).
 */
export async function ensurePushSubscription(api: Pick<Api, 'getPushConfig' | 'subscribePush'>, opts: { interactive: boolean }): Promise<PushSetupResult> {
  if (!isPushSupported()) return 'unsupported';
  let cfg: { enabled: boolean; publicKey: string | null };
  try { cfg = await api.getPushConfig(); } catch { return 'failed'; }
  if (!cfg.enabled || !cfg.publicKey) return 'disabled';
  const publicKey = cfg.publicKey;

  let permission = Notification.permission;
  // Some embedded/cross-origin contexts reject rather than resolving 'denied'; every failure
  // path here returns a PushSetupResult, so this must not escape into the caller's tap handler.
  if (permission === 'default' && opts.interactive) {
    try { permission = await Notification.requestPermission(); } catch { return 'failed'; }
  }
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'not-granted';

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !applicationServerKeyMatches(sub, publicKey)) { await sub.unsubscribe(); sub = null; }
    // `.buffer as ArrayBuffer`: TS types Uint8Array's buffer as ArrayBufferLike (i.e. possibly
    // SharedArrayBuffer), which BufferSource rejects. The decode above always allocates a plain,
    // exactly-sized ArrayBuffer.
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer });
    await api.subscribePush(sub.toJSON());
    return 'subscribed';
  } catch {
    return 'failed';
  }
}

/** `/?session=<id>` — where sw.js's notificationclick sends a PWA it had to cold-start. */
export function sessionFromUrl(loc: { search: string }): string | null {
  return new URLSearchParams(loc.search).get('session') || null;
}

/** SYNC daemon/src/domain/notify-policy.ts `tagOf`. */
export function tagForSession(id: string): string {
  return `session:${id}`;
}

/**
 * Clear-on-open (functional spec §4): close this session's notification the
 * moment the session is on screen — belt-and-braces with the daemon's own
 * dismiss push. sw.js already handles this exact client message.
 */
export function dismissSessionNotification(id: string, sw: ServiceWorkerContainer | undefined = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined): void {
  try { sw?.controller?.postMessage({ type: 'dismiss', tag: tagForSession(id) }); } catch { /* no SW yet */ }
}

/** sw.js posts {type:'open-session', sessionId} to an already-open window on a notification tap. Returns the unsubscribe. */
export function onOpenSessionMessage(handler: (id: string) => void, sw: ServiceWorkerContainer | undefined = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined): () => void {
  if (!sw) return () => {};
  const listener = (e: MessageEvent): void => {
    const m = e.data as { type?: unknown; sessionId?: unknown } | null;
    if (m && m.type === 'open-session' && typeof m.sessionId === 'string' && m.sessionId) handler(m.sessionId);
  };
  sw.addEventListener('message', listener);
  return () => sw.removeEventListener('message', listener);
}
