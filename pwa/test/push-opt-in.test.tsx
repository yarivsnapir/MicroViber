// @vitest-environment jsdom
// pwa/test/push-opt-in.test.tsx — story push-notification-dispatch-1 (AC6: opt-in at an appropriate moment, never on cold load)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, renderHook, act, waitFor } from '@testing-library/react';
import { PushOptIn } from '../src/components/PushOptIn.js';
import { usePushOptIn, PUSH_OPTIN_DISMISSED_KEY, type PushOptInDeps } from '../src/hooks/usePushOptIn.js';
import type { Api } from '../src/lib/api.js';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('PushOptIn (component)', () => {
  it('renders the offer with Enable and Not now, wired to the callbacks', () => {
    const onEnable = vi.fn(); const onDismiss = vi.fn();
    render(<PushOptIn busy={false} onEnable={onEnable} onDismiss={onDismiss} />);
    expect(screen.getByText(/get a push when a session needs you/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enable/i }));
    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('busy disables Enable and shows progress copy', () => {
    render(<PushOptIn busy onEnable={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: /enabling/i })).toBeDisabled();
  });
});

describe('usePushOptIn (hook)', () => {
  const api = (enabled = true) => ({ getPushConfig: vi.fn(async () => ({ enabled, publicKey: enabled ? 'K' : null })), subscribePush: vi.fn(async () => {}) }) as unknown as Api;
  // `api` and `deps` are hoisted per test, never built inline in the renderHook callback:
  // the hook's effect is keyed on `api` identity (App.tsx useMemo's it for the same reason),
  // so a fresh object per render would re-run the effect and resurrect a just-settled offer.
  const deps = (over: Partial<PushOptInDeps> = {}): PushOptInDeps => ({
    ensure: vi.fn(async () => 'subscribed' as const),
    supported: () => true,
    permission: () => 'default',
    storage: localStorage,
    ...over,
  });

  it('no api (not paired yet): never offers, never calls the daemon', async () => {
    const d = deps();
    const { result } = renderHook(() => usePushOptIn(null, d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
    expect(d.ensure).not.toHaveBeenCalled();
  });

  it('paired + supported + permission default + daemon enabled: offers (without prompting)', async () => {
    const a = api(); const d = deps();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    expect(d.ensure).not.toHaveBeenCalled();
  });

  it('daemon has push disabled: no offer', async () => {
    const a = api(false); const d = deps();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
  });

  it('unsupported browser: no offer, no config fetch', async () => {
    const a = api(); const d = deps({ supported: () => false });
    const { result } = renderHook(() => usePushOptIn(a, d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
    expect(a.getPushConfig).not.toHaveBeenCalled();
  });

  it('permission already granted: no offer, but silently re-syncs the subscription (interactive: false)', async () => {
    const d = deps({ permission: () => 'granted' });
    const a = api();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(d.ensure).toHaveBeenCalledWith(a, { interactive: false }));
    expect(result.current.offer).toBe(false);
  });

  it('permission denied: no offer, no re-sync', async () => {
    const a = api(); const d = deps({ permission: () => 'denied' });
    const { result } = renderHook(() => usePushOptIn(a, d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
    expect(d.ensure).not.toHaveBeenCalled();
  });

  it('previously dismissed ("Not now"): no offer on later loads', async () => {
    localStorage.setItem(PUSH_OPTIN_DISMISSED_KEY, '1');
    const a = api(); const d = deps();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
  });

  it('enable(): busy while running, calls ensure interactively, hides the offer on "subscribed"', async () => {
    let release!: (r: 'subscribed') => void;
    const d = deps({ ensure: vi.fn(() => new Promise<'subscribed'>((res) => { release = res; })) });
    const a = api();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    let p!: Promise<void>;
    act(() => { p = result.current.enable(); });
    expect(result.current.busy).toBe(true);
    await act(async () => { release('subscribed'); await p; });
    expect(d.ensure).toHaveBeenCalledWith(a, { interactive: true });
    expect(result.current.busy).toBe(false);
    expect(result.current.offer).toBe(false);
  });

  it('enable() when the user denies: offer goes away (denied is final until browser settings change)', async () => {
    const a = api(); const d = deps({ ensure: vi.fn(async () => 'denied' as const) });
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    await act(async () => { await result.current.enable(); });
    expect(result.current.offer).toBe(false);
  });

  it('enable() when the prompt is just closed ("not-granted"): offer stays so they can try again', async () => {
    const a = api(); const d = deps({ ensure: vi.fn(async () => 'not-granted' as const) });
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    await act(async () => { await result.current.enable(); });
    expect(result.current.offer).toBe(true);
  });

  it('dismiss(): hides the offer and remembers it', async () => {
    const a = api(); const d = deps();
    const { result } = renderHook(() => usePushOptIn(a, d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.offer).toBe(false);
    expect(localStorage.getItem(PUSH_OPTIN_DISMISSED_KEY)).toBe('1');
  });
});
