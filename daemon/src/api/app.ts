import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { Config } from '../config.js';
import type { SessionSummary } from '../domain/registry.js';
import type { PromptRecord } from '../domain/prompt-lifecycle.js';
import { isHostAllowed } from './middleware/host-allowlist.js';
import { isOriginAllowed } from './middleware/cors.js';
import { checkBearer } from './middleware/auth.js';
import { resolveRequestId } from './middleware/request-id.js';
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';
import { parseCookieHeader } from '../lib/webpane/webpane-auth.js';
import { WebpaneTokenBody, SendPromptBody, errorEnvelope, HTTP_STATUS } from '../schemas/api.js';

export interface AppDeps {
  config: Config;
  listSessions(): SessionSummary[];
  getTranscript(id: string, cursor: string | undefined): { events: unknown[]; nextCursor: string | null } | null;
  sendPrompt(a: { sessionId: string; key: string; text: string; requestId: string; clientId: string }): Promise<PromptRecord>;
  /** Take over an existing idle, discovered session (spec §3.2 write path). */
  takeover(sessionId: string): Promise<{ id: string; mode: 'owned' }>;
  /** Deliberate hand-back: releases ownership and disposes the owned process. Idempotent — a no-op 200 on a session that was never taken over. */
  handback(sessionId: string): Promise<{ id: string; mode: 'readonly' }>;
  health(): Record<string, unknown>;
  /** Absolute path to the built PWA (pwa/dist) to serve as the app shell; optional. */
  pwaDir?: string;
  mintWebpaneToken(resource: WebpaneResource): { cookieValue: string; maxAgeSeconds: number };
  checkWebpaneCookie(cookieValue: string | undefined, resource: WebpaneResource): boolean;
  /** Dev-server ports currently resolved for any known folder (spec §7 port allowlist). */
  listResolvedDevServerPorts(): number[];
  /** Reverse-proxies to a resolved dev-server port. Trusts its caller — the route performs the allowlist check. */
  proxyDevServer(
    port: number,
    path: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}

/** Hosts always implicitly include loopback + the bind address. */
function effectiveHosts(c: Config): string[] {
  return [...c.allowedHosts, 'localhost', '127.0.0.1', '[::1]', c.bindAddress];
}
/** Origins implicitly include the daemon's own origins (the PWA is served same-origin). */
function effectiveOrigins(c: Config): string[] {
  const own = [`http://${c.bindAddress}:${c.port}`, `https://${c.bindAddress}:${c.port}`,
               `http://localhost:${c.port}`, `http://127.0.0.1:${c.port}`];
  return [...c.allowedOrigins, ...own];
}

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

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { config } = deps;
  const hosts = effectiveHosts(config);
  const origins = effectiveOrigins(config);

  // Needed so the dev-server proxy route (below) can forward a request body
  // of ANY content type — Fastify 5 otherwise 415s any content type without
  // a registered parser (multipart, octet-stream, missing content-type...).
  // Does not affect 'application/json', which keeps Fastify's own default
  // parser (a specific parser always wins over the '*' catch-all).
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));

  // X-Request-Id on every request + response (§16.2).
  app.addHook('onRequest', async (req, reply) => {
    const rid = resolveRequestId(req.headers['x-request-id'] as string | undefined);
    (req as { requestId?: string }).requestId = rid;
    reply.header('x-request-id', rid);
  });

  // T3 (DNS rebinding): Host allowlist BEFORE auth, on every route.
  app.addHook('onRequest', async (req, reply) => {
    if (!isHostAllowed(req.headers.host, hosts)) {
      return reply.code(421).send(errorEnvelope('FORBIDDEN', 'Host not allowed'));
    }
    // T4: CORS Origin allowlist (never '*').
    const origin = req.headers.origin as string | undefined;
    if (!isOriginAllowed(origin, origins)) {
      return reply.code(403).send(errorEnvelope('FORBIDDEN', 'Origin not allowed'));
    }
  });

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

  app.get('/api/health', async () => ({ success: true, data: deps.health() }));

  app.get('/api/sessions', async () => ({ success: true, data: deps.listSessions() }));

  app.get('/api/sessions/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cursor = (req.query as { cursor?: string }).cursor;
    const t = deps.getTranscript(id, cursor);
    if (!t) return reply.code(HTTP_STATUS.NOT_FOUND).send(errorEnvelope('NOT_FOUND', 'no such session'));
    return { success: true, data: t };
  });

  app.post('/api/sessions/:id/prompt', async (req, reply) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'Idempotency-Key header required'));
    const parsed = SendPromptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'invalid body'));
    const { id } = req.params as { id: string };
    const requestId = (req as { requestId?: string }).requestId ?? '';
    try {
      const rec = await deps.sendPrompt({ sessionId: id, key, text: parsed.data.text, requestId, clientId: 'phone' });
      return { success: true, data: rec };
    } catch (e) {
      const raw = (e as { code?: string }).code;
      const code = raw === 'INVALID_INPUT' || raw === 'FORBIDDEN' ? raw : 'INTERNAL_ERROR';
      return reply.code(HTTP_STATUS[code]).send(errorEnvelope(code, (e as Error).message));
    }
  });

  app.post('/api/sessions/:id/takeover', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await deps.takeover(id);
      return { success: true, data: r };
    } catch (e) {
      const raw = (e as { code?: string }).code;
      const code = raw === 'INVALID_INPUT' || raw === 'NOT_FOUND' || raw === 'FORBIDDEN' ? raw : 'EXTERNAL_SERVICE_ERROR';
      return reply.code(HTTP_STATUS[code]).send(errorEnvelope(code, (e as Error).message));
    }
  });

  app.post('/api/sessions/:id/handback', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await deps.handback(id);
      return { success: true, data: r };
    } catch (e) {
      const raw = (e as { code?: string }).code;
      const code = raw === 'INVALID_INPUT' || raw === 'NOT_FOUND' || raw === 'FORBIDDEN' ? raw : 'EXTERNAL_SERVICE_ERROR';
      return reply.code(HTTP_STATUS[code]).send(errorEnvelope(code, (e as Error).message));
    }
  });

  app.post('/api/webpane-token', async (req, reply) => {
    const parsed = WebpaneTokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'invalid body'));
    const resource = parsed.data as WebpaneResource;
    const { cookieValue, maxAgeSeconds } = deps.mintWebpaneToken(resource);
    reply.header('set-cookie', `mv_webpane=${cookieValue}; Path=/api/webpane/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
    return { success: true, data: { ok: true } };
  });

  // Response headers stripped when relaying a dev-server proxy reply: fetch()
  // already transparently decoded any gzip encoding, so replaying
  // content-encoding verbatim would make the browser try to double-decode;
  // content-length/transfer-encoding/connection are framing headers Fastify
  // recomputes itself for what it actually sends.
  const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

  // Registered in a child Fastify context so the raw-buffer 'application/json'
  // parser below is scoped ONLY to this route, not the whole app: Fastify's
  // built-in 'application/json' parser is an exact-content-type match and
  // takes priority over the app-level '*' catch-all above, so without this
  // scoping a JSON-content-typed request to this route would still get its
  // body parsed into a plain object (not Uint8Array) before reaching the
  // handler — corrupting it before it's ever handed to fetch(). The
  // app-level '*' catch-all still covers every OTHER content type this route
  // may see (multipart/form-data, octet-stream, none at all, ...); this
  // registration only needs to add the one exact-match exception.
  app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));

    instance.all('/api/webpane/devserver/:port/*', async (req, reply) => {
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
      const forwardBody = req.method !== 'GET' && req.method !== 'HEAD' ? (req.body as Uint8Array | undefined) : undefined;
      try {
        const upstream = await deps.proxyDevServer(port, forwardPath, {
          method: req.method,
          headers,
          ...(forwardBody !== undefined ? { body: forwardBody } : {}),
        });
        for (const [k, v] of Object.entries(upstream.headers)) {
          if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) reply.header(k, v);
        }
        // Fastify's own reply sets a default `connection` header regardless of
        // what the upstream sent — remove it explicitly rather than relying on
        // simply not forwarding the upstream's copy (spec: fetch() already
        // decoded the body, so replaying framing headers verbatim is wrong).
        reply.removeHeader('connection');
        return reply.code(upstream.status).send(Buffer.from(upstream.body));
      } catch (e) {
        return reply.code(502).send(errorEnvelope('EXTERNAL_SERVICE_ERROR', e instanceof Error ? e.message : String(e)));
      }
    });
  });

  // Serve the built PWA for any non-API GET (SPA fallback to index.html).
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  };
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '/';
    if (url.startsWith('/api/') || url.startsWith('/ws') || req.method !== 'GET') {
      return reply.code(404).send(errorEnvelope('NOT_FOUND', 'not found'));
    }
    if (!deps.pwaDir) return reply.code(404).send(errorEnvelope('NOT_FOUND', 'PWA not built'));
    // Prevent path traversal: resolve within pwaDir, fall back to index.html.
    const rel = normalize(url).replace(/^(\.\.(\/|\\|$))+/, '');
    let file = join(deps.pwaDir, rel);
    if (!file.startsWith(deps.pwaDir) || !existsSync(file) || url === '/') {
      file = join(deps.pwaDir, 'index.html');
    }
    if (!existsSync(file)) return reply.code(404).send(errorEnvelope('NOT_FOUND', 'PWA not built'));
    reply.header('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    return reply.send(readFileSync(file));
  });

  return app;
}
