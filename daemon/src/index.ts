import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { buildApp } from './api/app.js';
import { createServices } from './services/services.js';
import { buildPairingUrl, selectPairingTarget } from './server/pairing.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPushStore } from './lib/push-subscription-store.js';
import { createPushSender } from './lib/push-sender.js';
import { startNotifyLoop } from './services/notify-dispatch.js';

const stateDir = join(homedir(), '.microviber');
const tokenFile = join(stateDir, 'token');
const auditPath = join(stateDir, 'audit.jsonl');
const pushStorePath = join(stateDir, 'push-subscriptions.json');
// Same order of magnitude as the PWA's own 4s session poll; discovery is a
// synchronous filesystem scan, so this must not be aggressive.
const NOTIFY_POLL_MS = 5_000;

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

  // Push subscriptions persist across restarts (AC3) — a launchd KeepAlive
  // restart must not silently un-subscribe the phone. A file that cannot be
  // loaded degrades to push-disabled instead of throwing: this runs before
  // app.listen under a KeepAlive agent, so throwing would crash-loop the whole
  // CONTROL PLANE over a notifications file (review finding C1). loadPushStore
  // never throws and logs the path loudly.
  const pushStore = loadPushStore(pushStorePath, (m) => console.error(m));
  const services = createServices(config, (line) => {
    try { appendFileSync(auditPath, line); } catch { /* audit best-effort */ }
  }, pushStore ? { pushStore } : {});
  // Serve the built PWA (pwa/dist) as the app shell, same origin as the API.
  const here = dirname(fileURLToPath(import.meta.url));
  const pwaDir = resolve(here, '..', '..', 'pwa', 'dist');
  const app = buildApp({ ...services, pwaDir });

  await app.listen({ host: config.bindAddress, port: config.port });
  console.log(`MicroViber daemon listening on ${config.bindAddress}:${config.port}`);
  const pairingTarget = selectPairingTarget(config);
  console.log(`Pair (open on your phone): ${buildPairingUrl(pairingTarget.host, pairingTarget.port, config.bearerToken, pairingTarget.scheme)}`);

  // Web Push is opt-in (spec T19): with no VAPID keys the daemon makes no
  // outbound network call whatsoever — exactly its pre-story posture.
  if (config.vapid && pushStore) {
    const sender = createPushSender(config.vapid, { log: (m) => console.error(m) });
    const loop = startNotifyLoop({ listSessions: services.listSessions, store: pushStore, sender, intervalMs: NOTIFY_POLL_MS, log: (m) => console.error(m) });
    // Prime at t=0: startNotifyLoop only schedules a setInterval, so the priming
    // cycle would otherwise land a full NOTIFY_POLL_MS late — and any session
    // that went idle inside that window would be primed as already-idle and
    // never notified until it cycled through `working` again.
    void loop.tick();
    console.log(`Push notifications: enabled — ${pushStore.list().length} subscription(s) in ${pushStorePath}; polling every ${NOTIFY_POLL_MS / 1000}s`);
  } else if (config.vapid) {
    console.log('Push notifications: disabled — the subscription store could not be loaded (see the error above). Everything else is running.');
  } else {
    console.log('Push notifications: disabled (MV_VAPID_PUBLIC_KEY / MV_VAPID_PRIVATE_KEY unset — INSTALL.md Step 3.2). No outbound calls are made while disabled.');
  }
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
