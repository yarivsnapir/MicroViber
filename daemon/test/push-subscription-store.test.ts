import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushSubscriptionStore, MAX_SUBSCRIPTIONS, type StoreFs } from '../src/lib/push-subscription-store.js';

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
