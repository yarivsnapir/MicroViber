// @vitest-environment jsdom
// pwa/test/push.test.ts — story push-notification-dispatch-1 (AC5/AC6 client side)
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  urlBase64ToUint8Array, isPushSupported, ensurePushSubscription, applicationServerKeyMatches,
  sessionFromUrl, tagForSession, dismissSessionNotification, onOpenSessionMessage,
} from '../src/lib/push.js';

const PUBLIC_KEY = 'BPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fakeSubscription(keyBytes: Uint8Array) {
  const json = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } };
  return { options: { applicationServerKey: keyBytes.buffer }, toJSON: () => json, unsubscribe: vi.fn(async () => true), json };
}

/** Installs navigator.serviceWorker + PushManager + Notification the way a real browser has them. */
function installBrowserPush(over: { permission?: NotificationPermission; existing?: ReturnType<typeof fakeSubscription> | null } = {}) {
  const created = fakeSubscription(urlBase64ToUint8Array(PUBLIC_KEY));
  const pushManager = {
    getSubscription: vi.fn(async () => over.existing ?? null),
    subscribe: vi.fn(async (_opts: PushSubscriptionOptionsInit) => created),
  };
  const controller = { postMessage: vi.fn() };
  const listeners = new Set<(e: MessageEvent) => void>();
  const sw = {
    ready: Promise.resolve({ pushManager }),
    controller,
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.delete(l); },
    emit: (data: unknown) => { for (const l of listeners) l({ data } as MessageEvent); },
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  vi.stubGlobal('PushManager', class {});
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  vi.stubGlobal('Notification', { permission: over.permission ?? 'default', requestPermission });
  return { pushManager, created, controller, sw, requestPermission };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // jsdom has no serviceWorker by default; remove ours so the next test starts clean
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

describe('urlBase64ToUint8Array', () => {
  it('decodes url-safe base64 without padding', () => {
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('AQI')]).toEqual([1, 2]);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]); // '-'→'+', '_'→'/'
  });
});

describe('isPushSupported', () => {
  it('false in bare jsdom (no PushManager / Notification)', () => { expect(isPushSupported()).toBe(false); });
  it('true once serviceWorker + PushManager + Notification exist', () => { installBrowserPush(); expect(isPushSupported()).toBe(true); });
});

describe('ensurePushSubscription', () => {
  const api = (enabled = true) => ({ getPushConfig: vi.fn(async () => ({ enabled, publicKey: enabled ? PUBLIC_KEY : null })), subscribePush: vi.fn(async () => {}) });

  it('"unsupported" in a browser without push — and never even asks the daemon', async () => {
    const a = api();
    expect(await ensurePushSubscription(a, { interactive: true })).toBe('unsupported');
    expect(a.getPushConfig).not.toHaveBeenCalled();
  });

  it('"disabled" when the daemon has no VAPID keys — no permission prompt', async () => {
    const { requestPermission } = installBrowserPush();
    expect(await ensurePushSubscription(api(false), { interactive: true })).toBe('disabled');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('non-interactive with permission "default": "not-granted", and NO prompt (never prompt on cold load)', async () => {
    const { requestPermission, pushManager } = installBrowserPush({ permission: 'default' });
    expect(await ensurePushSubscription(api(), { interactive: false })).toBe('not-granted');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('interactive: prompts, subscribes with the daemon\'s key as raw bytes + userVisibleOnly, POSTs toJSON(), returns "subscribed"', async () => {
    const { requestPermission, pushManager, created } = installBrowserPush({ permission: 'default' });
    const a = api();
    expect(await ensurePushSubscription(a, { interactive: true })).toBe('subscribed');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const arg = pushManager.subscribe.mock.calls[0]![0];
    expect(arg.userVisibleOnly).toBe(true);
    expect([...new Uint8Array(arg.applicationServerKey as ArrayBuffer)]).toEqual([...urlBase64ToUint8Array(PUBLIC_KEY)]);
    expect(a.subscribePush).toHaveBeenCalledWith(created.json);
  });

  it('permission already granted: reuses the existing subscription (no new subscribe) but still re-POSTs it — keeps the daemon store in sync after a restart', async () => {
    const existing = fakeSubscription(urlBase64ToUint8Array(PUBLIC_KEY));
    const { pushManager } = installBrowserPush({ permission: 'granted', existing });
    const a = api();
    expect(await ensurePushSubscription(a, { interactive: false })).toBe('subscribed');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(a.subscribePush).toHaveBeenCalledWith(existing.json);
  });

  it('an existing subscription made with a DIFFERENT key (daemon rotated VAPID) is unsubscribed and re-created', async () => {
    const stale = fakeSubscription(new Uint8Array([9, 9, 9]));
    const { pushManager } = installBrowserPush({ permission: 'granted', existing: stale });
    expect(await ensurePushSubscription(api(), { interactive: false })).toBe('subscribed');
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('"denied" when the user has blocked notifications — no subscribe attempt', async () => {
    const { pushManager } = installBrowserPush({ permission: 'denied' });
    expect(await ensurePushSubscription(api(), { interactive: true })).toBe('denied');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('"failed" when the daemon rejects the subscription (never throws to the UI)', async () => {
    installBrowserPush({ permission: 'granted' });
    const a = api(); a.subscribePush = vi.fn(async () => { throw new Error('400'); });
    expect(await ensurePushSubscription(a, { interactive: false })).toBe('failed');
  });

  it('"failed" when requestPermission itself rejects — a rejected promise must never reach the tap handler', async () => {
    const { requestPermission, pushManager } = installBrowserPush({ permission: 'default' });
    requestPermission.mockRejectedValue(new Error('permission request not allowed in this context'));
    await expect(ensurePushSubscription(api(), { interactive: true })).resolves.toBe('failed');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('applicationServerKeyMatches compares bytes', () => {
    expect(applicationServerKeyMatches(fakeSubscription(urlBase64ToUint8Array(PUBLIC_KEY)) as unknown as PushSubscription, PUBLIC_KEY)).toBe(true);
    expect(applicationServerKeyMatches(fakeSubscription(new Uint8Array([1])) as unknown as PushSubscription, PUBLIC_KEY)).toBe(false);
    // A truncated key passes the element-wise scan; only the length check rejects it.
    expect(applicationServerKeyMatches(fakeSubscription(urlBase64ToUint8Array(PUBLIC_KEY).slice(0, 8)) as unknown as PushSubscription, PUBLIC_KEY)).toBe(false);
  });
});

describe('notification deep-link helpers (AC5 — sw.js notificationclick contract)', () => {
  it('sessionFromUrl reads ?session=<id> (where sw.js openWindow() sends a cold-started PWA), null otherwise', () => {
    expect(sessionFromUrl({ search: '?session=abc-123' })).toBe('abc-123');
    expect(sessionFromUrl({ search: '' })).toBeNull();
    expect(sessionFromUrl({ search: '?session=' })).toBeNull();
  });

  it('tagForSession matches the daemon\'s NotifyPolicy tag (SYNC notify-policy.ts tagOf)', () => {
    expect(tagForSession('s1')).toBe('session:s1');
  });

  it('dismissSessionNotification posts {type:"dismiss", tag} to the controlling SW (clear-on-open), and is a no-op without one', () => {
    const { controller } = installBrowserPush();
    dismissSessionNotification('s1');
    expect(controller.postMessage).toHaveBeenCalledWith({ type: 'dismiss', tag: 'session:s1' });
    // An explicit `undefined` re-triggers the default parameter, so it does NOT exercise the
    // no-SW path — only deleting navigator.serviceWorker does. Assert both: no throw, no post.
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    expect(() => dismissSessionNotification('s1', undefined)).not.toThrow();
    expect(controller.postMessage).toHaveBeenCalledTimes(1);
  });

  it('onOpenSessionMessage fires the handler for {type:"open-session", sessionId}, ignores other messages, and unsubscribes', () => {
    const { sw } = installBrowserPush();
    const handler = vi.fn();
    const off = onOpenSessionMessage(handler);
    sw.emit({ type: 'dismiss', tag: 'x' });
    sw.emit({ type: 'open-session', sessionId: 's2' });
    sw.emit({ type: 'open-session' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('s2');
    off();
    sw.emit({ type: 'open-session', sessionId: 's3' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
