import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushSubscriptionStore, MAX_SUBSCRIPTIONS, loadPushStore, type StoreFs } from '../src/lib/push-subscription-store.js';

/**
 * Records the order of the durability-relevant fs calls nodeStoreFs makes while
 * DELEGATING to the real implementations — the real-fs tests below must keep
 * actually touching disk (they assert the 0600 mode and read the file back), so
 * this cannot be a stub.
 */
const fsOps = vi.hoisted(() => ({ order: [] as string[], opened: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rec = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => (...args: A): R => {
    fsOps.order.push(name);
    if (name === 'openSync') fsOps.opened.push(String(args[0]));
    return fn(...args);
  };
  return {
    ...actual,
    openSync: rec('openSync', actual.openSync),
    writeSync: rec('writeSync', actual.writeSync),
    fsyncSync: rec('fsyncSync', actual.fsyncSync),
    closeSync: rec('closeSync', actual.closeSync),
    writeFileSync: rec('writeFileSync', actual.writeFileSync),
    renameSync: rec('renameSync', actual.renameSync),
  };
});

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

/** In-memory StoreFs: what one store writes, the next one reads. */
function memFs(initial: string | null = null): StoreFs & { written: string[] } {
  let content = initial;
  const written: string[] = [];
  return {
    written,
    readFileIfExists: () => content,
    writeFileAtomic: (_p, text) => { content = text; written.push(text); },
  };
}

describe('PushSubscriptionStore (AC3 — on-disk, survives a daemon restart)', () => {
  it('starts empty when the file does not exist', () => {
    expect(new PushSubscriptionStore('/x/subs.json', memFs()).list()).toEqual([]);
  });

  it('upsert persists immediately and round-trips through a fresh store (the restart case)', () => {
    const fs = memFs();
    new PushSubscriptionStore('/x/subs.json', fs).upsert(sub(1), '2026-09-06T10:00:00Z');
    expect(fs.written).toHaveLength(1);
    expect(new PushSubscriptionStore('/x/subs.json', fs).list()).toEqual([
      { ...sub(1), expirationTime: null, createdAt: '2026-09-06T10:00:00Z' },
    ]);
  });

  it('upsert by endpoint replaces the keys but keeps the original createdAt — the PWA re-POSTs on every load, which must not churn the file', () => {
    const fs = memFs();
    const store = new PushSubscriptionStore('/x/subs.json', fs);
    store.upsert(sub(1), '2026-09-06T10:00:00Z');
    store.upsert({ ...sub(1), keys: { p256dh: 'newP', auth: 'newA' } }, '2026-09-06T11:00:00Z');
    expect(store.list()).toEqual([{ endpoint: sub(1).endpoint, keys: { p256dh: 'newP', auth: 'newA' }, expirationTime: null, createdAt: '2026-09-06T10:00:00Z' }]);
  });

  it('remove() drops by endpoint, persists, and reports whether anything was removed', () => {
    const fs = memFs();
    const store = new PushSubscriptionStore('/x/subs.json', fs);
    store.upsert(sub(1), '2026-09-06T10:00:00Z');
    store.upsert(sub(2), '2026-09-06T10:00:01Z');
    expect(store.remove(sub(1).endpoint)).toBe(true);
    expect(store.remove(sub(1).endpoint)).toBe(false);
    expect(store.list().map((s) => s.endpoint)).toEqual([sub(2).endpoint]);
    expect(new PushSubscriptionStore('/x/subs.json', fs).list()).toHaveLength(1);
  });

  it(`caps at ${MAX_SUBSCRIPTIONS} subscriptions, evicting the oldest createdAt`, () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    for (let n = 1; n <= MAX_SUBSCRIPTIONS + 2; n++) store.upsert(sub(n), `2026-09-06T10:00:0${n}Z`);
    expect(store.list()).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(store.list().map((s) => s.endpoint)).not.toContain(sub(1).endpoint);
    expect(store.list().map((s) => s.endpoint)).not.toContain(sub(2).endpoint);
    expect(store.list().map((s) => s.endpoint)).toContain(sub(MAX_SUBSCRIPTIONS + 2).endpoint);
  });

  it('list() returns a snapshot — a concurrent upsert must not mutate an array a caller is already iterating', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    store.upsert(sub(1), '2026-09-06T10:00:00Z');
    const snapshot = store.list();
    store.upsert(sub(2), '2026-09-06T10:00:01Z');
    expect(snapshot).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });

  it('fails closed on malformed JSON, naming the file (like devports.json)', () => {
    expect(() => new PushSubscriptionStore('/x/subs.json', memFs('{ nope'))).toThrow(/invalid \/x\/subs\.json/);
  });

  it('fails closed on a schema violation — an http endpoint edited into the file must not be sent to', () => {
    const bad = JSON.stringify({ version: 1, subscriptions: [{ ...sub(1), endpoint: 'http://127.0.0.1/x', expirationTime: null, createdAt: '2026-09-06T10:00:00Z' }] });
    expect(() => new PushSubscriptionStore('/x/subs.json', memFs(bad))).toThrow(/invalid \/x\/subs\.json/);
  });

  it('real fs: writes 0600, creates the parent dir, and reads back (integration)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-push-store-'));
    const path = join(root, 'nested', 'push-subscriptions.json');
    try {
      new PushSubscriptionStore(path).upsert(sub(1), '2026-09-06T10:00:00Z'); // default nodeStoreFs
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(new PushSubscriptionStore(path).list()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('real fs: fsyncs the temp file BEFORE the rename — a rename only ORDERS writes, it does not make their data durable, and a truncated store makes the daemon crash-loop under launchd KeepAlive', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-push-store-'));
    const path = join(root, 'push-subscriptions.json');
    try {
      fsOps.order.length = 0;
      fsOps.opened.length = 0;
      new PushSubscriptionStore(path).upsert(sub(1), '2026-09-06T10:00:00Z'); // default nodeStoreFs
      // The fsync must land on the TEMP file and must precede the rename;
      // fsyncing after the rename would still leave the window this closes.
      expect(fsOps.order.filter((n) => n === 'fsyncSync' || n === 'renameSync')).toEqual(['fsyncSync', 'renameSync']);
      expect(fsOps.opened).toEqual([`${path}.${process.pid}.tmp`]);
      // Still atomic and still 0600 — the durability fix must not cost either.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(new PushSubscriptionStore(path).list()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('real fs: fails closed on a directory at the path rather than hanging or crashing oddly', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-push-store-'));
    const dirAtPath = join(root, 'push-subscriptions.json');
    mkdirSync(dirAtPath);
    try {
      expect(() => new PushSubscriptionStore(dirAtPath)).toThrow(/not a regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadPushStore — a bad store file must never take the daemon down (review finding C1)', () => {
  it('returns a live store when the file loads', () => {
    const log = vi.fn();
    const store = loadPushStore('/x/subs.json', log, memFs(JSON.stringify({ version: 1, subscriptions: [{ ...sub(1), expirationTime: null, createdAt: '2026-09-06T10:00:00Z' }] })));
    expect(store?.list().map((s) => s.endpoint)).toEqual([sub(1).endpoint]);
    expect(log).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing on a malformed file — index.ts builds the store BEFORE app.listen under a launchd KeepAlive agent, so a throw here is a permanent throttled crash loop that takes out the whole CONTROL PLANE over a notifications file', () => {
    const log = vi.fn();
    let store: ReturnType<typeof loadPushStore>;
    expect(() => { store = loadPushStore('/x/subs.json', log, memFs('{not json')); }).not.toThrow();
    expect(store!).toBeNull();
    // Loudly, and naming the file the user has to fix — it is not one they have heard of.
    expect(log.mock.calls.flat().join(' ')).toContain('/x/subs.json');
    expect(log).toHaveBeenCalled();
  });

  it('returns null on a version bump too — `version: z.literal(1)` would otherwise make any future format change a BOOT failure for an older daemon', () => {
    const log = vi.fn();
    expect(loadPushStore('/x/subs.json', log, memFs(JSON.stringify({ version: 2, subscriptions: [] })))).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('returns null when the path is not a regular file (a read that throws), rather than propagating', () => {
    const log = vi.fn();
    const boom: StoreFs = { readFileIfExists: () => { throw new Error('push subscription store path exists but is not a regular file: /x/subs.json'); }, writeFileAtomic: () => {} };
    expect(loadPushStore('/x/subs.json', log, boom)).toBeNull();
    expect(log.mock.calls.flat().join(' ')).toContain('not a regular file');
  });
});
