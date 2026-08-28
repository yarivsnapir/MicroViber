/**
 * Manual-test verification script for story microviber-track-b-2 (Web pane
 * backend). Backend-only story, no PWA UI yet — verifies via a real running
 * daemon + a real "dev server" stand-in + real HTTP calls (curl-equivalent),
 * exercising the actual network stack rather than injected/mocked deps.
 *
 * Run: npx tsx docs/features/microviber-track-b/stories/story-2-manual-test.ts
 * (from the microviber/ repo root)
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../../../daemon/src/api/app.js';
import { createServices } from '../../../../daemon/src/services/services.js';
import type { Config } from '../../../../daemon/src/config.js';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const BEARER = randomBytes(24).toString('base64url');
  const config: Config = {
    bindAddress: '127.0.0.1',
    port: 18730,
    bearerToken: BEARER,
    allowedHosts: [],
    allowedOrigins: [],
    vapid: null,
    claudeBin: 'claude',
  };

  // Stand-in "dev server" — a real, separate HTTP server on a real port,
  // simulating what a folder's resolved devServerPort would point to.
  const DEV_SERVER_PORT = 18899;
  const devServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>real dev server content</body></html>');
  });
  await new Promise<void>((resolve) => devServer.listen(DEV_SERVER_PORT, '127.0.0.1', resolve));

  // Real local file to serve through the localfile route.
  const tmpDir = mkdtempSync(join(tmpdir(), 'mv-story2-'));
  const localFilePath = join(tmpDir, 'mockup.html');
  writeFileSync(localFilePath, '<h1>mockup</h1>');

  // Real services wiring (createServices), but with listSessions/
  // listResolvedDevServerPorts overridden — this story's own AC scope is the
  // webpane routes/auth, not session discovery (Track A machinery, already
  // covered elsewhere) — so we stand in for "this port is currently
  // resolved for a known folder" without needing a real Claude Code session.
  const services = createServices(config, () => {});
  const deps = {
    ...services,
    listSessions: () => [],
    listResolvedDevServerPorts: () => [DEV_SERVER_PORT],
  };
  const app = buildApp(deps);
  await app.listen({ host: config.bindAddress, port: config.port });
  const base = `http://127.0.0.1:${config.port}`;

  try {
    // --- AC1: POST /api/webpane-token with real bearer, confirm Set-Cookie shape ---
    const mintRes = await fetch(`${base}/api/webpane-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'devserver', port: DEV_SERVER_PORT }),
    });
    const setCookie = mintRes.headers.get('set-cookie') ?? '';
    check('AC1: mint returns 200', mintRes.status === 200, `got ${mintRes.status}`);
    check('AC1: Set-Cookie has Path=/api/webpane/', setCookie.includes('Path=/api/webpane/'));
    check('AC1: Set-Cookie has HttpOnly', setCookie.includes('HttpOnly'));
    check('AC1: Set-Cookie has Secure', setCookie.includes('Secure'));
    check('AC1: Set-Cookie has SameSite=Strict', setCookie.includes('SameSite=Strict'));
    check('AC1: Set-Cookie has Max-Age=300', setCookie.includes('Max-Age=300'));
    const cookieMatch = /mv_webpane=([^;]+)/.exec(setCookie);
    const devCookie = cookieMatch?.[1] ?? '';
    check('AC1: cookie value extracted', devCookie.length > 0);

    // --- AC2 + AC3: cookie-only proxy access to the real dev server ---
    const proxyRes = await fetch(`${base}/api/webpane/devserver/${DEV_SERVER_PORT}/`, {
      headers: { cookie: `mv_webpane=${devCookie}` },
    });
    const proxyBody = await proxyRes.text();
    check('AC3: cookie-only proxy request succeeds (200)', proxyRes.status === 200, `got ${proxyRes.status}`);
    check('AC3: proxy returns real dev-server content', proxyBody.includes('real dev server content'), proxyBody);

    // --- AC2: same cookie must NOT work on /api/sessions ---
    const sessionsRes = await fetch(`${base}/api/sessions`, { headers: { cookie: `mv_webpane=${devCookie}` } });
    check('AC2: cookie does not grant access to /api/sessions (401)', sessionsRes.status === 401, `got ${sessionsRes.status}`);

    // --- AC2: mint endpoint itself never accepts the cookie as a header substitute ---
    const mintWithCookieOnly = await fetch(`${base}/api/webpane-token`, {
      method: 'POST',
      headers: { cookie: `mv_webpane=${devCookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'devserver', port: DEV_SERVER_PORT }),
    });
    check('AC2: mint endpoint rejects cookie-only auth (401)', mintWithCookieOnly.status === 401, `got ${mintWithCookieOnly.status}`);

    // --- AC3: T13 allowlist — a port NOT currently resolved is 403'd ---
    const NOT_RESOLVED_PORT = 19999;
    const forbiddenRes = await fetch(`${base}/api/webpane/devserver/${NOT_RESOLVED_PORT}/`, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    check('AC3: non-allowlisted port is 403 FORBIDDEN', forbiddenRes.status === 403, `got ${forbiddenRes.status}`);

    // --- AC4 + AC5: mint for a local file path, fetch via cookie, confirm content-type + bytes ---
    const fileMintRes = await fetch(`${base}/api/webpane-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'localfile', path: localFilePath }),
    });
    const fileSetCookie = fileMintRes.headers.get('set-cookie') ?? '';
    const fileCookie = /mv_webpane=([^;]+)/.exec(fileSetCookie)?.[1] ?? '';
    const fileRes = await fetch(`${base}/api/webpane/localfile?path=${encodeURIComponent(localFilePath)}`, {
      headers: { cookie: `mv_webpane=${fileCookie}` },
    });
    const fileBody = await fileRes.text();
    check('AC4: localfile route returns 200 via cookie', fileRes.status === 200, `got ${fileRes.status}`);
    check('AC4: content-type guessed correctly (text/html)', fileRes.headers.get('content-type') === 'text/html', fileRes.headers.get('content-type') ?? 'none');
    check('AC4: body bytes match the real file', fileBody === '<h1>mockup</h1>', fileBody);

    // --- AC5: a devserver-scoped cookie must NOT work on the localfile route (cross-resource) ---
    const crossRes = await fetch(`${base}/api/webpane/localfile?path=${encodeURIComponent(localFilePath)}`, {
      headers: { cookie: `mv_webpane=${devCookie}` },
    });
    check('AC5: devserver cookie rejected on localfile route (401)', crossRes.status === 401, `got ${crossRes.status}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    await app.close();
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
