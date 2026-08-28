# microviber-track-b-2 — Web Pane Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new daemon routes (`POST /api/webpane-token`, `/api/webpane/devserver/:port/*`, `GET /api/webpane/localfile`) plus a narrow bearer-auth-hook cookie carve-out, so a later PWA story can embed either a proxied dev server or an arbitrary local file inside a sandboxed iframe without ever exposing the daemon's main bearer token to framed content.

**Architecture:** New logic lives in a fresh `daemon/src/lib/webpane/` module (mirroring the existing `lib/claude-adapter/` isolation pattern): `webpane-auth.ts` (resource-scoped token store), `proxy.ts` (pure loopback reverse-proxy), `local-file.ts` (content-type-guessing file reader). `api/app.ts` gains three routes and one auth-hook exception; `services/services.ts` wires the new functions into `AppDeps`, matching the wiring style already used for every existing route. Tasks 1–3 of the feature plan (devports config, port resolver, `SessionSummary.devServerPort`) are already merged (story-1, PR #18) — this story is backend-only, no PWA code changes.

**Tech Stack:** Node 22 + TypeScript + Fastify 5 + Zod 3, Vitest 4. No PWA/UI changes in this story.

## Global Constraints

- Test gate: `npm run typecheck && npm run lint && npm test` (run from `microviber/` root) must pass before every commit.
- TS strictness per `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. `@typescript-eslint/no-explicit-any` is an eslint error — any `any` needs a `// reason:` comment.
- Adapter quarantine: nothing outside `daemon/src/lib/claude-adapter/` may read `~/.claude/*` paths or touch the messaging socket. New webpane code lives in `daemon/src/lib/webpane/` and has no reason to reference `~/.claude` at all.
- Layering fence: `schemas/ → domain/ → services/ → api/`, no upward imports.
- Fail closed: an invalid/missing required config crashes at startup with a clear error, never a silent fallback (already satisfied for `devports.json` by story-1; nothing new to add here).
- Relative imports use explicit `.js` extensions throughout the daemon (ESM convention).
- Every `git commit` in this plan's steps is a real commit — run it, don't skip it.
- **Threat-label caveat:** the feature spec (`docs/features/microviber-track-b/spec.md` §7) calls the proxy-steering threat "T13" and the cookie/CSRF threat "T14", but the GLOBAL threat table in `docs/architecture-spec.md` already has a *different* T13 (added during story-1's review, about hostile config files) and no T14+ yet. Code comments in this plan cite the feature-spec locally (e.g. "spec §7 (cookie CSRF)") rather than bare "T13"/"T14" — the global architecture-spec will get new row numbers assigned at code-review time, not these literal labels.
- **Deferred, not in scope:** `resolveDevServerPortForSession` re-runs `discoverSessions()` (filesystem scan, several sync ops per session folder) on every `listSessions()` call. Task 3 below makes `listResolvedDevServerPorts()` call `listSessions()` too, so a proxied dev-server page's asset burst (html, css, js, images — potentially dozens of requests in a couple seconds) now re-triggers that scan once per request instead of once per poll cycle. This plan deliberately does **not** add caching/memoization for it: none of the story's ACs require it, a TTL cache would need its own invalidation-correctness tests (new session appearing, folder's resolved port changing) that aren't otherwise in scope, and this is a personal single-user tool where the existing poll-driven `listSessions()` cost is already accepted. **Explicitly flag this as a fast-follow candidate at code-review time** rather than silently dropping it — do not let it get lost.

---

## File Structure

**New:**
- `daemon/src/lib/webpane/webpane-auth.ts` — `WebpaneTokenStore` (mint/check), `parseCookieHeader`, `resourceKey`, `WebpaneResource` type.
- `daemon/src/lib/webpane/proxy.ts` — `proxyToLoopback` (pure loopback fetch wrapper).
- `daemon/src/lib/webpane/local-file.ts` — `readLocalFile` + content-type table.
- `daemon/test/webpane/webpane-auth.test.ts`, `daemon/test/webpane/proxy.test.ts`, `daemon/test/webpane/local-file.test.ts`.

**Modified:**
- `daemon/src/schemas/api.ts` — adds `WebpaneTokenBody`.
- `daemon/src/api/app.ts` — extends `AppDeps` (`mintWebpaneToken`, `checkWebpaneCookie`, `listResolvedDevServerPorts`, `proxyDevServer`, `readLocalFile`), registers 3 routes, extends the bearer-auth hook with the cookie carve-out, adds a catch-all raw-body content-type parser (needed so non-JSON bodies can be forwarded by the proxy route).
- `daemon/src/services/services.ts` — wires real implementations of the 5 new `AppDeps` methods.
- `daemon/test/app.test.ts` — extends the `deps()` fixture with the 5 new methods; adds route + auth-carve-out tests.

---

## Task 1: Web pane shared auth — token mint + cookie validation

**Files:**
- Create: `daemon/src/lib/webpane/webpane-auth.ts`
- Test: `daemon/test/webpane/webpane-auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WebpaneResource = { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string };
  export class WebpaneTokenStore {
    mint(resource: WebpaneResource, nowMs: number): string;
    check(cookieValue: string | undefined, resource: WebpaneResource, nowMs: number): boolean;
  }
  export function parseCookieHeader(header: string | undefined, name: string): string | undefined;
  export function resourceKey(r: WebpaneResource): string;
  ```
- Consumed by: Task 2 (route + auth hook), Task 3 (allowlist), Task 4 (readLocalFile route).

- [ ] **Step 1: Write the failing tests**

```ts
// daemon/test/webpane/webpane-auth.test.ts
import { describe, it, expect } from 'vitest';
import { WebpaneTokenStore, parseCookieHeader, resourceKey } from '../../src/lib/webpane/webpane-auth.js';

describe('parseCookieHeader', () => {
  it('extracts a named cookie from a Cookie header', () => {
    expect(parseCookieHeader('a=1; mv_webpane=abc123; b=2', 'mv_webpane')).toBe('abc123');
  });
  it('returns undefined when absent or header missing', () => {
    expect(parseCookieHeader('a=1', 'mv_webpane')).toBeUndefined();
    expect(parseCookieHeader(undefined, 'mv_webpane')).toBeUndefined();
  });
});

describe('resourceKey', () => {
  it('distinguishes devserver and localfile resources, and different values within each kind', () => {
    expect(resourceKey({ kind: 'devserver', port: 9005 })).not.toBe(resourceKey({ kind: 'devserver', port: 9008 }));
    expect(resourceKey({ kind: 'localfile', path: '/a' })).not.toBe(resourceKey({ kind: 'localfile', path: '/b' }));
    expect(resourceKey({ kind: 'devserver', port: 9005 })).not.toBe(resourceKey({ kind: 'localfile', path: '/9005' }));
  });
});

describe('WebpaneTokenStore (spec §7 "Iframe auth")', () => {
  it('a minted token validates only against the exact resource it was minted for', () => {
    const store = new WebpaneTokenStore();
    const token = store.mint({ kind: 'devserver', port: 9005 }, 0);
    expect(store.check(token, { kind: 'devserver', port: 9005 }, 1000)).toBe(true);
    expect(store.check(token, { kind: 'devserver', port: 9008 }, 1000)).toBe(false);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 1000)).toBe(false);
  });

  it('expires after 5 minutes (Max-Age=300 in the spec)', () => {
    const store = new WebpaneTokenStore();
    const token = store.mint({ kind: 'localfile', path: '/x' }, 0);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 299_000)).toBe(true);
    expect(store.check(token, { kind: 'localfile', path: '/x' }, 300_001)).toBe(false);
  });

  it('rejects an unknown/undefined token', () => {
    const store = new WebpaneTokenStore();
    expect(store.check(undefined, { kind: 'devserver', port: 9005 }, 0)).toBe(false);
    expect(store.check('not-a-real-token', { kind: 'devserver', port: 9005 }, 0)).toBe(false);
  });

  it('re-minting for a new resource does not invalidate a still-live token for a different resource', () => {
    const store = new WebpaneTokenStore();
    const t1 = store.mint({ kind: 'devserver', port: 9005 }, 0);
    store.mint({ kind: 'devserver', port: 9008 }, 0);
    expect(store.check(t1, { kind: 'devserver', port: 9005 }, 100)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/webpane-auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/webpane/webpane-auth.js'`

- [ ] **Step 3: Implement**

```ts
// daemon/src/lib/webpane/webpane-auth.ts
import { randomBytes } from 'node:crypto';

export type WebpaneResource = { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string };

const TOKEN_TTL_MS = 5 * 60_000; // 5 minutes — spec §7 "Iframe auth" Max-Age=300

export function resourceKey(r: WebpaneResource): string {
  return r.kind === 'devserver' ? `devserver:${r.port}` : `localfile:${r.path}`;
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * In-memory only (daemon restart clears it, same pattern as OwnershipRegistry).
 * Each token is bound to exactly one resource (a port, or a path) at mint
 * time; `check` validates both identity and TTL. This is the mechanism
 * behind the mv_webpane cookie's narrow scope (spec §7, cookie CSRF row).
 */
export class WebpaneTokenStore {
  private entries = new Map<string, { key: string; expiresAtMs: number }>();

  mint(resource: WebpaneResource, nowMs: number): string {
    const token = randomBytes(24).toString('base64url');
    this.entries.set(token, { key: resourceKey(resource), expiresAtMs: nowMs + TOKEN_TTL_MS });
    return token;
  }

  check(cookieValue: string | undefined, resource: WebpaneResource, nowMs: number): boolean {
    if (!cookieValue) return false;
    const entry = this.entries.get(cookieValue);
    if (!entry) return false;
    if (nowMs > entry.expiresAtMs) return false;
    return entry.key === resourceKey(resource);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/webpane-auth.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/lib/webpane/webpane-auth.ts daemon/test/webpane/webpane-auth.test.ts
git commit -m "feat(webpane): add shared token-mint/cookie-check store (spec §7)"
```

---

## Task 2: `POST /api/webpane-token` + the auth-hook cookie carve-out

**Files:**
- Modify: `daemon/src/schemas/api.ts`, `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: modify `daemon/test/app.test.ts`

**Interfaces:**
- Consumes: `WebpaneTokenStore`, `WebpaneResource`, `parseCookieHeader` (Task 1).
- Produces: `AppDeps` gains
  ```ts
  mintWebpaneToken(resource: WebpaneResource): { cookieValue: string; maxAgeSeconds: number };
  checkWebpaneCookie(cookieValue: string | undefined, resource: WebpaneResource): boolean;
  ```
  Tasks 3 and 4 consume these two methods by these exact names — do not rename them. Also produces `resourceFromUrl(url: string): WebpaneResource | null` (module-private in `app.ts`) which Tasks 3/4's routes rely on being correct for their own URL shapes — this task implements it fully for both shapes now (there is nothing left for Tasks 3/4 to add to it).

**Important correction vs. the feature plan's draft (`docs/features/microviber-track-b/plan.md` Task 5):** that draft computes `resourceFromUrl` from a query-string-stripped `url` variable, which would make `new URL(url, ...).searchParams.get('path')` always return `null` for the local-file resource — breaking the cookie carve-out for `/api/webpane/localfile?path=...` entirely. This task passes the **raw** `req.url` (with query string) into `resourceFromUrl`, and uses a separately-computed path-only string only for the route-prefix checks that don't need the query.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/app.test.ts`. First extend the `deps()` factory (find the existing `function deps(over: Partial<AppDeps> = {}): AppDeps { return { ... ...over }; }` and add two entries before `...over`):

```ts
    mintWebpaneToken: () => ({ cookieValue: 'tok123', maxAgeSeconds: 300 }),
    checkWebpaneCookie: () => false,
```

Then add these new `describe` blocks:

```ts
describe('POST /api/webpane-token', () => {
  it('requires bearer auth like every other route', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: { host: 'laptop.ts.net' }, payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });

  it('mints a resource-scoped cookie on success', async () => {
    const app = buildApp(deps());
    const res = await app.inject({
      method: 'POST', url: '/api/webpane-token', headers: auth,
      payload: { kind: 'devserver', port: 9005 },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/mv_webpane=tok123/);
    expect(setCookie).toMatch(/Path=\/api\/webpane\//);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Max-Age=300/);
  });

  it('rejects an invalid body', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: auth, payload: { kind: 'nonsense' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });
});

describe('bearer-auth hook cookie carve-out for /api/webpane/*', () => {
  it('the mint endpoint itself never accepts the cookie as a header substitute', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' }, payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });

  it('does NOT accept the webpane cookie on any other /api/* route', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(401);
  });
});
```

(Tests exercising the cookie carve-out actually *succeeding* on `/api/webpane/devserver/*` and `/api/webpane/localfile` are added in Tasks 3 and 4, once those routes exist — this task's `resourceFromUrl` supports both shapes already, but there's no live route to hit yet.)

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: FAIL — `/api/webpane-token` 404s instead of the expected statuses.

- [ ] **Step 3: Implement**

Add to `daemon/src/schemas/api.ts`:

```ts
export const WebpaneTokenBody = z.union([
  z.object({ kind: z.literal('devserver'), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal('localfile'), path: z.string().min(1) }),
]);
```

In `daemon/src/api/app.ts`, add the import and extend `AppDeps`:

```ts
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';
import { parseCookieHeader } from '../lib/webpane/webpane-auth.js';
import { WebpaneTokenBody, SendPromptBody, errorEnvelope, HTTP_STATUS } from '../schemas/api.js';

export interface AppDeps {
  // ...existing fields...
  mintWebpaneToken(resource: WebpaneResource): { cookieValue: string; maxAgeSeconds: number };
  checkWebpaneCookie(cookieValue: string | undefined, resource: WebpaneResource): boolean;
}
```

Add `resourceFromUrl` near the top of `buildApp` (module-level function, defined once, used by the hook below and by Tasks 3/4's routes if they need it — they don't, the hook is the only caller):

```ts
/** Parses a WebpaneResource out of either content route's URL shape. Takes the RAW url (with query string) — the localfile shape needs its ?path= param. */
function resourceFromUrl(url: string): WebpaneResource | null {
  const devMatch = /^\/api\/webpane\/devserver\/(\d+)/.exec(url);
  if (devMatch?.[1]) return { kind: 'devserver', port: Number(devMatch[1]) };
  if (url.startsWith('/api/webpane/localfile')) {
    const path = new URL(url, 'http://x').searchParams.get('path');
    if (path) return { kind: 'localfile', path };
  }
  return null;
}
```

Replace the existing bearer-auth hook body in `buildApp`:

```ts
  // Bearer auth protects DATA routes only (/api/* except health, and /ws).
  // The PWA shell (HTML/JS/CSS) is public — the phone loads it BEFORE it has a
  // token, then pairs. T8: token in the Authorization header only.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const isData = path.startsWith('/api/') || path.startsWith('/ws');
    if (!isData) return;                 // static shell: public
    if (path === '/api/health') return;  // liveness: public
    if (checkBearer(req.headers.authorization, config.bearerToken)) return;

    // Narrow carve-out (spec §7 "Iframe auth"): an <iframe src> can't attach
    // a header, so /api/webpane/devserver/* and /api/webpane/localfile ALSO
    // accept the scoped mv_webpane cookie — every other route, INCLUDING the
    // token-mint endpoint itself, still requires the real header, unchanged.
    const isWebpaneContent = path.startsWith('/api/webpane/devserver/') || path.startsWith('/api/webpane/localfile');
    if (isWebpaneContent) {
      const cookieValue = parseCookieHeader(req.headers.cookie, 'mv_webpane');
      const resource = resourceFromUrl(req.url); // raw url — localfile needs ?path=
      if (resource && deps.checkWebpaneCookie(cookieValue, resource)) return;
    }

    return reply.code(401).send(errorEnvelope('UNAUTHENTICATED', 'missing or invalid bearer token'));
  });
```

Register the mint route (add near the other `app.post(...)` calls):

```ts
  app.post('/api/webpane-token', async (req, reply) => {
    const parsed = WebpaneTokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'invalid body'));
    const resource = parsed.data as WebpaneResource;
    const { cookieValue, maxAgeSeconds } = deps.mintWebpaneToken(resource);
    reply.header('set-cookie', `mv_webpane=${cookieValue}; Path=/api/webpane/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
    return { success: true, data: { ok: true } };
  });
```

In `daemon/src/services/services.ts`, add the import and wire real implementations:

```ts
import { WebpaneTokenStore } from '../lib/webpane/webpane-auth.js';
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';

// Inside createServices(...), alongside `const registry = new OwnershipRegistry();`:
  const webpaneTokens = new WebpaneTokenStore();

// Add to the returned AppDeps object, alongside the other methods:
    mintWebpaneToken(resource: WebpaneResource) {
      return { cookieValue: webpaneTokens.mint(resource, Date.now()), maxAgeSeconds: 300 };
    },
    checkWebpaneCookie(cookieValue, resource) {
      return webpaneTokens.check(cookieValue, resource, Date.now());
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: PASS (all existing tests plus the 5 new ones)

- [ ] **Step 5: Full typecheck and commit**

```bash
cd microviber && npm run typecheck
git add daemon/src/schemas/api.ts daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add POST /api/webpane-token + cookie auth carve-out (spec §7)"
```

---

## Task 3: Dev-server reverse-proxy route (`/api/webpane/devserver/:port/*`)

**Files:**
- Create: `daemon/src/lib/webpane/proxy.ts`
- Modify: `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: `daemon/test/webpane/proxy.test.ts`, extend `daemon/test/app.test.ts`

**Interfaces:**
- Consumes: native `fetch` (Node 22).
- Produces:
  ```ts
  export async function proxyToLoopback(
    port: number, path: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  ```
  `AppDeps` gains `listResolvedDevServerPorts(): number[]` and `proxyDevServer` (same signature as `proxyToLoopback` — the route performs the port-allowlist check itself, `proxyDevServer`/`proxyToLoopback` trust their caller).

**Correction vs. the feature plan's draft (Task 6):** that draft's route only forwards `req.body`, which is `undefined` for any content type Fastify doesn't already have a parser for (Fastify 5 throws `FST_ERR_CTP_INVALID_MEDIA_TYPE` on an unrecognized content type by default) — a POST from a proxied dev-server page with e.g. `multipart/form-data` or no content-type would 415 before the handler even runs, failing AC3's "GET/POST/etc." requirement. This task adds a catch-all raw-body content type parser. It also strips `content-encoding`/`content-length`/`transfer-encoding`/`connection` from the forwarded *response* headers — `fetch()` already transparently decodes a gzipped upstream response, so replaying its original `content-encoding: gzip` header verbatim would make the browser try to gunzip already-decoded bytes and show a broken page; letting Fastify recompute `content-length`/framing for what it's actually sending avoids a body/header-length mismatch.

- [ ] **Step 1: Write the failing tests for `proxyToLoopback`**

```ts
// daemon/test/webpane/proxy.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { proxyToLoopback } from '../../src/lib/webpane/proxy.js';

describe('proxyToLoopback (target host hardcoded to loopback, only port varies)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('always targets 127.0.0.1, forwarding method/path/headers/body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await proxyToLoopback(9005, '/dashboard', { method: 'GET', headers: { accept: 'text/html' } });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9005/dashboard', expect.objectContaining({ method: 'GET' }));
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('hi');
  });

  it('forwards a request body for non-GET methods', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = new TextEncoder().encode('{"x":1}');
    await proxyToLoopback(9005, '/api/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(body);
  });

  it('surfaces a connection failure as a thrown error, not a silent empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(proxyToLoopback(9005, '/', { method: 'GET', headers: {} })).rejects.toThrow(/ECONNREFUSED/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/proxy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `proxyToLoopback`**

```ts
// daemon/src/lib/webpane/proxy.ts

/**
 * Reverse-proxies to a resolved local dev-server port. The target host is
 * hardcoded to loopback — only the port varies, never a non-loopback host
 * (spec §7, proxy-steering row). The port-allowlist check lives in the route
 * handler (app.ts), not here — this function trusts its caller.
 */
export async function proxyToLoopback(
  port: number,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  const body = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers, body };
}
```

- [ ] **Step 4: Run to verify `proxyToLoopback` tests pass**

Run: `cd daemon && npx vitest run test/webpane/proxy.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing route tests**

Add to `daemon/test/app.test.ts`. First extend `deps()` with:

```ts
    listResolvedDevServerPorts: () => [],
    proxyDevServer: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
```

Then add:

```ts
describe('GET /api/webpane/devserver/:port/*', () => {
  it('403s a port not in the resolved allowlist', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9999/', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('proxies an allowed port, preserving the sub-path', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<html></html>') }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/scenarios/42', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html></html>');
  });

  it('strips content-encoding/content-length/transfer-encoding/connection from the forwarded response (fetch already decoded the body)', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '999', 'transfer-encoding': 'chunked', connection: 'keep-alive' },
        body: new TextEncoder().encode('<html></html>'),
      }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: auth });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(res.headers.connection).toBeUndefined();
  });

  it('accepts the mv_webpane cookie in place of the bearer header for an allowed port', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005], checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).not.toBe(401);
  });

  it('proxies a POST with a non-JSON body without 415ing (catch-all body parser)', async () => {
    let received: Uint8Array | undefined;
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async (_port, _path, init) => { received = init.body; return { status: 200, headers: {}, body: new Uint8Array() }; },
    }));
    const res = await app.inject({
      method: 'POST', url: '/api/webpane/devserver/9005/upload', headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('raw-bytes'),
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(received!).toString()).toBe('raw-bytes');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: FAIL — route not found (404)

- [ ] **Step 7: Implement the route, catch-all body parser, and `AppDeps` extension**

In `daemon/src/api/app.ts`, add near the top of `buildApp` (once, before routes):

```ts
  // Needed so the dev-server proxy route (below) can forward a request body
  // of ANY content type — Fastify 5 otherwise 415s any content type without
  // a registered parser (multipart, octet-stream, missing content-type...).
  // Does not affect 'application/json', which keeps Fastify's own default
  // parser (a specific parser always wins over the '*' catch-all).
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));
```

Extend `AppDeps`:

```ts
export interface AppDeps {
  // ...existing...
  listResolvedDevServerPorts(): number[];
  proxyDevServer(port: number, path: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}
```

Register the route:

```ts
  const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

  app.all('/api/webpane/devserver/:port/*', async (req, reply) => {
    const { port: portParam } = req.params as { port: string };
    const port = Number(portParam);
    const allowed = deps.listResolvedDevServerPorts();
    if (!Number.isInteger(port) || !allowed.includes(port)) {
      return reply.code(403).send(errorEnvelope('FORBIDDEN', 'port is not currently resolved for any known folder'));
    }
    const forwardPath = req.url.replace(/^\/api\/webpane\/devserver\/\d+/, '') || '/';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !['host', 'authorization', 'cookie', 'content-length'].includes(k)) headers[k] = v;
    }
    try {
      const upstream = await deps.proxyDevServer(port, forwardPath, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? (req.body as Uint8Array | undefined) : undefined,
      });
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) reply.header(k, v);
      }
      return reply.code(upstream.status).send(Buffer.from(upstream.body));
    } catch (e) {
      return reply.code(502).send(errorEnvelope('EXTERNAL_SERVICE_ERROR', e instanceof Error ? e.message : String(e)));
    }
  });
```

In `daemon/src/services/services.ts`:

```ts
import { proxyToLoopback } from '../lib/webpane/proxy.js';

// Add to the returned AppDeps object:
    listResolvedDevServerPorts() {
      return listSessions()
        .map((s) => s.devServerPort)
        .filter((p): p is number => p !== null);
    },
    proxyDevServer: proxyToLoopback,
```

- [ ] **Step 8: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/proxy.test.ts test/app.test.ts`
Expected: PASS

- [ ] **Step 9: Full typecheck and commit**

```bash
cd microviber && npm run typecheck
git add daemon/src/lib/webpane/proxy.ts daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/webpane/proxy.test.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add dev-server reverse-proxy route with port allowlist (spec §7)"
```

---

## Task 4: Local file route (`GET /api/webpane/localfile`)

**Files:**
- Create: `daemon/src/lib/webpane/local-file.ts`
- Modify: `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: `daemon/test/webpane/local-file.test.ts`, extend `daemon/test/app.test.ts`

**Interfaces:**
- Produces: `export function readLocalFile(path: string, deps?: { readFileIfExists?: (p: string) => Buffer | null }): { bytes: Buffer; contentType: string } | null`. `AppDeps` gains `readLocalFile` (same signature, no `deps` param — the route calls it directly).

- [ ] **Step 1: Write the failing tests for `readLocalFile`**

```ts
// daemon/test/webpane/local-file.test.ts
import { describe, it, expect } from 'vitest';
import { readLocalFile } from '../../src/lib/webpane/local-file.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => (files[p] !== undefined ? Buffer.from(files[p]) : null) };
}

describe('readLocalFile (no folder restriction — explicit accepted risk, spec §9)', () => {
  it('guesses text/html for .html', () => {
    const r = readLocalFile('/x/mockup.html', fakeFs({ '/x/mockup.html': '<h1>hi</h1>' }));
    expect(r?.contentType).toBe('text/html');
  });
  it('guesses text/markdown for .md', () => {
    const r = readLocalFile('/x/spec.md', fakeFs({ '/x/spec.md': '# hi' }));
    expect(r?.contentType).toBe('text/markdown');
  });
  it('guesses image/png for .png', () => {
    const r = readLocalFile('/x/icon.png', fakeFs({ '/x/icon.png': 'binary' }));
    expect(r?.contentType).toBe('image/png');
  });
  it('guesses application/pdf for .pdf', () => {
    const r = readLocalFile('/x/doc.pdf', fakeFs({ '/x/doc.pdf': 'binary' }));
    expect(r?.contentType).toBe('application/pdf');
  });
  it('falls back to application/octet-stream for an unrecognized extension', () => {
    const r = readLocalFile('/x/data.bin', fakeFs({ '/x/data.bin': 'binary' }));
    expect(r?.contentType).toBe('application/octet-stream');
  });
  it('returns null when the file does not exist or is unreadable', () => {
    expect(readLocalFile('/anywhere/at/all.txt', fakeFs({}))).toBeNull();
  });
  it('does not restrict which absolute paths are attempted (explicit spec deviation)', () => {
    const r = readLocalFile('/etc/hosts', fakeFs({ '/etc/hosts': '127.0.0.1 localhost' }));
    expect(r?.bytes.toString()).toBe('127.0.0.1 localhost');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/local-file.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `readLocalFile`**

```ts
// daemon/src/lib/webpane/local-file.ts
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * No folder restriction — any path the daemon process can read is servable
 * (spec §3 "Local file viewing", explicit deviation recorded in spec §9,
 * bounded by iframe sandboxing on the PWA side, a later story). This
 * function only reads bytes; it never executes, interprets, or evaluates
 * file content.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function defaultReadFileIfExists(p: string): Buffer | null {
  return existsSync(p) ? readFileSync(p) : null;
}

export function readLocalFile(
  path: string,
  deps: { readFileIfExists?: (p: string) => Buffer | null } = {},
): { bytes: Buffer; contentType: string } | null {
  const readFileIfExists = deps.readFileIfExists ?? defaultReadFileIfExists;
  const bytes = readFileIfExists(path);
  if (bytes === null) return null;
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return { bytes, contentType };
}
```

- [ ] **Step 4: Run to verify `readLocalFile` tests pass**

Run: `cd daemon && npx vitest run test/webpane/local-file.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the failing route tests**

Add to `daemon/test/app.test.ts`. First extend `deps()` with:

```ts
    readLocalFile: () => null,
```

Then add:

```ts
describe('GET /api/webpane/localfile', () => {
  it('requires the path query param', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the file is missing/unreadable', async () => {
    const app = buildApp(deps({ readLocalFile: () => null }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('serves bytes with the guessed content-type', async () => {
    const app = buildApp(deps({ readLocalFile: () => ({ bytes: Buffer.from('<h1>hi</h1>'), contentType: 'text/html' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx%2Fmockup.html', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    expect(res.body).toBe('<h1>hi</h1>');
  });

  it('accepts the mv_webpane cookie in place of the bearer header, scoped to the exact path', async () => {
    const app = buildApp(deps({
      checkWebpaneCookie: () => true,
      readLocalFile: () => ({ bytes: Buffer.from('hi'), contentType: 'text/plain' }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx', headers: { host: 'laptop.ts.net', cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: FAIL — route not found (404 from the SPA fallback, not the expected statuses)

- [ ] **Step 7: Implement the route and `AppDeps` extension**

Extend `AppDeps` in `daemon/src/api/app.ts`:

```ts
export interface AppDeps {
  // ...existing...
  readLocalFile(path: string): { bytes: Buffer; contentType: string } | null;
}
```

Register the route:

```ts
  app.get('/api/webpane/localfile', async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'path query param required'));
    const file = deps.readLocalFile(path);
    if (!file) return reply.code(404).send(errorEnvelope('NOT_FOUND', 'file not found or unreadable'));
    reply.header('content-type', file.contentType);
    return reply.send(file.bytes);
  });
```

In `daemon/src/services/services.ts`:

```ts
import { readLocalFile } from '../lib/webpane/local-file.js';

// Add to the returned AppDeps object:
    readLocalFile,
```

- [ ] **Step 8: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/local-file.test.ts test/app.test.ts`
Expected: PASS

- [ ] **Step 9: Full quality gate and commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add daemon/src/lib/webpane/local-file.ts daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/webpane/local-file.test.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add local-file route, no folder restriction (spec §9 accepted risk)"
```

---

## Self-Review Notes

- **Spec coverage:** AC1 (mint route + Set-Cookie shape) → Task 2. AC2 (narrow auth-hook exception, mint route excluded) → Task 2. AC3 (proxy + hardcoded loopback + live allowlist + 403) → Task 3. AC4 (local-file route, content-type table, no folder restriction) → Task 4. AC5 (per-resource + 5-minute expiry) → Task 1 (`WebpaneTokenStore`), exercised end-to-end via Task 2/3/4's route tests.
- **Type consistency:** `WebpaneResource`, `resourceKey`, `mintWebpaneToken`, `checkWebpaneCookie`, `listResolvedDevServerPorts`, `proxyDevServer`, `readLocalFile` are used with identical names/signatures everywhere they're referenced across tasks.
- **Two corrections made vs. `docs/features/microviber-track-b/plan.md`'s own Tasks 5–6 drafts** (documented inline above, not silently applied): the query-string bug in `resourceFromUrl`'s caller, and the missing catch-all body parser + response-header stripping for the proxy route. Both are real functional gaps in the original draft that would have failed the story's own manual test checklist (`GET /api/webpane/localfile` cookie auth; proxying real dev-server content) had they shipped as originally sketched.
