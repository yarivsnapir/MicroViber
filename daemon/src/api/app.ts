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
import { SendPromptBody, StartOwnedBody, errorEnvelope, HTTP_STATUS } from '../schemas/api.js';

export interface AppDeps {
  config: Config;
  listSessions(): SessionSummary[];
  getTranscript(id: string, cursor: string | undefined): { events: unknown[]; nextCursor: string | null } | null;
  sendPrompt(a: { sessionId: string; key: string; text: string; requestId: string; clientId: string }): Promise<PromptRecord>;
  startOwned(a: { cwd: string; name: string }): Promise<{ id: string }>;
  /** Take over an existing idle, discovered session (spec §3.2 write path). */
  takeover(sessionId: string): Promise<{ id: string; mode: 'owned' }>;
  /** Deliberate hand-back: releases ownership and disposes the owned process. Idempotent — a no-op 200 on a session that was never taken over. */
  handback(sessionId: string): Promise<{ id: string; mode: 'readonly' }>;
  health(): Record<string, unknown>;
  /** Absolute path to the built PWA (pwa/dist) to serve as the app shell; optional. */
  pwaDir?: string;
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
    const url = req.url.split('?')[0] ?? req.url;
    const isData = url.startsWith('/api/') || url.startsWith('/ws');
    if (!isData) return;                 // static shell: public
    if (url === '/api/health') return;   // liveness: public
    if (!checkBearer(req.headers.authorization, config.bearerToken)) {
      return reply.code(401).send(errorEnvelope('UNAUTHENTICATED', 'missing or invalid bearer token'));
    }
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

  app.post('/api/sessions/owned', async (req, reply) => {
    const parsed = StartOwnedBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope('INVALID_INPUT', 'invalid body'));
    try {
      const r = await deps.startOwned(parsed.data);
      return { success: true, data: r };
    } catch (e) {
      const code = (e as { code?: string }).code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'EXTERNAL_SERVICE_ERROR';
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
