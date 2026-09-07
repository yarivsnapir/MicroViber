// @vitest-environment jsdom
// pwa/test/app-push.test.tsx — story push-notification-dispatch-1 (AC5/AC6 in App.tsx)
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from '../src/App.js';
import type { SessionSummary } from '../src/lib/types.js';

const alpha: SessionSummary = { id: 's1', title: 'Session Alpha', folder: 'studio', cwd: '/proj/studio', host: 'terminal', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-09-06T10:00:01Z', mode: 'readonly', takenOver: false, devServerPorts: [] };
const beta: SessionSummary = { ...alpha, id: 's2', title: 'Session Beta', folder: 'daemon', cwd: '/proj/daemon', lastPromptAt: '2026-09-06T10:00:00Z' };
const PUBLIC_KEY = 'BPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as unknown as Response;
}
const fetchMock = vi.fn();

/** A browser with push: navigator.serviceWorker (+ controller), PushManager, Notification. */
function installBrowserPush(permission: NotificationPermission) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const controller = { postMessage: vi.fn() };
  const subscription = { options: { applicationServerKey: null }, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } }), unsubscribe: vi.fn(async () => true) };
  const pushManager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) };
  const sw = {
    ready: Promise.resolve({ pushManager }), controller,
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.delete(l); },
    emit: (data: unknown) => { for (const l of listeners) l({ data } as MessageEvent); },
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  vi.stubGlobal('PushManager', class {});
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return { sw, controller, pushManager, requestPermission };
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
  localStorage.setItem('microviber.token', 't'.repeat(40));
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/push/config')) return okJson({ enabled: true, publicKey: PUBLIC_KEY });
    if (url.includes('/api/push/subscribe')) return okJson({ ok: true });
    if (url.includes('/transcript')) return okJson({ events: [], nextCursor: null });
    if (url.includes('/api/sessions')) return okJson([alpha, beta]);
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup(); localStorage.clear(); vi.unstubAllGlobals(); fetchMock.mockReset();
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  history.replaceState(null, '', '/');
});

describe('App — notification tap deep link (AC5)', () => {
  it('cold start at /?session=s2 selects that session (not the top of the list) and scrubs the query', async () => {
    history.replaceState(null, '', '/?session=s2');
    render(<App />);
    await screen.findByText('Session Beta');
    expect(location.search).toBe('');
  });

  it('an {type:"open-session"} message from the service worker switches sessions and clears that session\'s notification', async () => {
    const { sw, controller } = installBrowserPush('denied'); // denied: no opt-in banner noise in this test
    render(<App />);
    await screen.findByText('Session Alpha');
    act(() => sw.emit({ type: 'open-session', sessionId: 's2' }));
    await screen.findByText('Session Beta');
    expect(controller.postMessage).toHaveBeenCalledWith({ type: 'dismiss', tag: 'session:s2' });
  });

  it('opening a session clears its notification (clear-on-open, functional spec §4) — including the initial auto-selected one', async () => {
    const { controller } = installBrowserPush('denied');
    render(<App />);
    await screen.findByText('Session Alpha');
    await waitFor(() => expect(controller.postMessage).toHaveBeenCalledWith({ type: 'dismiss', tag: 'session:s1' }));
  });
});

describe('App — push opt-in banner (AC6)', () => {
  it('no banner in a browser without push support (bare jsdom), and no /api/push/config fetch', async () => {
    render(<App />);
    await screen.findByText('Session Alpha');
    expect(screen.queryByText(/get a push when a session needs you/i)).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/push/config'))).toBe(false);
  });

  it('paired + push supported + permission default + daemon enabled: banner shows; Enable prompts, subscribes, POSTs, and the banner goes away', async () => {
    const { requestPermission, pushManager } = installBrowserPush('default');
    render(<App />);
    await screen.findByText('Session Alpha');
    fireEvent.click(await screen.findByRole('button', { name: /^enable$/i }));
    await waitFor(() => expect(screen.queryByText(/get a push when a session needs you/i)).toBeNull());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const subscribeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/push/subscribe'));
    expect(subscribeCall).toBeDefined();
    expect(JSON.parse((subscribeCall![1] as RequestInit).body as string)).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } });
  });

  it('no banner on the pairing screen (no token yet)', () => {
    localStorage.clear();
    installBrowserPush('default');
    render(<App />);
    expect(screen.getByText(/pair with your laptop/i)).toBeInTheDocument();
    expect(screen.queryByText(/get a push when a session needs you/i)).toBeNull();
  });
});
