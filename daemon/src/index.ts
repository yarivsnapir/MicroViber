import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { buildApp } from './api/app.js';
import { createServices } from './services/services.js';
import { buildPairingUrl, selectPairingTarget } from './server/pairing.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const stateDir = join(homedir(), '.microviber');
const tokenFile = join(stateDir, 'token');
const auditPath = join(stateDir, 'audit.jsonl');

/** Daemon entrypoint. Off by default — started deliberately (spec §9.4). */
async function main(): Promise<void> {
  mkdirSync(stateDir, { recursive: true });

  // Stable bearer token: env > persisted file > generate-and-persist.
  // A stable token means pairing survives restarts (rotate = delete the file).
  if (!process.env.MV_BEARER_TOKEN && existsSync(tokenFile)) {
    process.env.MV_BEARER_TOKEN = readFileSync(tokenFile, 'utf8').trim();
  }
  const config = loadConfig(process.env);
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, config.bearerToken, { mode: 0o600 });

  const services = createServices(config, (line) => {
    try { appendFileSync(auditPath, line); } catch { /* audit best-effort */ }
  });
  // Serve the built PWA (pwa/dist) as the app shell, same origin as the API.
  const here = dirname(fileURLToPath(import.meta.url));
  const pwaDir = resolve(here, '..', '..', 'pwa', 'dist');
  const app = buildApp({ ...services, pwaDir });

  await app.listen({ host: config.bindAddress, port: config.port });
  console.log(`MicroViber daemon listening on ${config.bindAddress}:${config.port}`);
  const pairingTarget = selectPairingTarget(config);
  console.log(`Pair (open on your phone): ${buildPairingUrl(pairingTarget.host, pairingTarget.port, config.bearerToken, pairingTarget.scheme)}`);
}

main().catch((err: unknown) => {
  // Robust: never let error FORMATTING crash (Node v24 util.inspect can throw
  // on some objects). Print strings only.
  const e = err as { name?: string; message?: string; issues?: Array<{ path: unknown[]; message: string }> };
  if (e?.name === 'ZodError' && Array.isArray(e.issues)) {
    console.error('MicroViber config error — check your .env:');
    for (const i of e.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  } else {
    console.error('MicroViber daemon failed to start:', e?.message ?? String(err));
  }
  process.exit(1);
});
