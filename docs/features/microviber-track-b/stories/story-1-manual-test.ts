// Manual verification for story microviber-track-b-1 (dev-server port resolution).
// Backend-only story, no UI yet — exercises the REAL resolver/loader against
// real scratch folders on disk (no dependency injection / no mocked fs),
// covering the story's own manual test checklist items 2-4 (item 1, the
// npm test/typecheck/lint gate, already ran separately and is green).
//
// Run: cd microviber/daemon && npx tsx ../../features/microviber-track-b/stories/story-1-manual-test.ts

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevportsConfig } from '../../../microviber/daemon/src/lib/webpane/devports-config.js';
import { resolveDevServerPort } from '../../../microviber/daemon/src/lib/webpane/port-resolver.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (ok) pass++; else fail++;
}

const root = mkdtempSync(join(tmpdir(), 'mv-track-b-1-'));

// --- Checklist item 2: a real .env with PORT=9005, no devports.json entry ---
const envFolder = join(root, 'has-dotenv');
mkdirSync(envFolder);
writeFileSync(join(envFolder, '.env'), 'FOO=bar\nPORT=9005\n');
check('tier 1 (.env): resolves PORT=9005 from a real .env file', resolveDevServerPort(envFolder, {}), 9005);

// --- Checklist item 3: devports.json entry for a folder with no .env ---
const devportsFolder = join(root, 'has-devports-entry');
mkdirSync(devportsFolder);
const devportsJsonPath = join(root, 'devports.json');
writeFileSync(devportsJsonPath, JSON.stringify({ [devportsFolder]: { port: 4321 } }));
const loadedDevports = loadDevportsConfig(devportsJsonPath);
check(
  'tier 2 (devports.json): a folder with no .env resolves from a real devports.json file',
  resolveDevServerPort(devportsFolder, loadedDevports),
  4321,
);

// --- Checklist item 4: neither .env, devports.json entry, nor a recognizable config ---
const emptyFolder = join(root, 'nothing-here');
mkdirSync(emptyFolder);
check(
  'no tier resolves: folder with no .env, no devports.json entry, no config file → null',
  resolveDevServerPort(emptyFolder, loadedDevports),
  null,
);

// --- Bonus: loadDevportsConfig against a real missing file (optional-file fail-open) ---
check(
  'loadDevportsConfig: missing devports.json on real disk returns {} (optional, fail-open)',
  Object.keys(loadDevportsConfig(join(root, 'does-not-exist.json'))).length,
  0,
);

// --- Bonus: tier 1 wins over tier 2 when a folder has both ---
const bothFolder = join(root, 'has-both');
mkdirSync(bothFolder);
writeFileSync(join(bothFolder, '.env'), 'PORT=1111\n');
const devportsWithBoth = loadDevportsConfig(
  (() => {
    const p = join(root, 'devports-both.json');
    writeFileSync(p, JSON.stringify({ [bothFolder]: { port: 2222 } }));
    return p;
  })(),
);
check('tier 1 wins over tier 2 when both are present on real disk', resolveDevServerPort(bothFolder, devportsWithBoth), 1111);

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
