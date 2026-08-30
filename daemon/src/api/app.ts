import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { connect } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
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
  /** The resource a live mv_webpane cookie is bound to, or null — the content-origin root proxy's routing key (story microviber-track-b-3). */
  resolveWebpaneCookie(cookieValue: string | undefined): WebpaneResource | null;
  /** Dev-server ports currently resolved for any known folder (spec §7 port allowlist). */
  listResolvedDevServerPorts(): number[];
  /** Reverse-proxies to a resolved dev-server port. Trusts its caller — the route performs the allowlist check. */
  proxyDevServer(
    port: number,
    path: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  /** Reads a local file for the webpane viewer. No folder restriction (spec §9 accepted risk). */
  readLocalFile(path: string): { bytes: Buffer; contentType: string } | null;
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

/** The two routes a sandboxed webpane iframe's own document/subresource requests target — see the Origin and auth carve-outs below. */
function isWebpaneContentPath(path: string): boolean {
  return path.startsWith('/api/webpane/devserver/') || path.startsWith('/api/webpane/localfile');
}

/** The explicit port in a Host header, or null when absent (default port). Handles bracketed IPv6 (`[::1]:8443`). */
function hostHeaderPort(hostHeader: string | undefined): number | null {
  if (!hostHeader) return null;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1) return null;
    const rest = hostHeader.slice(end + 1);
    return rest.startsWith(':') ? Number(rest.slice(1)) || null : null;
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon === -1 ? null : Number(hostHeader.slice(colon + 1)) || null;
}

// Standard hop-by-hop headers (RFC 7230 §6.1) — meaningful only for a
// single transport hop, never to be forwarded end-to-end. Shared by both
// the request-side and response-side strip lists below: forwarding
// `transfer-encoding`, `connection`, or `upgrade` verbatim on the REQUEST
// side makes undici's fetch() throw outright (verified on Node 22 — an
// actual thrown error, not just odd behavior), which the route's
// catch-block turns into an opaque 502 instead of a clean rejection; on the
// RESPONSE side they're framing headers Fastify recomputes itself.
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-authenticate',
]);

// Request headers stripped before forwarding to the proxied dev server:
// the hop-by-hop set above, plus headers that must not leak the daemon's
// own auth/session context to a third-party dev server (host, authorization,
// cookie), that Fastify/undici recompute for the outgoing request
// (content-length), or that carry the BROWSER's client-side context rather
// than anything the dev server needs (origin) — the dev server isn't asked
// to do CORS with us, it just serves files, so forwarding the browser's
// Origin verbatim serves no purpose here and actively breaks dev servers
// that run their own origin-validation (story microviber-track-b-3,
// 2026-08-29: Next.js/Turbopack's dev server 403s any request carrying the
// literal Origin: null a sandboxed iframe sends, entirely independently of
// and unaware of this daemon's own Origin check).
const STRIPPED_REQUEST_HEADERS = new Set([...HOP_BY_HOP_HEADERS, 'host', 'authorization', 'cookie', 'content-length', 'origin']);

/**
 * Rebuilds a WebSocket upgrade request head for forwarding to the proxied
 * dev server (content plane, story microviber-track-b-3). Unlike the HTTP
 * proxy, `connection`/`upgrade`/`sec-websocket-*` MUST be forwarded — they
 * ARE the handshake — so this deliberately does NOT apply the hop-by-hop
 * strip set. It still never leaks the daemon's auth context upstream
 * (cookie, authorization) and drops the browser-context `origin` for the
 * same reason the HTTP proxy does (dev servers 403 unrecognized Origins).
 * Exported for unit tests; the socket splice around it is exercised live.
 */
export function buildUpgradeRequestHead(method: string, url: string, headers: IncomingHttpHeaders, upstreamPort: number): string {
  const DROPPED = new Set(['host', 'cookie', 'authorization', 'origin']);
  const lines = [`${method} ${url} HTTP/1.1`, `host: 127.0.0.1:${upstreamPort}`];
  for (const [k, v] of Object.entries(headers)) {
    if (DROPPED.has(k.toLowerCase()) || v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

// Response headers stripped when relaying a dev-server proxy reply: fetch()
// already transparently decoded any gzip encoding, so replaying
// content-encoding verbatim would make the browser try to double-decode;
// content-length is a framing header Fastify recomputes itself for what it
// actually sends. set-cookie is stripped because the proxied dev server is
// a DIFFERENT origin from the daemon — relaying its Set-Cookie would let it
// write cookies on the daemon's own origin, where it could shadow the
// mv_webpane auth cookie (review finding).
const STRIPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP_HEADERS, 'content-encoding', 'content-length', 'set-cookie']);

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

  // X-Request-Id on every request + response (§16.2).
  app.addHook('onRequest', async (req, reply) => {
    const rid = resolveRequestId(req.headers['x-request-id'] as string | undefined);
    (req as { requestId?: string }).requestId = rid;
    reply.header('x-request-id', rid);
  });

  // ── Webpane CONTENT plane (story microviber-track-b-3, 2026-08-30) ──
  // A second tailscale-served HTTPS port (config.webpaneContentPort, default
  // 8443) maps to this same daemon. Any request whose Host header carries
  // that port is dev-server content traffic: a SEPARATE browser origin from
  // the control plane, so the Web pane's iframe can run with
  // allow-same-origin (real storage/fetch — Firebase-style apps actually
  // work) while still never being same-origin with the PWA's bearer token.
  // Handled entirely in this hook, BEFORE any route matching: the daemon's
  // own API surface simply does not exist on the content origin — every
  // path, including /api/*, is reverse-proxied to the port the mv_webpane
  // cookie is bound to (the cookie is the routing key; framed apps request
  // absolute paths like /_next/* that carry no port of their own).
  async function handleContentPlane(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const cookieValue = parseCookieHeader(req.headers.cookie, 'mv_webpane');
    const resource = deps.resolveWebpaneCookie(cookieValue);
    if (!resource || resource.kind !== 'devserver') {
      return reply.code(401).send(errorEnvelope('UNAUTHENTICATED', 'missing or invalid webpane cookie'));
    }
    if (!deps.listResolvedDevServerPorts().includes(resource.port)) {
      return reply.code(403).send(errorEnvelope('FORBIDDEN', 'port is not currently resolved for any known folder'));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    // onRequest runs before any body parsing, so read the raw stream
    // ourselves — the proxy forwards bytes verbatim, never parsed content.
    let body: Uint8Array | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) chunks.push(chunk as Buffer);
      if (chunks.length > 0) body = Buffer.concat(chunks);
    }
    try {
      const upstream = await deps.proxyDevServer(resource.port, req.url, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) reply.header(k, v);
      }
      reply.removeHeader('connection');
      return reply.code(upstream.status).send(Buffer.from(upstream.body));
    } catch (e) {
      return reply.code(502).send(errorEnvelope('EXTERNAL_SERVICE_ERROR', e instanceof Error ? e.message : String(e)));
    }
  }

  // T3 (DNS rebinding): Host allowlist BEFORE auth, on every route.
  app.addHook('onRequest', async (req, reply) => {
    if (!isHostAllowed(req.headers.host, hosts)) {
      return reply.code(421).send(errorEnvelope('FORBIDDEN', 'Host not allowed'));
    }
    // Content-plane traffic short-circuits here: no Origin allowlist (its
    // auth is the resource-scoped cookie capability, and a framed app's own
    // same-origin POSTs legitimately carry Origin https://<host>:<content
    // port>, which the control-plane allowlist will never contain), no route
    // matching, no daemon API.
    if (hostHeaderPort(req.headers.host) === config.webpaneContentPort) {
      return handleContentPlane(req, reply);
    }
    // T4: CORS Origin allowlist (never '*'). Narrow carve-out (T15, story
    // microviber-track-b-3 — 2026-08-29 manual-test finding): the Web pane's
    // two content routes are deliberately loaded inside a
    // sandbox="allow-scripts allow-forms" iframe with no allow-same-origin
    // (T15's own mitigation for a different threat), which forces the
    // document AND every subresource request it makes itself into an OPAQUE
    // origin — browsers serialize that as the literal string "null" in the
    // Origin header. A correctly working instance of this feature can
    // therefore never present any Origin OTHER than "null" to these two
    // routes; rejecting "null" here made the feature entirely non-functional
    // (every asset request 403'd) with no security benefit, since the real
    // authorization for these two routes is the resource-scoped mv_webpane
    // cookie/token (checked further below), not this generic same-site check.
    const origin = req.headers.origin as string | undefined;
    const path = req.url.split('?')[0] ?? req.url;
    const isWebpaneNullOrigin = isWebpaneContentPath(path) && origin === 'null';
    if (!isWebpaneNullOrigin && !isOriginAllowed(origin, origins)) {
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
    if (isWebpaneContentPath(path)) {
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
    // Re-validate the resource at mint time (spec §7): a syntactically-valid
    // body isn't enough — fail fast here rather than deferring to first
    // navigation through the content route.
    if (resource.kind === 'devserver') {
      if (!deps.listResolvedDevServerPorts().includes(resource.port)) {
        return reply.code(403).send(errorEnvelope('FORBIDDEN', 'port is not currently resolved for any known folder'));
      }
    } else {
      // readLocalFile is the only way to check readability with this
      // interface — this reads the file's bytes once purely to validate,
      // and the client will read them again via the localfile route once it
      // mints and navigates. A real double-read; out of scope to cache here.
      if (deps.readLocalFile(resource.path) === null) {
        return reply.code(404).send(errorEnvelope('NOT_FOUND', 'file not found or unreadable'));
      }
    }
    const { cookieValue, maxAgeSeconds } = deps.mintWebpaneToken(resource);
    // Path=/ and SameSite=None (story microviber-track-b-3): the webpane
    // CONTENT origin (same hostname, config.webpaneContentPort) serves the
    // proxied dev server at root paths (/, /_next/*, the framed app's own
    // /api/*), and cookies are host-scoped and port-blind, so this one
    // cookie must cover both origins' webpane surfaces — Path=/api/webpane/
    // would never be sent on the content origin's root-path requests at all.
    // SameSite=None (with Secure, present) keeps it attached regardless of
    // the framing context. The CSRF bound this loosens browser-side is
    // enforced server-side instead: the daemon ACCEPTS this cookie only on
    // the two /api/webpane/* content routes and the content plane's root
    // proxy — every other route ignores cookies entirely (auth is the bearer
    // header) — and the capability itself stays bound to exactly one
    // resource for 5 minutes (WebpaneTokenStore).
    reply.header('set-cookie', `mv_webpane=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAgeSeconds}`);
    return { success: true, data: { ok: true } };
  });

  // Registered in a child Fastify context so both content-type parsers below
  // are scoped ONLY to this route, not the whole app: Fastify content-type
  // parsers are per-context, so registering them here (rather than on the
  // outer `app`) leaves every other route's body-parsing behavior (including
  // the default 415 for an unregistered content type) untouched.
  app.register(async (instance) => {
    // Needed so the dev-server proxy route can forward a request body of ANY
    // content type — Fastify 5 otherwise 415s any content type without a
    // registered parser (multipart, octet-stream, missing content-type...).
    instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));

    // Fastify's built-in 'application/json' parser is an exact-content-type
    // match and takes priority over the '*' catch-all above, so without this
    // scoping a JSON-content-typed request to this route would still get its
    // body parsed into a plain object (not Uint8Array) before reaching the
    // handler — corrupting it before it's ever handed to fetch(). The '*'
    // catch-all still covers every OTHER content type this route may see
    // (multipart/form-data, octet-stream, none at all, ...); this
    // registration only needs to add the one exact-match exception.
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
        if (typeof v === 'string' && !STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
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

  app.get('/api/webpane/localfile', async (req, reply) => {
    const { path } = req.query as { path?: string | string[] };
    if (!path || typeof path !== 'string') return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'path query param required'));
    const file = deps.readLocalFile(path);
    if (!file) return reply.code(404).send(errorEnvelope('NOT_FOUND', 'file not found or unreadable'));
    // Defense in depth (review finding): no server-side folder restriction on
    // this route by design (spec §9 accepted risk), and the client-side
    // iframe sandbox that's meant to neutralize served content doesn't exist
    // yet (a later story) — these two headers are a backstop so served
    // content can never execute with same-origin privilege in the meantime.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', 'sandbox allow-scripts');
    reply.header('content-type', file.contentType);
    return reply.send(file.bytes);
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
    const contentType = MIME[extname(file)] ?? 'application/octet-stream';
    if (contentType.startsWith('text/html')) {
      // Clickjacking protection for the PWA shell. Browsers only honor
      // frame-ancestors in a real header — in a <meta> CSP it is ignored AND
      // logs a console error on every load, which is why it lives here
      // rather than in pwa/index.html's meta tag (story microviber-track-b-3
      // cleanup). Scoped to HTML only: adding it to JS/CSS is meaningless.
      reply.header('content-security-policy', "frame-ancestors 'none'");
    }
    reply.header('content-type', contentType);
    return reply.send(readFileSync(file));
  });

  // WebSocket upgrades on the CONTENT plane (story microviber-track-b-3):
  // Next.js/Vite dev clients open an HMR WebSocket (e.g. /_next/webpack-hmr)
  // against the frame's own origin. Without this listener, Node hands the
  // upgrade to Fastify as a plain request, the HTTP proxy strips the
  // Upgrade/Connection headers as hop-by-hop, and the dev server 404s the
  // de-fanged GET — the framed app then spams reconnect attempts forever.
  // This splices the raw sockets instead: same auth as handleContentPlane
  // (Host allowlist + the mv_webpane cookie as the routing capability), then
  // a verbatim byte pipe both ways — protocol-agnostic, no WS framing here.
  // Main-origin upgrades stay refused (nothing serves WS today: the PWA
  // polls HTTP, and Hub has no socket transport wired up).
  app.server.on('upgrade', (req, socket, head) => {
    const refuse = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!isHostAllowed(req.headers.host, hosts)) return refuse('421 Misdirected Request');
    if (hostHeaderPort(req.headers.host) !== config.webpaneContentPort) return refuse('404 Not Found');
    const cookieValue = parseCookieHeader(req.headers.cookie, 'mv_webpane');
    const resource = deps.resolveWebpaneCookie(cookieValue);
    if (!resource || resource.kind !== 'devserver') return refuse('401 Unauthorized');
    if (!deps.listResolvedDevServerPorts().includes(resource.port)) return refuse('403 Forbidden');

    const upstream = connect(resource.port, '127.0.0.1');
    const closeBoth = (): void => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', closeBoth);
    socket.on('error', closeBoth);
    upstream.on('connect', () => {
      upstream.write(buildUpgradeRequestHead(req.method ?? 'GET', req.url ?? '/', req.headers, resource.port));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });

  return app;
}
