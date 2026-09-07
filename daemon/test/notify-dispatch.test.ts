import { describe, it, expect, vi, afterEach } from 'vitest';
import { statusLineFor, toNotifyInput, dispatchIntents, startNotifyLoop } from '../src/services/notify-dispatch.js';
import type { SessionSummary } from '../src/domain/registry.js';
import type { NotifyIntent } from '../src/domain/notify-policy.js';

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1', title: 'Fix the tests', folder: 'studio', cwd: '/proj/studio', host: 'vscode', writable: true, state: 'idle',
    lastActivityAt: null, lastPrompt: null, lastPromptAt: null, mode: 'readonly', takenOver: false, devServerPorts: [], ...over,
  };
}
const subA = { endpoint: 'https://fcm.googleapis.com/fcm/send/A', keys: { p256dh: 'p', auth: 'a' }, expirationTime: null, createdAt: '2026-09-06T10:00:00Z' };
const subB = { endpoint: 'https://web.push.apple.com/B', keys: { p256dh: 'p', auth: 'a' }, expirationTime: null, createdAt: '2026-09-06T10:00:01Z' };
function fakeStore(initial = [subA, subB]) {
  let subs = [...initial];
  return { list: () => subs, remove: vi.fn((endpoint: string) => { const n = subs.length; subs = subs.filter((s) => s.endpoint !== endpoint); return subs.length !== n; }) };
}
/** A store whose contents can change BETWEEN ticks — the phone subscribing or being pruned mid-run. */
function swappableStore(initial: typeof subA[] = []) {
  let subs = [...initial];
  return { list: () => subs, remove: vi.fn(), set: (next: typeof subA[]) => { subs = next; } };
}
// `_sub` is typed rather than omitted so `sendNotify.mock.calls[i][0]` is a recorded argument:
// a zero-arg vi.fn records an empty tuple and tsc rejects `c[0]` in the fan-out assertion below.
const okSender = () => ({ sendNotify: vi.fn(async (_sub: { endpoint: string }) => 'ok' as const), sendDismiss: vi.fn(async () => 'ok' as const) });
const notifyIntent: NotifyIntent = { type: 'notify', sessionId: 's1', tag: 'session:s1', title: 'T', body: 'B' };

describe('statusLineFor (functional spec §4: why it fired + where + what the session was last asked)', () => {
  it('idle: "Waiting for you · <folder> — <last prompt>"', () => {
    expect(statusLineFor(summary({ state: 'idle', lastPrompt: 'run the tests' }))).toBe('Waiting for you · studio — run the tests');
  });
  it('awaiting-input: "Needs your answer · <folder> — …"', () => {
    expect(statusLineFor(summary({ state: 'awaiting-input', lastPrompt: 'pick one' }))).toBe('Needs your answer · studio — pick one');
  });
  it('no last prompt: just the head', () => {
    expect(statusLineFor(summary({ lastPrompt: null }))).toBe('Waiting for you · studio');
  });
  it('collapses whitespace/newlines and clips a long prompt to 100 chars with an ellipsis', () => {
    const line = statusLineFor(summary({ lastPrompt: 'a\n\nb   ' + 'x'.repeat(200) }));
    expect(line.startsWith('Waiting for you · studio — a b x')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBe('Waiting for you · studio — '.length + 100);
  });
  it('toNotifyInput maps a SessionSummary to NotifyPolicy\'s SessionLite', () => {
    expect(toNotifyInput([summary({ lastPrompt: 'hi' })])).toEqual([{ id: 's1', state: 'idle', title: 'Fix the tests', statusLine: 'Waiting for you · studio — hi' }]);
  });
});

describe('dispatchIntents', () => {
  it('fans a notify out to every stored subscription', async () => {
    const store = fakeStore(); const sender = okSender();
    await dispatchIntents([notifyIntent], { store, sender });
    expect(sender.sendNotify).toHaveBeenCalledTimes(2);
    expect(sender.sendNotify.mock.calls.map((c) => c[0])).toEqual([subA, subB]);
  });

  it('a "gone" outcome prunes THAT subscription only and keeps sending to the rest', async () => {
    const store = fakeStore(); const log = vi.fn();
    const sender = { sendNotify: vi.fn(async (s: { endpoint: string }) => (s.endpoint === subA.endpoint ? 'gone' as const : 'ok' as const)), sendDismiss: vi.fn(async () => 'ok' as const) };
    await dispatchIntents([notifyIntent], { store, sender, log });
    // "keeps sending to the rest" is the half the copy of store.list() exists for: pruning subA
    // mid-iteration must not skip subB. Pinned by count AND order, not just by the surviving store.
    expect(sender.sendNotify).toHaveBeenCalledTimes(2);
    expect(sender.sendNotify.mock.calls.map((c) => c[0])).toEqual([subA, subB]);
    expect(store.remove).toHaveBeenCalledWith(subA.endpoint);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([subB]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pruned'));
  });

  it('a "failed" outcome keeps the subscription (transient)', async () => {
    const store = fakeStore();
    const sender = { sendNotify: vi.fn(async () => 'failed' as const), sendDismiss: vi.fn(async () => 'ok' as const) };
    await dispatchIntents([notifyIntent], { store, sender });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('a persist failure while pruning a "gone" subscription does not abort the fan-out (review finding C4): NotifyPolicy has already advanced its `last` map for every session in this cycle, so an escaping throw means the un-dispatched intents are never regenerated and the user silently never gets those notifications', async () => {
    const secondIntent: NotifyIntent = { type: 'notify', sessionId: 's2', tag: 'session:s2', title: 'T2', body: 'B2' };
    const store = {
      list: () => [subA, subB],
      remove: vi.fn(() => { throw new Error('ENOSPC: no space left on device, open \'/Users/x/.microviber/push-subscriptions.json.1.tmp\''); }),
    };
    const sender = {
      sendNotify: vi.fn(async (s: { endpoint: string }) => (s.endpoint === subA.endpoint ? 'gone' as const : 'ok' as const)),
      sendDismiss: vi.fn(async () => 'ok' as const),
    };
    const log = vi.fn();
    await expect(dispatchIntents([notifyIntent, secondIntent], { store, sender, log })).resolves.toBeUndefined();
    // 2 intents x 2 subscriptions: the sibling subscription AND the whole second intent survive the failed prune.
    expect(sender.sendNotify).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });

  it('no subscriptions => no sends, no error', async () => {
    const sender = okSender();
    await dispatchIntents([notifyIntent], { store: fakeStore([]), sender });
    expect(sender.sendNotify).not.toHaveBeenCalled();
  });
});

describe('startNotifyLoop', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('PRIMES on the first tick: an already-idle session at startup is not re-notified (launchd restart must not buzz the phone)', async () => {
    const sender = okSender();
    const loop = startNotifyLoop({ listSessions: () => [summary({ state: 'idle' })], intervalMs: 60_000, store: fakeStore(), sender });
    await loop.tick();
    expect(sender.sendNotify).not.toHaveBeenCalled();
    loop.stop();
  });

  it('after priming, a working → idle transition sends a notify with the real title/status line, and idle → working sends a dismiss', async () => {
    let sessions = [summary({ state: 'working', lastPrompt: 'run the tests' })];
    const sender = okSender();
    const loop = startNotifyLoop({ listSessions: () => sessions, intervalMs: 60_000, store: fakeStore([subA]), sender });
    await loop.tick(); // prime
    sessions = [summary({ state: 'idle', lastPrompt: 'run the tests' })];
    await loop.tick();
    expect(sender.sendNotify).toHaveBeenCalledWith(subA, { type: 'notify', tag: 'session:s1', title: 'Fix the tests', body: 'Waiting for you · studio — run the tests', sessionId: 's1' });
    sessions = [summary({ state: 'working' })];
    await loop.tick();
    expect(sender.sendDismiss).toHaveBeenCalledWith(subA, { type: 'dismiss', tag: 'session:s1' });
    loop.stop();
  });

  it('a throwing listSessions is logged and the loop survives to the next tick', async () => {
    let boom = true; const log = vi.fn(); const sender = okSender();
    let sessions = [summary({ state: 'working' })];
    const loop = startNotifyLoop({ listSessions: () => { if (boom) throw new Error('discovery exploded'); return sessions; }, intervalMs: 60_000, store: fakeStore([subA]), sender, log });
    await loop.tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('discovery exploded'));
    boom = false;
    await loop.tick(); // primes now
    sessions = [summary({ state: 'idle' })];
    await loop.tick();
    expect(sender.sendNotify).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('with an EMPTY store a tick does no work at all — no session discovery, no sends (this poll runs every 5s for as long as MV_VAPID_* are set, so zero subscriptions must cost zero: listSessions() is a synchronous full discovery + transcript scan)', async () => {
    const listSessions = vi.fn(() => [summary({ state: 'idle' })]);
    const sender = okSender();
    const loop = startNotifyLoop({ listSessions, store: fakeStore([]), sender, intervalMs: 60_000 });
    await loop.tick();
    expect(listSessions).not.toHaveBeenCalled();
    expect(sender.sendNotify).not.toHaveBeenCalled();
    expect(sender.sendDismiss).not.toHaveBeenCalled();
    loop.stop();
  });

  it('a subscription arriving after the store was empty RE-PRIMES: a session that went idle while nobody was subscribed must not buzz the phone that just opted in, and the cycle after that dispatches normally', async () => {
    const store = swappableStore([subA]);
    const sender = okSender();
    let sessions = [summary({ state: 'working' })];
    const loop = startNotifyLoop({ listSessions: () => sessions, store, sender, intervalMs: 60_000 });
    await loop.tick();                                                    // primes on 'working'
    store.set([]);                                                        // pruned (410) / user unsubscribed
    sessions = [summary({ state: 'idle', lastPrompt: 'run the tests' })]; // goes idle while nothing is watching
    await loop.tick();                                                    // skipped — and un-primed
    store.set([subA]);                                                    // phone opts in again
    await loop.tick();                                                    // must only PRIME on the already-idle session
    expect(sender.sendNotify).not.toHaveBeenCalled();
    expect(sender.sendDismiss).not.toHaveBeenCalled();
    // ...and dispatching is genuinely alive again on the following cycles.
    sessions = [summary({ state: 'working' })];
    await loop.tick();                                                    // idle → working: a real transition
    expect(sender.sendDismiss).toHaveBeenCalledTimes(1);
    sessions = [summary({ state: 'idle', lastPrompt: 'run the tests' })];
    await loop.tick();                                                    // working → idle: a real notify
    expect(sender.sendNotify).toHaveBeenCalledTimes(1);
    expect(sender.sendNotify).toHaveBeenCalledWith(subA, { type: 'notify', tag: 'session:s1', title: 'Fix the tests', body: 'Waiting for you · studio — run the tests', sessionId: 's1' });
    loop.stop();
  });

  it('ticks on the interval and stop() ends it', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => [] as SessionSummary[]);
    // A NON-empty store: listSessions() is the observable for "the interval
    // fired", and an empty store now (correctly) skips the cycle before ever
    // reaching it — see the skip-when-empty test above.
    const loop = startNotifyLoop({ listSessions, intervalMs: 1000, store: fakeStore([subA]), sender: okSender() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(listSessions).toHaveBeenCalledTimes(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it('an in-flight tick is not stacked by the next interval (slow push service)', async () => {
    let release!: () => void;
    const sender = { sendNotify: vi.fn(() => new Promise<'ok'>((res) => { release = () => res('ok'); })), sendDismiss: vi.fn(async () => 'ok' as const) };
    let sessions = [summary({ state: 'working' })];
    const loop = startNotifyLoop({ listSessions: () => sessions, intervalMs: 60_000, store: fakeStore([subA]), sender });
    await loop.tick(); // prime
    sessions = [summary({ state: 'idle' })];
    const slow = loop.tick(); // sendNotify now pending
    await loop.tick();        // must be a no-op while the first is in flight
    expect(sender.sendNotify).toHaveBeenCalledTimes(1);
    release(); await slow;
    loop.stop();
  });
});
