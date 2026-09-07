// @vitest-environment jsdom
// pwa/test/sw.test.ts
//
// pwa/public/sw.js is plain JS loaded by the browser, not imported by the app,
// so it had no coverage at all — while being the last hop of the whole push
// path. Two things went wrong because of that: the final whole-branch review
// noted the payload KEY NAMES were pinned only against themselves (renaming
// `body` on the daemon side would keep every other test green while the phone
// showed empty notifications), and real-device testing then found the
// notification rendering under Chrome's own logo because neither `icon` nor
// `badge` was set.
//
// This loads the real file into a stubbed ServiceWorkerGlobalScope and drives
// its listeners, so the daemon<->sw.js contract is pinned on this side too.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SW_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js'), 'utf8');

type Listener = (event: unknown) => void;

/** Loads sw.js against a fake `self`, returning the registered listeners and the spies. */
function loadServiceWorker(over: { clients?: unknown[] } = {}) {
  const listeners = new Map<string, Listener>();
  const notifications: { tag: string; close: ReturnType<typeof vi.fn> }[] = [];
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const waited: unknown[] = [];

  const self = {
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn); },
    skipWaiting: vi.fn(),
    registration: {
      showNotification,
      getNotifications: vi.fn(async ({ tag }: { tag: string }) => notifications.filter((n) => n.tag === tag)),
    },
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => over.clients ?? []),
      openWindow,
    },
  };

  // sw.js is browser-delivered plain JS with no exports, so the only way to
  // exercise the real file (rather than a copy that can drift) is to evaluate
  // it with an injected `self`. Neither no-implied-eval nor no-new-func is
  // enabled in this repo's config, so no disable directive is needed here.
  new Function('self', SW_SRC)(self);

  const fire = async (type: string, event: Record<string, unknown>) => {
    const fn = listeners.get(type);
    if (!fn) throw new Error(`sw.js registered no '${type}' listener`);
    fn({ waitUntil: (p: unknown) => { waited.push(p); }, ...event });
    await Promise.all(waited.map((p) => Promise.resolve(p)));
  };

  return { fire, showNotification, openWindow, notifications, listeners, self };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

describe('sw.js — push handler (the daemon contract, pinned on the PWA side)', () => {
  let sw: ReturnType<typeof loadServiceWorker>;
  beforeEach(() => { sw = loadServiceWorker(); });

  it('a notify push shows a notification carrying EVERY key the daemon sends', async () => {
    await sw.fire('push', pushEvent({
      type: 'notify', tag: 'session:s1', title: 'Fix the tests',
      body: 'Waiting for you · studio — run the tests', sessionId: 's1',
    }));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = sw.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // SYNC daemon/src/lib/push-sender.ts NotifyPayload — renaming a field there
    // must break here rather than silently emptying the phone's notification.
    expect(title).toBe('Fix the tests');
    expect(opts.body).toBe('Waiting for you · studio — run the tests');
    expect(opts.tag).toBe('session:s1');
    expect(opts.data).toEqual({ sessionId: 's1' });
  });

  it('the notification carries the app icon AND badge, so it is not rendered under the browser vendor logo', async () => {
    await sw.fire('push', pushEvent({ type: 'notify', tag: 'session:s1', title: 'T', body: 'B', sessionId: 's1' }));
    const [, opts] = sw.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // Real-device finding (2026-09-07): with these unset, Android Chrome uses
    // its own logo and the push is unattributable to MicroViber.
    expect(opts.icon).toBe('/icon-192.png');
    expect(opts.badge).toBe('/icon-192.png');
  });

  it('tag-keyed replace-not-stack: renotify stays false so a later push for the same session replaces quietly', async () => {
    await sw.fire('push', pushEvent({ type: 'notify', tag: 'session:s1', title: 'T', body: 'B', sessionId: 's1' }));
    const [, opts] = sw.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.renotify).toBe(false);
  });

  it('a notify with no title falls back rather than showing an empty notification', async () => {
    await sw.fire('push', pushEvent({ type: 'notify', tag: 'session:s1', sessionId: 's1' }));
    const [title, opts] = sw.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(title).toBe('Session idle');
    expect(opts.body).toBe('');
  });

  it('a dismiss push closes exactly that tag and shows nothing', async () => {
    const mine = { tag: 'session:s1', close: vi.fn() };
    const other = { tag: 'session:s2', close: vi.fn() };
    sw.notifications.push(mine, other);
    await sw.fire('push', pushEvent({ type: 'dismiss', tag: 'session:s1' }));
    expect(mine.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it('a push with no data, unparsable JSON, or an unknown type does nothing (never throws)', async () => {
    const fn = sw.listeners.get('push')!;
    expect(() => fn({ waitUntil: () => {} })).not.toThrow();
    expect(() => fn({ waitUntil: () => {}, data: { json: () => { throw new Error('bad'); } } })).not.toThrow();
    await sw.fire('push', pushEvent({ type: 'something-else', tag: 'session:s1' }));
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it('a client dismiss message closes that tag too (the clear-on-open fallback App.tsx uses)', async () => {
    const mine = { tag: 'session:s1', close: vi.fn() };
    sw.notifications.push(mine);
    await sw.fire('message', { data: { type: 'dismiss', tag: 'session:s1' } });
    expect(mine.close).toHaveBeenCalledTimes(1);
  });
});

describe('sw.js — notificationclick (tapping the push must open THAT session)', () => {
  it('with the PWA already open: focuses it and posts open-session with the tapped session id', async () => {
    const client = { focus: vi.fn(), postMessage: vi.fn() };
    const sw = loadServiceWorker({ clients: [client] });
    const close = vi.fn();
    await sw.fire('notificationclick', { notification: { close, data: { sessionId: 's2' } } });
    expect(close).toHaveBeenCalledTimes(1);
    // SYNC pwa/src/lib/push.ts onOpenSessionMessage.
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'open-session', sessionId: 's2' });
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('with the PWA closed: cold-starts it at /?session=<id>', async () => {
    const sw = loadServiceWorker({ clients: [] });
    await sw.fire('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 's2' } } });
    // SYNC pwa/src/lib/push.ts sessionFromUrl.
    expect(sw.openWindow).toHaveBeenCalledWith('/?session=s2');
  });

  it('a session id needing encoding is encoded, not concatenated raw', async () => {
    const sw = loadServiceWorker({ clients: [] });
    await sw.fire('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 'a b&c' } } });
    expect(sw.openWindow).toHaveBeenCalledWith('/?session=a%20b%26c');
  });
});
