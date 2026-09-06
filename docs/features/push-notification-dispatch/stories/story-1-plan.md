# push-notification-dispatch-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing, fully-tested `NotifyPolicy` into a real Web Push sender so the phone gets a push the moment a laptop session goes idle or blocks on `AskUserQuestion`, with the PWA closed.

**Architecture:** The daemon gains a 5-second poll (`services/notify-dispatch.ts`) that feeds `listSessions()` into `NotifyPolicy.reconcile()` and fans every intent out to every stored browser subscription through a thin `web-push` wrapper (`lib/push-sender.ts`). Subscriptions arrive via a new bearer-gated `POST /api/push/subscribe` and persist on disk (`~/.microviber/push-subscriptions.json`, mode 0600) so a daemon restart does not silently un-subscribe the phone. The PWA fetches the VAPID public key from `GET /api/push/config`, subscribes after an explicit "Enable" tap, re-syncs silently on later loads, and handles notification taps (deep link `/?session=<id>` and the service worker's `open-session` message). Push is **opt-in at the daemon**: with `MV_VAPID_*` unset the daemon makes zero outbound calls, exactly as today.

**Tech Stack:** Node 22+ / TypeScript strict (`exactOptionalPropertyTypes`), Fastify 5, zod 3, `web-push` 3.6.7 (+ `@types/web-push`), vitest 4; PWA: Vite 6 + React 19 + Tailwind 4, jsdom tests via `@testing-library/react`.

## Spike outcome (AC1) — recorded before any other code

Run 2026-09-06 from this laptop (script kept in the session scratchpad; results reproduced by Task 10's F19 row):

| Check | Result |
|---|---|
| Transport is real TLS, not self-signed | `tailscale serve status`: `https://yariv-s-macbookpro.taila39b16.ts.net` (443 → 127.0.0.1:8730) and `:8443`, "tailnet only". `INSTALL.md` Stage 2 issues the cert via `tailscale cert` (Let's Encrypt). The story's "self-signed HTTPS" premise is wrong — good news: service workers and `PushManager.subscribe` require a trusted cert, which this already is. |
| Outbound reachability from the laptop to browser push services | `POST https://fcm.googleapis.com/fcm/send/...` → 401; `https://web.push.apple.com/...` → 403; `https://updates.push.services.mozilla.com/wpush/v2/...` → 404. All reachable (4xx = the service answered an unauthenticated probe). |
| `web-push` VAPID key generation, aes128gcm encryption, VAPID JWT signing — offline | ✅ `generateRequestDetails` yields `Content-Encoding: aes128gcm`, `Authorization: vapid t=…, k=…`, `TTL`/`Urgency`/`Topic` headers; 194-byte ciphertext that does not contain the plaintext. |
| A signed request actually leaves this machine | ✅ `webpush.sendNotification` to a synthetic FCM subscription → `WebPushError statusCode=410 "push subscription has unsubscribed or expired"` — the push service received and rejected it. Error shape the sender must handle: `e.statusCode`; 404/410 ⇒ subscription gone ⇒ prune. |
| Real device receives a push | **PENDING — human-only** (manual test checklist). Everything laptop-side is proven. |

**Design tradeoff surfaced (flag, not blocker):** Web Push *necessarily* means the daemon makes an outbound HTTPS POST to a third-party push service chosen by the phone's browser (Google FCM for Chrome/Android, Apple for iOS Safari, Mozilla for Firefox). There is no self-hosted alternative that reaches a closed PWA. This is the daemon's first outbound call ever. Why it is acceptable and how it is contained: (1) the payload is end-to-end encrypted (RFC 8291) — the push service sees ciphertext, an endpoint, and timing, never the session title/status; (2) the VAPID private key never leaves the laptop; (3) it is **opt-in** — no outbound traffic at all unless `MV_VAPID_*` are set; (4) the endpoint URL the daemon POSTs to is validated at the API boundary (`https:` only, no loopback/IP-literal/tailnet/LAN hostnames — T18) so a bearer holder cannot turn the sender into an SSRF probe against the tailnet. The functional spec §4 and `INSTALL.md` Step 3.2 already committed to Web Push, so this proceeds; the spec update (Task 10) records T18.

## Story-vs-codebase reconciliations (read before implementing)

1. **AC4 "session-list refresh loop"** — the daemon has none; `listSessions()` is computed on demand when the PWA polls. Task 4 adds a daemon-owned interval. It must **prime** on its first cycle (discard intents) — a fresh `NotifyPolicy` sees every currently-idle session as a working→idle transition, so a launchd restart would otherwise buzz the phone for every idle session.
2. **AC5 `sw.js`** — the `push` / `dismiss` / `notificationclick` handlers **already exist** (`pwa/public/sw.js`). What's missing is the App side: honor `/?session=<id>` on cold start and the `{type:'open-session'}` message. `sw.js` is not modified.
3. **AC7 vs AC4 on dismiss** — AC7 says a dismiss intent "does not" call the sender; AC4 says dismiss must be honored. `sw.js` already implements dismiss as a *dismiss push* (`{type:'dismiss', tag}` closes the tag's notification). Resolution: the sender has two methods; a dismiss intent never calls `sendNotify` (AC7 holds literally) and does call `sendDismiss`. Additionally every push carries an RFC 8030 `Topic` derived from the tag, so a dismiss queued behind an undelivered notify **replaces** it at the push service — the phone never sees a notification that was already overtaken while it was offline.
4. **AC3 persistence decision: on disk.** The daemon now runs as a launchd agent with KeepAlive; an in-memory store would mean "restarted overnight ⇒ phone never notified again until the PWA is reopened", which defeats the feature. `~/.microviber/push-subscriptions.json`, 0600, atomic write, zod-validated, fail-closed on corruption (names the file, like `devports.json`). The PWA also re-POSTs its subscription on every load once permission is granted (cheap, idempotent).
5. **AC6 key delivery: runtime fetch** (`GET /api/push/config`), not build-time — the PWA build is generic; VAPID keys are per-install.
6. **Known gap to document (AC4):** iOS Safari may throttle/revoke a subscription that receives pushes which show no notification ("silent" pushes). Dismiss pushes are silent by nature. Mitigations already in the design: `Topic` replacement (most dismisses never reach the phone), TTL, and clear-on-open in the PWA. Recorded in the spec (Task 10) — the manual test on the user's real phone is the verdict.

## Global Constraints

- Work in the worktree `microviber/.claude/worktrees/push-notification-dispatch-1` (the shared `microviber/` checkout belongs to another live session). Run every command from that worktree root unless a step says `daemon/` or `pwa/`.
- Quality gate before every commit, from the worktree root: `npm run typecheck && npm run lint && npm test`.
- TS: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (never assign `undefined` to an optional prop — omit it or use `?? null` where the type allows null), no `any` without a `// reason:` comment.
- Layering: `schemas/ → domain/ → services/ → api/`; `lib/` may import `schemas/`; nothing imports upward. FENCE 1: the PWA never imports from `daemon/`. FENCE 2: only `lib/claude-adapter/` may reference `~/.claude` paths — the new files never do.
- `web-push` is CommonJS. Node's ESM interop exposes only `WebPushError` and `default` as named exports (verified). **Always** `import webpush from 'web-push'` and use `webpush.sendNotification` / `webpush.WebPushError`; use `import type { PushSubscription, RequestOptions } from 'web-push'` for types.
- Never read `daemon/.env` or `~/.microviber/token` (org policy). Smoke runs pass a dummy `MV_BEARER_TOKEN` so the daemon does not load the real token file.
- Bearer auth on every `/api/*` route is applied by the existing `onRequest` hook in `app.ts` — new routes get it for free; tests still assert it.
- Commit subjects start with `push-notification-dispatch-1:`.
- Every `Agent` dispatch passes `model: opus` (implementers and reviewers — this story touches auth-gated HTTP surface, so the sonnet path from the skip-guard does not apply).

---

### Task 1: `PushSubscriptionBody` schema + endpoint safety check

**Files:**
- Modify: `daemon/src/schemas/api.ts` (append after `WebpaneTokenBody`)
- Test: `daemon/test/schemas.test.ts` (append)

**Interfaces:**
- Produces: `isSafePushEndpoint(endpoint: string): boolean`; `PushSubscriptionBody` (zod) and `type PushSubscriptionBody = { endpoint: string; expirationTime?: number | null | undefined; keys: { p256dh: string; auth: string } }`. Tasks 2, 5, 7 consume this exact shape.

- [ ] **Step 1: Write the failing tests** — append to `daemon/test/schemas.test.ts`:

```ts
import { PushSubscriptionBody, isSafePushEndpoint } from '../src/schemas/api.js';

describe('isSafePushEndpoint (spec T18 — the daemon POSTs to this URL, so a bearer holder must never aim it at loopback/LAN/tailnet)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QOVnR',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('accepts a public https push-service endpoint: %s', (u) => {
    expect(isSafePushEndpoint(u)).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['loopback IPv4', 'https://127.0.0.1:8730/api/sessions'],
    ['loopback IPv6', 'https://[::1]:8730/'],
    ['localhost', 'https://localhost/x'],
    ['RFC-1918 IP literal', 'https://192.168.1.20/x'],
    ['tailnet IP literal', 'https://100.101.102.103/x'],
    ['tailnet hostname', 'https://laptop.taila39b16.ts.net/api/sessions'],
    ['mDNS .local', 'https://printer.local/x'],
    ['single-label host', 'https://nas/x'],
    ['embedded credentials', 'https://user:pw@fcm.googleapis.com/x'],
    ['not a URL', 'fcm.googleapis.com/fcm/send/abc'],
  ])('rejects %s', (_name, u) => {
    expect(isSafePushEndpoint(u)).toBe(false);
  });
});

describe('PushSubscriptionBody (story push-notification-dispatch-1)', () => {
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } };

  it('accepts the exact shape PushSubscription.toJSON() produces', () => {
    expect(PushSubscriptionBody.parse(good)).toEqual(good);
  });

  it('accepts a body without expirationTime', () => {
    const { expirationTime: _e, ...noExp } = good;
    expect(PushSubscriptionBody.safeParse(noExp).success).toBe(true);
  });

  it('rejects a missing auth key', () => {
    expect(PushSubscriptionBody.safeParse({ ...good, keys: { p256dh: 'BPx' } }).success).toBe(false);
  });

  it('rejects unknown top-level fields — strict, so nothing but the subscription itself is ever persisted', () => {
    expect(PushSubscriptionBody.safeParse({ ...good, userAgent: 'Mozilla/5.0' }).success).toBe(false);
  });

  it('rejects an unsafe endpoint through the schema too', () => {
    expect(PushSubscriptionBody.safeParse({ ...good, endpoint: 'https://127.0.0.1/x' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/schemas.test.ts`
Expected: FAIL — `isSafePushEndpoint` / `PushSubscriptionBody` are not exported.

- [ ] **Step 3: Implement** — append to `daemon/src/schemas/api.ts`:

```ts
/**
 * Web Push endpoint guard (spec T18, story push-notification-dispatch-1). The
 * daemon POSTs encrypted notifications to whatever `endpoint` a subscriber
 * hands it. Even behind bearer auth, that must never become a way to make the
 * daemon issue requests at loopback, the tailnet, or a LAN host — so only a
 * public https hostname is accepted. Browser push services are always public
 * multi-label https hosts (fcm.googleapis.com, web.push.apple.com,
 * updates.push.services.mozilla.com, *.notify.windows.com).
 */
export function isSafePushEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  if (/^[\d.]+$/.test(host)) return false;               // IPv4 literal
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal (URL.hostname keeps the brackets)
  if (!host.includes('.')) return false;                 // single-label names are never public push services
  return true;
}

/** POST /api/push/subscribe — exactly what the browser's PushSubscription.toJSON() returns. */
export const PushSubscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048).refine(isSafePushEndpoint, 'endpoint must be a public https URL'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
}).strict();
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/schemas.test.ts`
Expected: PASS (all new cases green, existing untouched).

- [ ] **Step 5: Gate + commit** (from the worktree root)

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/schemas/api.ts daemon/test/schemas.test.ts
git commit -m "push-notification-dispatch-1: PushSubscriptionBody schema + public-https endpoint guard (T18)"
```

---

### Task 2: On-disk `PushSubscriptionStore`

**Files:**
- Create: `daemon/src/lib/push-subscription-store.ts`
- Test: `daemon/test/push-subscription-store.test.ts`

**Interfaces:**
- Consumes: `PushSubscriptionBody` (Task 1).
- Produces: `class PushSubscriptionStore { constructor(path: string, fs?: StoreFs); list(): readonly StoredSubscription[]; upsert(sub: PushSubscriptionBody, nowISO: string): void; remove(endpoint: string): boolean }`, `interface StoreFs { readFileIfExists(path: string): string | null; writeFileAtomic(path: string, text: string): void }`, `const MAX_SUBSCRIPTIONS = 5`, `type StoredSubscription = PushSubscriptionBody & { createdAt: string }` (its `expirationTime` is always present as `number | null`), `const nodeStoreFs: StoreFs`.

- [ ] **Step 1: Write the failing tests** — create `daemon/test/push-subscription-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/push-subscription-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `daemon/src/lib/push-subscription-store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
    writeFileSync(tmp, text, { mode: 0o600 }); // mode applies on create; rename preserves it
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

  list(): readonly StoredSubscription[] {
    return this.subs;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/push-subscription-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/push-subscription-store.ts daemon/test/push-subscription-store.test.ts
git commit -m "push-notification-dispatch-1: on-disk PushSubscriptionStore (0600, atomic, fail-closed)"
```

---

### Task 3: `web-push` sender wrapper

**Files:**
- Create: `daemon/src/lib/push-sender.ts`
- Test: `daemon/test/push-sender.test.ts`

**Interfaces:**
- Produces: `type NotifyPayload = { type: 'notify'; tag: string; title: string; body: string; sessionId: string }`, `type DismissPayload = { type: 'dismiss'; tag: string }`, `type SendOutcome = 'ok' | 'gone' | 'failed'`, `interface PushSender { sendNotify(sub: PushSubscription, p: NotifyPayload): Promise<SendOutcome>; sendDismiss(sub: PushSubscription, p: DismissPayload): Promise<SendOutcome> }`, `type SendFn = (sub: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>`, `createPushSender(vapid: { publicKey: string; privateKey: string }, deps?: { send?: SendFn; log?: (msg: string) => void }): PushSender`, `topicFor(tag: string): string`, constants `VAPID_SUBJECT`, `NOTIFY_TTL_S`, `DISMISS_TTL_S`. (`PushSubscription`/`RequestOptions` are `web-push`'s own types; a `StoredSubscription` from Task 2 is structurally a `PushSubscription`.)
- The payload JSON shapes are **exactly** what `pwa/public/sw.js` already parses (`p.type`, `p.tag`, `p.title`, `p.body`, `p.sessionId`).

- [ ] **Step 1: Write the failing tests** — create `daemon/test/push-sender.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import webpush from 'web-push';
import { createPushSender, topicFor, NOTIFY_TTL_S, DISMISS_TTL_S, VAPID_SUBJECT, type SendFn } from '../src/lib/push-sender.js';

const vapid = { publicKey: 'BPUBLIC', privateKey: 'PRIVATE' };
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' } };
const notify = { type: 'notify' as const, tag: 'session:s1', title: 'Fix the tests', body: 'Waiting for you · studio', sessionId: 's1' };
const dismiss = { type: 'dismiss' as const, tag: 'session:s1' };

describe('topicFor (RFC 8030 §5.4 — a later push with the same Topic replaces an undelivered earlier one)', () => {
  it('is exactly 32 URL-safe chars, deterministic, and never the raw tag', () => {
    const t = topicFor('session:0b8e1c3a-7d2f-4e9b-9a1c-2f3e4d5c6b7a');
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicFor('session:x')).toBe(topicFor('session:x'));
    expect(t).not.toContain('session');
  });

  it('differs per session', () => {
    expect(topicFor('session:a')).not.toBe(topicFor('session:b'));
  });
});

describe('createPushSender', () => {
  it('sendNotify: the JSON sw.js expects, high urgency, notify TTL, per-tag Topic, VAPID details', async () => {
    const send = vi.fn<SendFn>(async () => ({}));
    const r = await createPushSender(vapid, { send }).sendNotify(sub, notify);
    expect(r).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    const [gotSub, payload, opts] = send.mock.calls[0]!;
    expect(gotSub).toBe(sub);
    expect(JSON.parse(payload)).toEqual(notify);
    expect(opts).toEqual({ vapidDetails: { subject: VAPID_SUBJECT, ...vapid }, TTL: NOTIFY_TTL_S, urgency: 'high', topic: topicFor('session:s1') });
  });

  it('sendDismiss: {type:"dismiss", tag}, normal urgency, dismiss TTL, and the SAME Topic as the notify it cancels', async () => {
    const send = vi.fn<SendFn>(async () => ({}));
    const r = await createPushSender(vapid, { send }).sendDismiss(sub, dismiss);
    expect(r).toBe('ok');
    const [, payload, opts] = send.mock.calls[0]!;
    expect(JSON.parse(payload)).toEqual(dismiss);
    expect(opts).toEqual({ vapidDetails: { subject: VAPID_SUBJECT, ...vapid }, TTL: DISMISS_TTL_S, urgency: 'normal', topic: topicFor('session:s1') });
  });

  it.each([404, 410])('a %i from the push service => "gone" (the caller prunes), never a throw', async (status) => {
    const send = vi.fn<SendFn>(async () => { throw new webpush.WebPushError('rejected', status, {}, 'push subscription has unsubscribed or expired', sub.endpoint); });
    await expect(createPushSender(vapid, { send }).sendNotify(sub, notify)).resolves.toBe('gone');
  });

  it('any other failure => "failed", logged, never thrown — a flaky push service must not kill the notify loop', async () => {
    const log = vi.fn();
    const send = vi.fn<SendFn>(async () => { throw new Error('ECONNRESET'); });
    await expect(createPushSender(vapid, { send, log }).sendNotify(sub, notify)).resolves.toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
  });

  it('a 5xx is "failed" too (transient — keep the subscription)', async () => {
    const send = vi.fn<SendFn>(async () => { throw new webpush.WebPushError('busy', 503, {}, '', sub.endpoint); });
    await expect(createPushSender(vapid, { send }).sendDismiss(sub, dismiss)).resolves.toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/push-sender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `daemon/src/lib/push-sender.ts`:

```ts
import webpush from 'web-push'; // default import ONLY: Node's CJS interop exposes no `sendNotification` named export
import type { PushSubscription, RequestOptions } from 'web-push';
import { createHash } from 'node:crypto';

/**
 * Thin Web Push sender (story push-notification-dispatch-1, AC2). Lives in
 * lib/ next to webpane/, NOT in lib/claude-adapter/ — it knows nothing about
 * Claude Code. This is the daemon's ONLY outbound network call (spec T18):
 * an https POST to the push service the phone's browser chose, carrying an
 * aes128gcm-encrypted payload the service cannot read. Never constructed
 * unless MV_VAPID_* are configured (index.ts), so a daemon without keys makes
 * no outbound calls at all.
 */
export type NotifyPayload = { type: 'notify'; tag: string; title: string; body: string; sessionId: string };
export type DismissPayload = { type: 'dismiss'; tag: string };
export type SendOutcome = 'ok' | 'gone' | 'failed';

export interface PushSender {
  sendNotify(sub: PushSubscription, payload: NotifyPayload): Promise<SendOutcome>;
  sendDismiss(sub: PushSubscription, payload: DismissPayload): Promise<SendOutcome>;
}

export type SendFn = (sub: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

/** VAPID `sub` claim (RFC 8292 §2.1): how a push-service operator reaches this app server's owner. A public repo URL is the honest contact for a single-user tool. */
export const VAPID_SUBJECT = 'https://github.com/yarivsnapir/MicroViber';
/** An idle session is still worth knowing about an hour later; staleness is handled by Topic replacement, not a short TTL. */
export const NOTIFY_TTL_S = 3600;
/** Must outlive the notify it cancels while the phone is offline. */
export const DISMISS_TTL_S = 3600;

/**
 * RFC 8030 §5.4 Topic: ≤32 URL-safe base64 chars. Pushes sharing a topic
 * REPLACE each other while undelivered, so a dismiss queued behind an
 * undelivered notify cancels it before the phone ever sees it — the
 * push-service-side twin of sw.js's tag-keyed replace-not-stack. Hashed
 * because a raw session tag is longer than 32 chars and need not travel.
 */
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

export function createPushSender(
  vapid: { publicKey: string; privateKey: string },
  deps: { send?: SendFn; log?: (msg: string) => void } = {},
): PushSender {
  const send: SendFn = deps.send ?? ((s, p, o) => webpush.sendNotification(s, p, o));
  const log = deps.log ?? (() => {});
  const vapidDetails = { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey };

  async function deliver(sub: PushSubscription, payload: NotifyPayload | DismissPayload, ttl: number, urgency: 'high' | 'normal'): Promise<SendOutcome> {
    try {
      await send(sub, JSON.stringify(payload), { vapidDetails, TTL: ttl, urgency, topic: topicFor(payload.tag) });
      return 'ok';
    } catch (e) {
      const status = e instanceof webpush.WebPushError ? e.statusCode : undefined;
      if (status === 404 || status === 410) return 'gone';
      log(`push: ${payload.type} to ${new URL(sub.endpoint).host} failed: ${status ?? (e instanceof Error ? e.message : String(e))}`);
      return 'failed';
    }
  }

  return {
    sendNotify: (sub, p) => deliver(sub, p, NOTIFY_TTL_S, 'high'),
    sendDismiss: (sub, p) => deliver(sub, p, DISMISS_TTL_S, 'normal'),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/push-sender.test.ts`
Expected: PASS (7 tests). If TypeScript complains about `webpush.WebPushError` not being a type, `@types/web-push` declares `export class WebPushError` — the default-import namespace carries it; do not switch to a named import.

- [ ] **Step 5: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/lib/push-sender.ts daemon/test/push-sender.test.ts
git commit -m "push-notification-dispatch-1: web-push sender (VAPID, aes128gcm, Topic replace, gone/failed outcomes)"
```

---

### Task 4: Notify dispatch loop — `NotifyPolicy` → sender

**Files:**
- Create: `daemon/src/services/notify-dispatch.ts`
- Test: `daemon/test/notify-dispatch.test.ts` (new), `daemon/test/notify-policy.test.ts` (append AC7 wiring tests)

**Interfaces:**
- Consumes: `NotifyPolicy`, `NotifyIntent` (`domain/notify-policy.ts`, unmodified); `PushSender` (Task 3); `PushSubscriptionStore` (Task 2); `SessionSummary` (`domain/registry.ts`).
- Produces: `statusLineFor(s: Pick<SessionSummary, 'state' | 'folder' | 'lastPrompt'>): string`, `toNotifyInput(sessions: readonly SessionSummary[])`, `dispatchIntents(intents: readonly NotifyIntent[], deps: DispatchDeps): Promise<void>`, `interface DispatchDeps { store: Pick<PushSubscriptionStore, 'list' | 'remove'>; sender: PushSender; log?: (msg: string) => void }`, `startNotifyLoop(opts: DispatchDeps & { listSessions(): SessionSummary[]; intervalMs: number; policy?: NotifyPolicy }): NotifyLoop`, `interface NotifyLoop { tick(): Promise<void>; stop(): void }`.

- [ ] **Step 1: Write the failing AC7 tests** — append to `daemon/test/notify-policy.test.ts` (add `vi` to the existing vitest import):

```ts
import { dispatchIntents } from '../src/services/notify-dispatch.js';

describe('NotifyPolicy → sender wiring (AC7, story push-notification-dispatch-1)', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' }, expirationTime: null, createdAt: '2026-09-06T10:00:00Z' };
  const store = { list: () => [sub], remove: vi.fn(() => true) };
  const sender = () => ({ sendNotify: vi.fn(async () => 'ok' as const), sendDismiss: vi.fn(async () => 'ok' as const) });

  it("a 'notify' intent results in exactly one sendNotify per subscription, carrying title + status line + tag + sessionId", async () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'working', title: 'Fix the tests' }]);
    const intents = np.reconcile([{ id: 's1', state: 'idle', title: 'Fix the tests', statusLine: 'Waiting for you · studio' }]);
    const s = sender();
    await dispatchIntents(intents, { store, sender: s });
    expect(s.sendNotify).toHaveBeenCalledTimes(1);
    expect(s.sendNotify).toHaveBeenCalledWith(sub, { type: 'notify', tag: 'session:s1', title: 'Fix the tests', body: 'Waiting for you · studio', sessionId: 's1' });
    expect(s.sendDismiss).not.toHaveBeenCalled();
  });

  it("a 'dismiss' intent does NOT call sendNotify — it goes out as a dismiss push instead (sw.js closes that tag; AC7 reconciled with AC4)", async () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
    const intents = np.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
    const s = sender();
    await dispatchIntents(intents, { store, sender: s });
    expect(s.sendNotify).not.toHaveBeenCalled();
    expect(s.sendDismiss).toHaveBeenCalledTimes(1);
    expect(s.sendDismiss).toHaveBeenCalledWith(sub, { type: 'dismiss', tag: 'session:s1' });
  });
});
```

- [ ] **Step 2: Write the failing dispatch/loop tests** — create `daemon/test/notify-dispatch.test.ts`:

```ts
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
const okSender = () => ({ sendNotify: vi.fn(async () => 'ok' as const), sendDismiss: vi.fn(async () => 'ok' as const) });
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

  it('ticks on the interval and stop() ends it', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => [] as SessionSummary[]);
    const loop = startNotifyLoop({ listSessions, intervalMs: 1000, store: fakeStore([]), sender: okSender() });
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cd daemon && npx vitest run test/notify-dispatch.test.ts test/notify-policy.test.ts`
Expected: FAIL — `services/notify-dispatch.js` not found.

- [ ] **Step 4: Implement** — create `daemon/src/services/notify-dispatch.ts`:

```ts
import type { SessionSummary } from '../domain/registry.js';
import { NotifyPolicy, type NotifyIntent } from '../domain/notify-policy.js';
import type { PushSender } from '../lib/push-sender.js';
import type { PushSubscriptionStore } from '../lib/push-subscription-store.js';

const STATE_PHRASE: Record<SessionSummary['state'], string> = {
  idle: 'Waiting for you',
  'awaiting-input': 'Needs your answer',
  working: 'Working',
  stale: 'Ended',
};
const STATUS_LINE_MAX = 100;

/**
 * The notification body (functional spec §4: "a short status line about what
 * the session was doing"): why it fired + where, then the last prompt. One
 * line — lock screens truncate anyway. NotifyPolicy stays unmodified; it just
 * receives this as `statusLine`.
 */
export function statusLineFor(s: Pick<SessionSummary, 'state' | 'folder' | 'lastPrompt'>): string {
  const head = `${STATE_PHRASE[s.state]} · ${s.folder}`;
  const prompt = (s.lastPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return head;
  const clipped = prompt.length > STATUS_LINE_MAX ? prompt.slice(0, STATUS_LINE_MAX - 1) + '…' : prompt;
  return `${head} — ${clipped}`;
}

export function toNotifyInput(sessions: readonly SessionSummary[]): { id: string; state: SessionSummary['state']; title: string; statusLine: string }[] {
  return sessions.map((s) => ({ id: s.id, state: s.state, title: s.title, statusLine: statusLineFor(s) }));
}

export interface DispatchDeps {
  store: Pick<PushSubscriptionStore, 'list' | 'remove'>;
  sender: PushSender;
  log?: (msg: string) => void;
}

/**
 * Fans each intent out to every stored subscription. A 'notify' goes out as a
 * notify push; a 'dismiss' goes out as a dismiss push (sw.js closes the tag —
 * AC7 as reconciled with AC4: a dismiss NEVER calls sendNotify). 'gone'
 * (404/410) prunes that one subscription — the browser unsubscribed or the
 * service expired it; retrying forever would only spam a dead endpoint.
 */
export async function dispatchIntents(intents: readonly NotifyIntent[], deps: DispatchDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  for (const intent of intents) {
    for (const sub of [...deps.store.list()]) { // copy: remove() mutates the store's list
      const outcome = intent.type === 'notify'
        ? await deps.sender.sendNotify(sub, { type: 'notify', tag: intent.tag, title: intent.title, body: intent.body, sessionId: intent.sessionId })
        : await deps.sender.sendDismiss(sub, { type: 'dismiss', tag: intent.tag });
      if (outcome === 'gone') {
        deps.store.remove(sub.endpoint);
        log(`push: pruned expired subscription at ${new URL(sub.endpoint).host}`);
      }
    }
  }
}

export interface NotifyLoop {
  /** One reconcile-and-dispatch cycle. Exposed for tests and for a deliberate immediate run. */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * The daemon-side poll that turns session-state transitions into pushes (AC4).
 * The PWA's own 4s poll cannot do this — the whole point is the phone with
 * the PWA CLOSED. The first cycle only PRIMES the policy: every session is
 * "new" to a fresh NotifyPolicy, so without priming a daemon restart would
 * re-notify every currently-idle session (a launchd KeepAlive restart at 3am
 * must not buzz the phone about sessions the user already knew about).
 */
export function startNotifyLoop(opts: DispatchDeps & { listSessions(): SessionSummary[]; intervalMs: number; policy?: NotifyPolicy }): NotifyLoop {
  const policy = opts.policy ?? new NotifyPolicy();
  const log = opts.log ?? (() => {});
  let primed = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return; // a slow push service must not stack overlapping cycles
    inFlight = true;
    try {
      const intents = policy.reconcile(toNotifyInput(opts.listSessions()));
      if (!primed) { primed = true; return; }
      if (intents.length > 0) await dispatchIntents(intents, opts);
    } catch (e) {
      log(`push: notify cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, opts.intervalMs);
  if (typeof (timer as { unref?: unknown }).unref === 'function') (timer as { unref(): void }).unref(); // never the thing keeping the process alive
  return { tick, stop: () => clearInterval(timer) };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd daemon && npx vitest run test/notify-dispatch.test.ts test/notify-policy.test.ts`
Expected: PASS (existing 8 policy tests + 2 wiring + 14 dispatch/loop). If the fake-timer test fails on `unref`, the guard above already tolerates timers without it — check `vi.useFakeTimers()` is called before `startNotifyLoop`.

- [ ] **Step 6: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/services/notify-dispatch.ts daemon/test/notify-dispatch.test.ts daemon/test/notify-policy.test.ts
git commit -m "push-notification-dispatch-1: notify dispatch loop — NotifyPolicy → push sender, primed on start, prunes gone subscriptions"
```

---

### Task 5: API — `GET /api/push/config`, `POST /api/push/subscribe`, services wiring

**Files:**
- Modify: `daemon/src/api/app.ts` (`AppDeps` interface + two routes after `/api/webpane-token`; import `PushSubscriptionBody`)
- Modify: `daemon/src/services/services.ts` (`createServices` signature + two new deps)
- Test: `daemon/test/app.test.ts` (extend `deps()` factory + new describe), `daemon/test/services.test.ts` (append)

**Interfaces:**
- Consumes: `PushSubscriptionBody` (Task 1), `PushSubscriptionStore` (Task 2).
- Produces: `AppDeps.getPushConfig(): { enabled: boolean; publicKey: string | null }`, `AppDeps.subscribePush(sub: PushSubscriptionBody): void` (throws `{ code: 'INVALID_INPUT' }` when push is not configured); `createServices(config, auditSink, opts?: { pushStore?: PushSubscriptionStore })`. Task 6 passes the store; Task 7's PWA client calls the two routes.
- Routes: `GET /api/push/config` → `{ success: true, data: { enabled, publicKey } }`; `POST /api/push/subscribe` → `{ success: true, data: { ok: true } }` | 400 `INVALID_INPUT`. Both bearer-gated by the existing hook.

- [ ] **Step 1: Write the failing route tests** — in `daemon/test/app.test.ts`, first extend the `deps()` factory (TypeScript will otherwise reject the object):

```ts
    readLocalFile: () => null,
    getPushConfig: () => ({ enabled: true, publicKey: 'BPUBLICKEY' }),
    subscribePush: () => {},
    ...over,
```

then append:

```ts
describe('Web Push routes (story push-notification-dispatch-1)', () => {
  const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPx', auth: 'aX' } };
  const json = { ...auth, 'content-type': 'application/json' };

  it('GET /api/push/config requires the bearer (401 without)', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/push/config', headers: { host: 'laptop.ts.net' } });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/push/config returns enabled + the VAPID public key', async () => {
    const r = await buildApp(deps()).inject({ method: 'GET', url: '/api/push/config', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { enabled: true, publicKey: 'BPUBLICKEY' } });
  });

  it('POST /api/push/subscribe requires the bearer (401 without)', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/push/subscribe', headers: { host: 'laptop.ts.net', 'content-type': 'application/json' }, payload: body });
    expect(r.statusCode).toBe(401);
  });

  it('POST /api/push/subscribe 400 INVALID_INPUT on a body that is not a PushSubscription', async () => {
    const r = await buildApp(deps()).inject({ method: 'POST', url: '/api/push/subscribe', headers: json, payload: { hello: 'world' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_INPUT');
  });

  it('POST /api/push/subscribe 400 on a loopback endpoint — T18 SSRF guard enforced at the boundary, not only in the store', async () => {
    const subscribePush = vi.fn();
    const r = await buildApp(deps({ subscribePush })).inject({ method: 'POST', url: '/api/push/subscribe', headers: json, payload: { ...body, endpoint: 'https://127.0.0.1:8730/api/sessions' } });
    expect(r.statusCode).toBe(400);
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it('POST /api/push/subscribe passes the parsed body to deps.subscribePush and returns {ok:true}', async () => {
    const subscribePush = vi.fn();
    const r = await buildApp(deps({ subscribePush })).inject({ method: 'POST', url: '/api/push/subscribe', headers: json, payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { ok: true } });
    expect(subscribePush).toHaveBeenCalledWith(body);
  });

  it('POST /api/push/subscribe maps a not-configured rejection to 400 INVALID_INPUT with the daemon\'s message', async () => {
    const r = await buildApp(deps({
      subscribePush: () => { throw Object.assign(new Error('push notifications are not configured on this daemon'), { code: 'INVALID_INPUT' }); },
    })).inject({ method: 'POST', url: '/api/push/subscribe', headers: json, payload: body });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ success: false, error: { code: 'INVALID_INPUT', message: 'push notifications are not configured on this daemon' } });
  });
});
```

- [ ] **Step 2: Write the failing services tests** — append to `daemon/test/services.test.ts`:

```ts
import { PushSubscriptionStore, type StoreFs } from '../src/lib/push-subscription-store.js';

describe('createServices — Web Push (story push-notification-dispatch-1)', () => {
  const memFs = (): StoreFs => { let c: string | null = null; return { readFileIfExists: () => c, writeFileAtomic: (_p, t) => { c = t; } }; };
  const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPx', auth: 'aX' } };

  it('without MV_VAPID_*: config reports disabled + null key, and subscribePush rejects INVALID_INPUT (opt-in — no keys, no outbound calls, nothing stored)', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    const services = createServices(config, () => {}, { pushStore: store }); // `config` above has vapid: null
    expect(services.getPushConfig()).toEqual({ enabled: false, publicKey: null });
    expect(() => services.subscribePush(body)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(store.list()).toEqual([]);
  });

  it('with VAPID configured: config exposes the public key and subscribePush upserts into the store', () => {
    const store = new PushSubscriptionStore('/x/subs.json', memFs());
    const services = createServices({ ...config, vapid: { publicKey: 'BPUB', privateKey: 'PRIV' } }, () => {}, { pushStore: store });
    expect(services.getPushConfig()).toEqual({ enabled: true, publicKey: 'BPUB' });
    services.subscribePush(body);
    expect(store.list().map((s) => s.endpoint)).toEqual([body.endpoint]);
  });

  it('with VAPID configured but no store injected (tests / legacy callers): disabled, and subscribePush rejects rather than pretending', () => {
    const services = createServices({ ...config, vapid: { publicKey: 'BPUB', privateKey: 'PRIV' } }, () => {});
    expect(services.getPushConfig().enabled).toBe(false);
    expect(() => services.subscribePush(body)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd daemon && npx tsc --noEmit && npx vitest run test/app.test.ts test/services.test.ts`
Expected: typecheck FAILS (`getPushConfig`/`subscribePush` not in `AppDeps`; `createServices` takes 2 args) — that is the RED signal for this task.

- [ ] **Step 4: Implement `AppDeps` + routes** — in `daemon/src/api/app.ts`:

Import: change the `schemas/api.js` import line to also bring in `PushSubscriptionBody`:
```ts
import { WebpaneTokenBody, SendPromptBody, PushSubscriptionBody, errorEnvelope, HTTP_STATUS, type ErrorCode } from '../schemas/api.js';
```

Append to the `AppDeps` interface (after `readLocalFile`):
```ts
  /** Web Push (story push-notification-dispatch-1): whether the daemon can send at all (MV_VAPID_* set) and the VAPID public key the PWA subscribes with. */
  getPushConfig(): { enabled: boolean; publicKey: string | null };
  /** Persist a browser PushSubscription for the notify loop to send to. Throws { code: 'INVALID_INPUT' } when push is not configured. */
  subscribePush(sub: PushSubscriptionBody): void;
```

Add the routes right after the `app.post('/api/webpane-token', …)` handler:
```ts
  // ── Web Push (story push-notification-dispatch-1) ──
  // Both bearer-gated by the onRequest hook above like every /api/* route.
  app.get('/api/push/config', async () => ({ success: true, data: deps.getPushConfig() }));

  app.post('/api/push/subscribe', async (req, reply) => {
    // T18: the schema's endpoint refinement is what keeps a bearer holder from
    // pointing the daemon's one outbound call at loopback/tailnet/LAN.
    const parsed = PushSubscriptionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'invalid push subscription'));
    try {
      deps.subscribePush(parsed.data);
      return { success: true, data: { ok: true } };
    } catch (e) {
      const raw = (e as { code?: string }).code;
      const code: ErrorCode = raw === 'INVALID_INPUT' ? raw : 'INTERNAL_ERROR';
      return reply.code(HTTP_STATUS[code]).send(errorEnvelope(code, (e as Error).message));
    }
  });
```

- [ ] **Step 5: Implement services wiring** — in `daemon/src/services/services.ts`:

Add the import:
```ts
import type { PushSubscriptionStore } from '../lib/push-subscription-store.js';
```

Change the signature:
```ts
export function createServices(
  config: Config,
  auditSink: (line: string) => void,
  opts: { pushStore?: PushSubscriptionStore } = {},
): AppDeps {
```

Append to the returned object (after `readLocalFile,`):
```ts
    getPushConfig() {
      // Enabled only when BOTH the keys and a place to keep subscriptions exist;
      // index.ts always injects the store, so in production this is "are
      // MV_VAPID_* set" — the daemon's one opt-in to outbound traffic (T18).
      const enabled = config.vapid !== null && opts.pushStore !== undefined;
      return { enabled, publicKey: enabled && config.vapid ? config.vapid.publicKey : null };
    },
    subscribePush(sub) {
      if (!config.vapid || !opts.pushStore) {
        throw Object.assign(new Error('push notifications are not configured on this daemon (set MV_VAPID_PUBLIC_KEY / MV_VAPID_PRIVATE_KEY — INSTALL.md Step 3.2)'), { code: 'INVALID_INPUT' });
      }
      opts.pushStore.upsert(sub, new Date().toISOString());
    },
```

- [ ] **Step 6: Run to verify pass**

Run: `cd daemon && npx tsc --noEmit && npx vitest run test/app.test.ts test/services.test.ts`
Expected: PASS. Note `expect(...).toThrow(expect.objectContaining(...))` works in vitest 4; if it does not, replace with `try { … } catch (e) { expect((e as { code?: string }).code).toBe('INVALID_INPUT'); }`.

- [ ] **Step 7: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/app.test.ts daemon/test/services.test.ts
git commit -m "push-notification-dispatch-1: GET /api/push/config + POST /api/push/subscribe (bearer, T18 endpoint guard), services wiring"
```

---

### Task 6: Daemon entrypoint — construct the store, start the loop (opt-in)

**Files:**
- Modify: `daemon/src/index.ts`

**Interfaces:**
- Consumes: `PushSubscriptionStore` (Task 2), `createPushSender` (Task 3), `startNotifyLoop` (Task 4), `createServices(config, sink, { pushStore })` (Task 5).
- Produces: the running behavior. `~/.microviber/push-subscriptions.json` is the store path; the poll interval is 5 s.

- [ ] **Step 1: Implement** — edit `daemon/src/index.ts`:

Imports (add after the existing ones):
```ts
import { PushSubscriptionStore } from './lib/push-subscription-store.js';
import { createPushSender } from './lib/push-sender.js';
import { startNotifyLoop } from './services/notify-dispatch.js';
```

Constants (after `auditPath`):
```ts
const pushStorePath = join(stateDir, 'push-subscriptions.json');
// Same order of magnitude as the PWA's own 4s session poll; discovery is a
// synchronous filesystem scan, so this must not be aggressive.
const NOTIFY_POLL_MS = 5_000;
```

Replace the `createServices(...)` call with:
```ts
  // Push subscriptions persist across restarts (AC3) — a launchd KeepAlive
  // restart must not silently un-subscribe the phone. Throws with the file path
  // on a malformed file (fail closed, like devports.json).
  const pushStore = new PushSubscriptionStore(pushStorePath);
  const services = createServices(config, (line) => {
    try { appendFileSync(auditPath, line); } catch { /* audit best-effort */ }
  }, { pushStore });
```

After the pairing-URL `console.log`, add:
```ts
  // Web Push is opt-in (spec T18): with no VAPID keys the daemon makes no
  // outbound network call whatsoever — exactly its pre-story posture.
  if (config.vapid) {
    const sender = createPushSender(config.vapid, { log: (m) => console.error(m) });
    startNotifyLoop({ listSessions: services.listSessions, store: pushStore, sender, intervalMs: NOTIFY_POLL_MS, log: (m) => console.error(m) });
    console.log(`Push notifications: enabled — ${pushStore.list().length} subscription(s) in ${pushStorePath}; polling every ${NOTIFY_POLL_MS / 1000}s`);
  } else {
    console.log('Push notifications: disabled (MV_VAPID_PUBLIC_KEY / MV_VAPID_PRIVATE_KEY unset — INSTALL.md Step 3.2). No outbound calls are made while disabled.');
  }
```

- [ ] **Step 2: Typecheck + build**

Run (worktree root): `npm run typecheck && npm --prefix daemon run build`
Expected: exit 0; `daemon/dist/index.js` updated.

- [ ] **Step 3: Smoke-run both branches without touching the real daemon, token, or .env**

Use a dummy bearer so the daemon never reads `~/.microviber/token`, a free port, and the pwa build if present. Run from `daemon/`:

```bash
# disabled branch
MV_BIND_ADDRESS=127.0.0.1 MV_PORT=8799 MV_WEBPANE_CONTENT_PORT=8798 MV_BEARER_TOKEN=smoke-token-0123456789abcdef0123456789 \
  timeout 4 node dist/index.js 2>&1 | grep -E "listening|Push notifications"
```
Expected: `MicroViber daemon listening on 127.0.0.1:8799` and `Push notifications: disabled (...)`.

```bash
# enabled branch — throwaway keys, generated fresh
KEYS=$(node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
MV_VAPID_PUBLIC_KEY=${KEYS% *} MV_VAPID_PRIVATE_KEY=${KEYS#* } MV_BIND_ADDRESS=127.0.0.1 MV_PORT=8799 MV_WEBPANE_CONTENT_PORT=8798 MV_BEARER_TOKEN=smoke-token-0123456789abcdef0123456789 \
  timeout 4 node dist/index.js 2>&1 | grep -E "listening|Push notifications"
```
Expected: `Push notifications: enabled — 0 subscription(s) in /Users/…/.microviber/push-subscriptions.json; polling every 5s`. (No file is created until a subscription is POSTed.) If `timeout` is missing on macOS, use `( node dist/index.js & sleep 4; kill $! ) 2>&1 | grep …`.

- [ ] **Step 4: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add daemon/src/index.ts
git commit -m "push-notification-dispatch-1: daemon entrypoint — persistent store, opt-in notify loop, startup status line"
```

---

### Task 7: PWA — API client + `lib/push.ts` (subscribe flow, deep-link helpers)

**Files:**
- Modify: `pwa/src/lib/api.ts` (two methods in the returned object)
- Create: `pwa/src/lib/push.ts`
- Test: `pwa/test/push.test.ts`

**Interfaces:**
- Consumes: `GET /api/push/config`, `POST /api/push/subscribe` (Task 5).
- Produces: `Api.getPushConfig(): Promise<{ enabled: boolean; publicKey: string | null }>`, `Api.subscribePush(subscription: PushSubscriptionJSON): Promise<void>`; from `lib/push.ts`: `isPushSupported(): boolean`, `urlBase64ToUint8Array(b64: string): Uint8Array`, `applicationServerKeyMatches(sub: PushSubscription, publicKey: string): boolean`, `type PushSetupResult = 'subscribed' | 'disabled' | 'unsupported' | 'denied' | 'not-granted' | 'failed'`, `ensurePushSubscription(api: Pick<Api, 'getPushConfig' | 'subscribePush'>, opts: { interactive: boolean }): Promise<PushSetupResult>`, `sessionFromUrl(loc: { search: string }): string | null`, `tagForSession(id: string): string`, `dismissSessionNotification(id: string, sw?: ServiceWorkerContainer | undefined): void`, `onOpenSessionMessage(handler: (id: string) => void, sw?: ServiceWorkerContainer | undefined): () => void`. Tasks 8–9 consume these.

- [ ] **Step 1: Write the failing tests** — create `pwa/test/push.test.ts`:

```ts
// @vitest-environment jsdom
// pwa/test/push.test.ts — story push-notification-dispatch-1 (AC5/AC6 client side)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    subscribe: vi.fn(async () => created),
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
    const arg = pushManager.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(arg.userVisibleOnly).toBe(true);
    expect([...arg.applicationServerKey]).toEqual([...urlBase64ToUint8Array(PUBLIC_KEY)]);
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

  it('applicationServerKeyMatches compares bytes', () => {
    expect(applicationServerKeyMatches(fakeSubscription(urlBase64ToUint8Array(PUBLIC_KEY)) as unknown as PushSubscription, PUBLIC_KEY)).toBe(true);
    expect(applicationServerKeyMatches(fakeSubscription(new Uint8Array([1])) as unknown as PushSubscription, PUBLIC_KEY)).toBe(false);
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
    expect(() => dismissSessionNotification('s1', undefined)).not.toThrow();
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/push.test.ts`
Expected: FAIL — `../src/lib/push.js` not found.

- [ ] **Step 3: Implement the API methods** — in `pwa/src/lib/api.ts`, add inside the returned object (before `openStream`):

```ts
    /** Web Push (story push-notification-dispatch-1): can the daemon send, and with which VAPID public key. */
    getPushConfig: () => get<{ enabled: boolean; publicKey: string | null }>('/api/push/config'),
    /** Register this browser's PushSubscription with the daemon (idempotent by endpoint). */
    subscribePush: async (subscription: PushSubscriptionJSON): Promise<void> => {
      const r = await fetch(`${baseUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
    },
```

- [ ] **Step 4: Implement `lib/push.ts`** — create `pwa/src/lib/push.ts`:

```ts
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
  if (permission === 'default' && opts.interactive) permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'not-granted';

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !applicationServerKeyMatches(sub, publicKey)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
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
```

- [ ] **Step 5: Run to verify pass**

Run: `cd pwa && npx tsc --noEmit && npx vitest run test/push.test.ts`
Expected: PASS (17 tests). If TS rejects `applicationServerKey: Uint8Array` against `BufferSource`, pass `urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer` instead and adjust the test to read `new Uint8Array(arg.applicationServerKey)`.

- [ ] **Step 6: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/lib/api.ts pwa/src/lib/push.ts pwa/test/push.test.ts
git commit -m "push-notification-dispatch-1(pwa): push client — config fetch, subscribe/re-sync, deep-link helpers"
```

---

### Task 8: PWA — `usePushOptIn` hook + `PushOptIn` banner

**Files:**
- Create: `pwa/src/hooks/usePushOptIn.ts`
- Create: `pwa/src/components/PushOptIn.tsx`
- Test: `pwa/test/push-opt-in.test.tsx`

**Interfaces:**
- Consumes: `ensurePushSubscription`, `isPushSupported` (Task 7), `Api` (Task 7).
- Produces: `usePushOptIn(api: Api | null, deps?: PushOptInDeps): { offer: boolean; busy: boolean; enable(): Promise<void>; dismiss(): void }`, `interface PushOptInDeps { ensure: typeof ensurePushSubscription; supported: () => boolean; permission: () => NotificationPermission; storage: Pick<Storage, 'getItem' | 'setItem'> | null }`, `PUSH_OPTIN_DISMISSED_KEY = 'microviber.pushOptInDismissed'`; `PushOptIn({ busy, onEnable, onDismiss })` component. Task 9 wires both into `App.tsx`.

- [ ] **Step 1: Read the reference before styling** — open `pwa/src/components/states.tsx` and copy `Banner`'s chrome verbatim: `border-b px-3.5 py-2 text-[13px] leading-snug`. The opt-in banner uses that exact spacing/type with a neutral tone (`bg-zinc-900 border-zinc-800 text-zinc-300`), an emerald primary button, and a plain "Not now" text button. Do not invent new sizes.

- [ ] **Step 2: Write the failing tests** — create `pwa/test/push-opt-in.test.tsx`:

```tsx
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
    const { result } = renderHook(() => usePushOptIn(api(false), deps()));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
  });

  it('unsupported browser: no offer, no config fetch', async () => {
    const a = api();
    const { result } = renderHook(() => usePushOptIn(a, deps({ supported: () => false })));
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
    const d = deps({ permission: () => 'denied' });
    const { result } = renderHook(() => usePushOptIn(api(), d));
    await act(async () => {});
    expect(result.current.offer).toBe(false);
    expect(d.ensure).not.toHaveBeenCalled();
  });

  it('previously dismissed ("Not now"): no offer on later loads', async () => {
    localStorage.setItem(PUSH_OPTIN_DISMISSED_KEY, '1');
    const { result } = renderHook(() => usePushOptIn(api(), deps()));
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
    const d = deps({ ensure: vi.fn(async () => 'denied' as const) });
    const { result } = renderHook(() => usePushOptIn(api(), d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    await act(async () => { await result.current.enable(); });
    expect(result.current.offer).toBe(false);
  });

  it('enable() when the prompt is just closed ("not-granted"): offer stays so they can try again', async () => {
    const d = deps({ ensure: vi.fn(async () => 'not-granted' as const) });
    const { result } = renderHook(() => usePushOptIn(api(), d));
    await waitFor(() => expect(result.current.offer).toBe(true));
    await act(async () => { await result.current.enable(); });
    expect(result.current.offer).toBe(true);
  });

  it('dismiss(): hides the offer and remembers it', async () => {
    const { result } = renderHook(() => usePushOptIn(api(), deps()));
    await waitFor(() => expect(result.current.offer).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.offer).toBe(false);
    expect(localStorage.getItem(PUSH_OPTIN_DISMISSED_KEY)).toBe('1');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd pwa && npx vitest run test/push-opt-in.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the hook** — create `pwa/src/hooks/usePushOptIn.ts`:

```ts
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
```

If ESLint does not know `react-hooks/exhaustive-deps` (the repo's flat config has no react-hooks plugin), delete that `eslint-disable` comment line rather than adding a plugin.

- [ ] **Step 5: Implement the banner** — create `pwa/src/components/PushOptIn.tsx`:

```tsx
import type { ReactElement } from 'react';

/** Push opt-in offer (AC6). Same chrome as states.tsx's Banner (border-b px-3.5 py-2 text-[13px] leading-snug), neutral tone. */
export function PushOptIn({ busy, onEnable, onDismiss }: { busy: boolean; onEnable: () => void; onDismiss: () => void }): ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3.5 py-2 text-[13px] leading-snug text-zinc-300">
      <span className="flex-1">Get a push when a session needs you.</span>
      <button onClick={onEnable} disabled={busy}
        className="rounded-md bg-emerald-500 px-3 py-1.5 font-semibold text-emerald-950 disabled:opacity-60">
        {busy ? 'Enabling…' : 'Enable'}
      </button>
      <button onClick={onDismiss} className="px-1 text-zinc-500">Not now</button>
    </div>
  );
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd pwa && npx tsc --noEmit && npx vitest run test/push-opt-in.test.tsx`
Expected: PASS (13 tests).

- [ ] **Step 7: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/hooks/usePushOptIn.ts pwa/src/components/PushOptIn.tsx pwa/test/push-opt-in.test.tsx
git commit -m "push-notification-dispatch-1(pwa): push opt-in hook + banner (offer after pairing, silent re-sync when granted)"
```

---

### Task 9: PWA — wire `App.tsx` (banner, deep link, SW open-session, clear-on-open)

**Files:**
- Modify: `pwa/src/App.tsx`
- Test: `pwa/test/app-push.test.tsx`

**Interfaces:**
- Consumes: `usePushOptIn`, `PushOptIn` (Task 8); `sessionFromUrl`, `onOpenSessionMessage`, `dismissSessionNotification` (Task 7).
- Produces: behavior only. `sw.js` is unchanged — its contract (`/?session=<id>` on cold start, `{type:'open-session', sessionId}` to an open window, `{type:'dismiss', tag}` accepted from a client) is now honored end to end.

- [ ] **Step 1: Write the failing tests** — create `pwa/test/app-push.test.tsx` (follows `app-header.test.tsx`'s fetch-mock pattern):

```tsx
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/app-push.test.tsx`
Expected: FAIL — deep link ignored ("Session Alpha" shown instead of Beta), no banner, no dismiss message.

- [ ] **Step 3: Implement in `pwa/src/App.tsx`**

Imports (add):
```ts
import { PushOptIn } from './components/PushOptIn.js';
import { usePushOptIn } from './hooks/usePushOptIn.js';
import { sessionFromUrl, onOpenSessionMessage, dismissSessionNotification } from './lib/push.js';
```

Replace `const [selected, setSelected] = useState<string | null>(null);` with:
```ts
  // A notification tap on a cold-started PWA lands at /?session=<id> (sw.js
  // notificationclick → clients.openWindow). Honor it, then scrub the query
  // so a reload doesn't re-pin the session.
  const [selected, setSelected] = useState<string | null>(() => sessionFromUrl(location));
  useEffect(() => { if (sessionFromUrl(location)) history.replaceState(null, '', location.pathname); }, []);
```

Add, after the `api` `useMemo`:
```ts
  const push = usePushOptIn(api);

  // Single place that switches the visible session — used by the picker, the
  // service worker's open-session message (notification tap on an already-open
  // PWA), and nothing else. Resets per-session UI state exactly as onPick did.
  const pickSession = useCallback((id: string) => {
    setSelected(id); setEvents([]); setStatus(null); setPendingPrompt(null); setStatusKind(null); setLoadingTranscript(true); setPickerOpen(false);
  }, []);
  useEffect(() => onOpenSessionMessage((id) => pickSession(id)), [pickSession]);

  // Clear-on-open (functional spec §4): the moment a session is on screen, its
  // notification is stale — close it locally. Belt-and-braces with the
  // daemon's dismiss push, which may lag or be dropped on some platforms.
  useEffect(() => { if (selected) dismissSessionNotification(selected); }, [selected]);
```

Replace the `SessionPicker`'s `onPick` prop with:
```tsx
              onPick={pickSession}
```

Render the banner right after the disconnected `Banner` line (inside `<Shell>`, before the writable warning):
```tsx
      {push.offer && <PushOptIn busy={push.busy} onEnable={() => void push.enable()} onDismiss={push.dismiss} />}
```

The `if (!token) return <Shell><PairingScreen /></Shell>;` early return stays where it is, **but** hooks must run before it — `usePushOptIn(api)` and the three `useEffect`s above are placed with the other hooks, above that return (React requires unconditional hook order). With `api === null` the hook offers nothing, so the pairing screen shows no banner.

- [ ] **Step 4: Run to verify pass, then the whole PWA suite (the existing App tests must not regress — their fetch mocks throw on unknown URLs, and bare jsdom has no PushManager so no config fetch happens)**

Run: `cd pwa && npx tsc --noEmit && npx vitest run`
Expected: PASS — 139 existing + Task 7 (17) + Task 8 (13) + this task (6).

- [ ] **Step 5: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add pwa/src/App.tsx pwa/test/app-push.test.tsx
git commit -m "push-notification-dispatch-1(pwa): App wiring — opt-in banner, /?session deep link, SW open-session, clear-on-open"
```

---

### Task 10: Docs — architecture spec (F19, T18, §3/§4/§6), INSTALL.md, story decisions

**Files:**
- Modify: `docs/architecture-spec.md`
- Modify: `INSTALL.md`
- Modify: `docs/features/push-notification-dispatch/stories/story-1.md` (append a Decisions section under Technical Notes)

- [ ] **Step 1: Architecture spec §2 — add row F19** at the end of the §2 table (after F18):

```markdown
| F19 | **Web Push from this daemon works laptop-side; real-device delivery pending manual test** (story push-notification-dispatch-1 spike, 2026-09-06) | Transport: `tailscale serve` fronts the daemon at `https://<name>.ts.net` with a real Let's Encrypt cert (`tailscale cert`, INSTALL.md Stage 2) — not self-signed, so service-worker registration and `PushManager.subscribe` are available to the installed PWA. Outbound: from the laptop, `POST` probes to the three browser push services all answered (FCM 401, Apple `web.push.apple.com` 403, Mozilla 404 — reachable; 4xx is the expected answer to an unauthenticated probe). `web-push` 3.6.7 offline: `generateRequestDetails` produced `Content-Encoding: aes128gcm`, `Authorization: vapid t=…, k=…`, `TTL`/`Urgency`/`Topic` headers, and a 194-byte ciphertext with no plaintext in it. Online: `sendNotification` to a synthetic FCM subscription left the machine and came back `WebPushError 410 "push subscription has unsubscribed or expired"` — so the sender treats 404/410 as "gone → prune". Consequence recorded as **T18**: this is the daemon's first and only outbound network call, opt-in via `MV_VAPID_*`. **Real device receiving a push: PENDING** — to be confirmed in this story's manual test and this row updated with the phone/browser it was verified on. |
```

- [ ] **Step 2: Architecture spec §3 — daemon tree table**: change the `services/` row's description to `Cross-cutting service wiring (audit log, push notify loop), composed for `api/`. `notify-dispatch.ts` — the 5s daemon-side poll that feeds `listSessions()` into `NotifyPolicy.reconcile()` and fans intents out to every stored push subscription; primes on its first cycle so a restart never re-notifies already-idle sessions (push-notification-dispatch-1).` and add a row after `lib/webpane/`:

```markdown
| `lib/push-sender.ts`, `lib/push-subscription-store.ts` | Web Push (push-notification-dispatch-1). `push-sender.ts` wraps `web-push`: VAPID-signed, aes128gcm-encrypted `sendNotify`/`sendDismiss` with an RFC 8030 `Topic` per session tag (a dismiss replaces an undelivered notify at the push service), TTL 1h, outcomes `ok | gone | failed` (404/410 ⇒ gone). `push-subscription-store.ts` persists browser subscriptions to `~/.microviber/push-subscriptions.json` (0600, atomic write, zod-validated, fail-closed like `devports.json`, max 5, keyed by endpoint). Adjacent to the adapter layer but NOT inside `lib/claude-adapter/` — it knows nothing about Claude Code. |
```

Also update the `domain/` row's `notify-policy.ts` bullet to end with: `Wired into a real sender by services/notify-dispatch.ts (push-notification-dispatch-1); the policy itself is unchanged.`

- [ ] **Step 3: Architecture spec §4 — API table**: add two rows after `/api/webpane/localfile`:

```markdown
| `/api/push/config` | GET | bearer | `{ enabled, publicKey }` — whether push is configured (`MV_VAPID_*` set) and the VAPID public key the PWA passes to `pushManager.subscribe`. Fetched at runtime, not baked into the PWA build (keys are per-install). (push-notification-dispatch-1) |
| `/api/push/subscribe` | POST | bearer | Body is exactly `PushSubscription.toJSON()` (`{ endpoint, expirationTime?, keys: { p256dh, auth } }`, strict). `endpoint` must be a public `https:` hostname — loopback, IP literals, `localhost`, `*.ts.net`, `*.local`, `*.internal`, single-label names are rejected 400 `INVALID_INPUT` (T18). Upserts by endpoint into the on-disk store; 400 `INVALID_INPUT` "push notifications are not configured" when `MV_VAPID_*` are unset. Returns `{ ok: true }`. (push-notification-dispatch-1) |
```

- [ ] **Step 4: Architecture spec §5 — add row T18** after T17:

```markdown
| **T18** | **The daemon's first outbound network call.** Web Push requires the daemon to `POST` to a third-party push service chosen by the phone's browser (Google FCM, Apple, Mozilla, Microsoft) — outside the tailnet, on the public internet. Two exposures: (a) what leaves the tailnet, and (b) a bearer holder pointing that outbound call at an internal target by registering a crafted `endpoint` (SSRF into loopback/tailnet/LAN — e.g. `https://127.0.0.1:8730/…` or a `.ts.net` peer). | (a) **Payload is end-to-end encrypted** (RFC 8291 `aes128gcm`, keys held by the phone's browser) — the push service sees ciphertext, the endpoint, timing, and size, never the session title or status line; the VAPID private key never leaves the laptop. **Opt-in**: nothing is sent, and no sender is even constructed, unless `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` are set (`index.ts`); without them the daemon's network posture is exactly what it was before this story. The subscription file (`~/.microviber/push-subscriptions.json`) is 0600 next to the bearer token — with the VAPID private key it is enough to push to that phone. (b) `isSafePushEndpoint` (`schemas/api.ts`) is enforced at the API boundary AND re-validated when the store file is loaded: `https:` only, no credentials in the URL, hostname must not be `localhost`/`*.localhost`, an IPv4/IPv6 literal, `*.local`, `*.ts.net`, `*.internal`, `*.home.arpa`, or a single-label name. Residual, accepted: a bearer holder can still make the daemon POST small encrypted blobs to an arbitrary *public* https host (the daemon is a push client, so this is inherent); the same bearer already drives Claude sessions, so this grants no new capability against the laptop or tailnet. **Known platform gap (AC4):** dismissals go out as silent pushes (`{type:'dismiss'}`, which `sw.js` turns into `Notification.close()`); iOS Safari may throttle or revoke a subscription that receives pushes showing no notification. Mitigations already in place: the per-session `Topic` makes a dismiss *replace* an undelivered notify at the push service (most dismisses never reach the phone), every notify has a 1h TTL, and the PWA clears a session's notification the moment it is opened. Verified on the user's real phone in this story's manual test — record the platform outcome here. (push-notification-dispatch-1, 2026-09-06) |
```

Also update T4's "Auth is an `Authorization` header … " row? No — unchanged. Update the §5 heading `## 5. Transport & security (threat model T1–T17)` → `T1–T18`, and the CLAUDE.md line `threat model T1–T17` → `T1–T18`.

- [ ] **Step 5: Architecture spec §6 — add a standard** after "Isolate proxied third-party content by ORIGIN…":

```markdown
- **Outbound calls are opt-in, enumerated, and encrypted end to end.** The daemon makes no
  network request of its own initiative except the Web Push sender (T18), and that only
  when `MV_VAPID_*` are configured. Any future outbound call gets its own threat-model row,
  its own opt-in configuration, an endpoint allow/deny check at the API boundary if the
  target is influenced by a client, and payload encryption the intermediary cannot undo.
  (push-notification-dispatch-1, 2026-09-06)
```

- [ ] **Step 6: INSTALL.md** — in Step 3.2 replace the command block's explanatory line so it reads: after the code block add `(`web-push` is a daemon dependency, so `npx` resolves the local copy — no download.)`. Then add a new step after Step 4.4 (pairing/installing the PWA — find the step that installs the PWA on the phone) :

```markdown
### Step 4.5 — Enable push notifications on the phone

With `MV_VAPID_*` set (Step 3.2/3.3) the paired PWA shows a one-line offer
under the title bar: **"Get a push when a session needs you." → Enable**.
Tap Enable, accept the browser's permission prompt. On iPhone this only works
in the PWA installed to the Home Screen (Step 4.4), not in a Safari tab.

**Verify:** the offer disappears, and on the laptop
`ls -l ~/.microviber/push-subscriptions.json` shows a `-rw-------` file. The
daemon log prints `Push notifications: enabled — 1 subscription(s) …` on its
next restart. Background the app; the next time a session goes idle or asks a
question you get a notification, and tapping it opens that session.

If the daemon prints `Push notifications: disabled`, the two `MV_VAPID_*`
lines are missing from `.env` — add them and restart.
```

- [ ] **Step 7: Story file — append to `## Technical Notes` in `docs/features/push-notification-dispatch/stories/story-1.md`:**

```markdown
**Decisions (2026-09-06, implementation):**
- **AC1 spike:** laptop-side PASS (real TLS via tailscale, outbound reachability to FCM/Apple/Mozilla, VAPID+aes128gcm signing verified offline, a signed request left the machine and got a 410 back). Recorded as F19; real-device delivery is the manual test. The "self-signed HTTPS" premise in the story was wrong — `tailscale cert` issues a real cert.
- **AC3 persistence: on disk** (`~/.microviber/push-subscriptions.json`, 0600, atomic, zod, fail-closed, max 5 by endpoint). In-memory would mean a launchd KeepAlive restart silently un-subscribes the phone. The PWA also re-POSTs on every load once permission is granted.
- **AC4 loop:** the daemon had no session-list refresh loop (lists are computed per PWA poll); `services/notify-dispatch.ts` adds a 5s one that PRIMES on its first cycle so a restart never re-notifies already-idle sessions. Dismiss maps to the real API as a dismiss push (`sw.js` already implemented that) plus an RFC 8030 `Topic` per session so a dismiss replaces an undelivered notify at the push service. Gap documented in T18: iOS may throttle silent pushes.
- **AC5:** `sw.js` handlers pre-existed; App.tsx now honors `/?session=<id>` and the SW's `open-session` message, and clears a session's notification on open.
- **AC6 key delivery:** runtime `GET /api/push/config`; opt-in banner after pairing (never a prompt on cold load); granted ⇒ silent re-sync.
- **AC7 reconciled with AC4:** sender has `sendNotify`/`sendDismiss`; a dismiss intent never calls `sendNotify` (tested) and does call `sendDismiss` (tested).
- **T18** added: first outbound call, opt-in, E2E-encrypted, endpoint SSRF guard.
```

- [ ] **Step 8: Verify the docs edits are consistent** — `grep -n "T1–T1[78]" docs/architecture-spec.md CLAUDE.md` shows only `T1–T18`; `grep -c "push-notification-dispatch-1" docs/architecture-spec.md` ≥ 5.

- [ ] **Step 9: Gate + commit**

```bash
npm run typecheck && npm run lint && npm test
git add docs/architecture-spec.md INSTALL.md CLAUDE.md docs/features/push-notification-dispatch/stories/story-1.md
git commit -m "push-notification-dispatch-1(docs): F19 spike outcome, T18 outbound push threat row, API/tree entries, INSTALL step 4.5, story decisions"
```

---

## Self-review

- **AC1** → spike section + Task 10 F19. **AC2** → `web-push` dep (already in `daemon/package.json`, committed with Task 1's first commit — `git add daemon/package.json package-lock.json` in Task 1 Step 5 as well) + Task 3. **AC3** → Task 2 + Task 6 + decision recorded Task 10. **AC4** → Task 4 (+ Task 6 starts it). **AC5** → Task 7 helpers + Task 9 wiring (sw.js unchanged, pre-existing). **AC6** → Tasks 7–9. **AC7** → Task 4 Step 1 (in `notify-policy.test.ts`). **AC8** → Task 10 T18 + API rows.
- Types: `PushSubscriptionBody` (T1) ⇄ `StoredSubscription` (T2) ⇄ `PushSubscription` from web-push (T3): all `{ endpoint, keys: { p256dh, auth }, expirationTime? }` — structurally compatible; `dispatchIntents` passes `StoredSubscription` to `PushSender` (web-push's `PushSubscription.expirationTime?: number | null` accepts `number | null`). `SendOutcome` names match across T3/T4. `getPushConfig`/`subscribePush` names match across T5/T7. `PushSetupResult` values match across T7/T8. `pickSession` is defined in T9 before use.
- Placeholders: none; every code step has its code.
