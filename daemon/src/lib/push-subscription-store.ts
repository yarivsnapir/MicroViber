import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PushSubscriptionBody } from '../schemas/api.js';

/**
 * Browser push subscriptions the daemon may send to (story
 * push-notification-dispatch-1, AC3). ON DISK, not in memory: the daemon runs
 * as a launchd agent with KeepAlive, so an in-memory store would mean "restarted
 * overnight ⇒ the phone is silently un-subscribed until the PWA is reopened" —
 * the exact moment the feature exists for. Same fail-closed posture as
 * devports.json: a malformed file throws with its path rather than quietly
 * running with no subscriptions.
 *
 * The file holds credentials-adjacent data (endpoint + the phone's p256dh/auth
 * keys — with the VAPID private key, enough to push to that phone), so it is
 * written 0600 next to the bearer token in ~/.microviber.
 */
const StoredSubscription = PushSubscriptionBody.extend({
  expirationTime: z.number().nullable(),
  createdAt: z.string().min(1),
});
export type StoredSubscription = z.infer<typeof StoredSubscription>;

const StoreFile = z.object({ version: z.literal(1), subscriptions: z.array(StoredSubscription).max(50) }).strict();

/** A personal tool: one phone, maybe a tablet or a second browser. Oldest is evicted past this. */
export const MAX_SUBSCRIPTIONS = 5;

export interface StoreFs {
  readFileIfExists(path: string): string | null;
  writeFileAtomic(path: string, text: string): void;
}

export const nodeStoreFs: StoreFs = {
  readFileIfExists(p) {
    if (!existsSync(p)) return null;
    // statSync is metadata-only — never blocks on a FIFO the way readFileSync would (same guard as devports-config.ts).
    const st = statSync(p);
    if (!st.isFile()) throw new Error(`push subscription store path exists but is not a regular file: ${p}`);
    if (st.size > 1_048_576) throw new Error(`push subscription store too large (>1MiB): ${p}`);
    return readFileSync(p, 'utf8');
  },
  writeFileAtomic(p, text) {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    // fsync the TEMP file before renaming. `renameSync` only orders the
    // directory-entry change — it makes no promise that the file's DATA reached
    // the disk, so on APFS a power loss can leave the rename durable and the
    // bytes not: a truncated or 0-byte store. That is not merely a lost
    // subscription — the constructor fails closed on unparseable JSON, and
    // index.ts builds the store BEFORE app.listen, so main().catch() exits 1 and
    // launchd KeepAlive throttle-restarts the daemon forever until the user
    // deletes a file they have never heard of. Still atomic (write to tmp,
    // single rename) and still 0600 (mode applies on create; rename preserves it).
    const fd = openSync(tmp, 'w', 0o600);
    try {
      const buf = Buffer.from(text, 'utf8');
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  },
};

export class PushSubscriptionStore {
  private subs: StoredSubscription[] = [];

  constructor(private readonly path: string, private readonly fs: StoreFs = nodeStoreFs) {
    const raw = fs.readFileIfExists(path);
    if (raw === null) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) {
      throw new Error(`invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const r = StoreFile.safeParse(parsed);
    if (!r.success) {
      throw new Error(`invalid ${path}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    this.subs = r.data.subscriptions;
  }

  /**
   * A snapshot, not the live array. `readonly` only stops the caller from
   * mutating; it says nothing about the store mutating underneath a caller that
   * already holds the reference — and `upsert()` does exactly that (push, then
   * sort+splice when it crosses the cap). The notify loop iterates this across
   * awaits while a concurrent POST /api/push/subscribe can upsert, so a live
   * array would let the loop skip one phone and double-send to another.
   */
  list(): readonly StoredSubscription[] {
    return [...this.subs];
  }

  /** Keyed by endpoint. A re-POST of a known endpoint refreshes its keys but keeps createdAt (eviction order). */
  upsert(sub: PushSubscriptionBody, nowISO: string): void {
    const existing = this.subs.find((s) => s.endpoint === sub.endpoint);
    if (existing) {
      existing.keys = { ...sub.keys };
      existing.expirationTime = sub.expirationTime ?? null;
    } else {
      this.subs.push({ endpoint: sub.endpoint, keys: { ...sub.keys }, expirationTime: sub.expirationTime ?? null, createdAt: nowISO });
    }
    if (this.subs.length > MAX_SUBSCRIPTIONS) {
      this.subs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.subs.splice(0, this.subs.length - MAX_SUBSCRIPTIONS);
    }
    this.persist();
  }

  /** Called when the push service answers 404/410 — the browser unsubscribed or the service expired it. */
  remove(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length === before) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    this.fs.writeFileAtomic(this.path, JSON.stringify({ version: 1, subscriptions: this.subs }, null, 2) + '\n');
  }
}

/**
 * Loads the store, or returns null after logging. NEVER throws (review finding
 * C1). `index.ts` needs the store built before `app.listen`, and the daemon runs
 * as a launchd agent with `KeepAlive`, so a throw here does not merely disable
 * notifications: `main().catch()` exits 1, launchd restarts, the file is still
 * bad, and the result is a permanent throttled crash loop that takes out the
 * CONTROL PLANE — every remote Claude session — over a notifications file, on a
 * daemon that may never have enabled push at all. Degrading to push-disabled is
 * the fail-SAFE direction (fewer subscriptions, no outbound calls), not fail-open.
 *
 * This also defuses `StoreFile`'s `version: z.literal(1)`: a future format bump
 * would otherwise turn "an older daemon read a newer file" into a boot failure.
 */
export function loadPushStore(
  path: string,
  log: (msg: string) => void,
  fs: StoreFs = nodeStoreFs,
): PushSubscriptionStore | null {
  try {
    return new PushSubscriptionStore(path, fs);
  } catch (e) {
    // Loud, and naming the file: it is not one the user has ever heard of.
    log(`MicroViber: push notifications DISABLED — could not load ${path}: ${e instanceof Error ? e.message : String(e)}`);
    log(`MicroViber: the daemon is otherwise running normally. Fix or delete ${path} and restart to re-enable push.`);
    return null;
  }
}
