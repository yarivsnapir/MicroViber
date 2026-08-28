# Dev-server Port Resolution & devports.json Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MicroViber daemon a best-effort, explicit-first port resolver (`.env` → `devports.json` → static config scan) and expose the resolved port on every `SessionSummary`, so later stories can build a "Web pane" without guessing or running-process scanning.

**Architecture:** Two new pure-function modules under `daemon/src/lib/webpane/` (mirroring the existing `lib/claude-adapter/` isolation pattern): a `devports.json` loader/validator (Task 1) and a 3-tier port resolver that consumes it (Task 2). Task 3 wires the resolver into `domain/registry.ts`'s `buildSummary` and `services/services.ts`'s `listSessions`, and fixes a pre-existing type drift between the daemon's `SessionSummary` and the PWA's copy of that type.

**Tech Stack:** Node 22 + TypeScript (strict) + Zod 3 (daemon); Vitest 4 for tests. This story touches no PWA runtime code beyond a type-only file (`pwa/src/lib/types.ts`).

## Global Constraints

- Test gate: `npm run typecheck && npm run lint && npm test` (run from `microviber/` root) must pass before every commit.
- TS strictness per `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. `@typescript-eslint/no-explicit-any` is an eslint error — any `any` needs a `// reason:` comment.
- Adapter quarantine: nothing outside `daemon/src/lib/claude-adapter/` may read `~/.claude/*` paths. New webpane code lives in `daemon/src/lib/webpane/`, which has no reason to reference `~/.claude` paths at all.
- Layering fence: `schemas/ → domain/ → services/ → api/`, no upward imports.
- Fail closed: `microviber/devports.json` is optional (missing ⇒ `{}`), but malformed JSON or a schema violation must throw — never silently resolve to "no config".
- Tiers 1 and 3 of the port resolver read project-controlled files (`.env`, `vite.config.*`, `package.json`, etc.) as **plain text only** — never imported/executed/required. This is a hard requirement (spec.md §9, threat T13's residual risk).
- Relative imports use explicit `.js` extensions throughout the daemon (ESM convention already in force).
- Every `git commit` in this plan's steps is a real commit — run it, don't skip it.

---

## Task 1: `devports.json` config loader

**Files:**
- Create: `daemon/src/lib/webpane/devports-config.ts`
- Test: `daemon/test/webpane/devports-config.test.ts`

**Interfaces:**
- Produces: `export interface DevportsEntry { port: number; framework?: string; startCommand?: string; }`, `export type DevportsConfig = Record<string, DevportsEntry>`, `export function loadDevportsConfig(path: string, deps?: { readFileIfExists?: (p: string) => string | null }): DevportsConfig`.

- [ ] **Step 1: Write the failing tests**

```ts
// daemon/test/webpane/devports-config.test.ts
import { describe, it, expect } from 'vitest';
import { loadDevportsConfig } from '../../src/lib/webpane/devports-config.js';

describe('loadDevportsConfig', () => {
  it('returns an empty config when the file does not exist (optional file)', () => {
    const cfg = loadDevportsConfig('/nonexistent/devports.json', { readFileIfExists: () => null });
    expect(cfg).toEqual({});
  });

  it('parses a valid config keyed by full absolute path', () => {
    const json = JSON.stringify({
      '/Users/you/Harness-2/studio': { port: 9005, framework: 'next', startCommand: 'npm run dev' },
      '/Users/you/Harness-2/audio-producer': { port: 9008 },
    });
    const cfg = loadDevportsConfig('/x/devports.json', { readFileIfExists: () => json });
    expect(cfg['/Users/you/Harness-2/studio']).toEqual({ port: 9005, framework: 'next', startCommand: 'npm run dev' });
    expect(cfg['/Users/you/Harness-2/audio-producer']).toEqual({ port: 9008 });
  });

  it('fails closed on malformed JSON — a typo should not silently resolve to no config', () => {
    expect(() => loadDevportsConfig('/x/devports.json', { readFileIfExists: () => '{ not json' })).toThrow();
  });

  it('fails closed on a schema violation (e.g. port out of range)', () => {
    const json = JSON.stringify({ '/x/studio': { port: 999999 } });
    expect(() => loadDevportsConfig('/x/devports.json', { readFileIfExists: () => json })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && npx vitest run test/webpane/devports-config.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/webpane/devports-config.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// daemon/src/lib/webpane/devports-config.ts
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Daemon-owned, explicit port config (spec §3 tier 2) — full-absolute-path
 * keyed, to avoid folder-basename collisions between differently-located
 * folders that happen to share a name. Optional file: missing => {}. Present
 * but malformed => throws (fail closed — a typo here should never silently
 * resolve to "no config" and leave the operator wondering why nothing works).
 */
const DevportsEntrySchema = z.object({
  port: z.number().int().min(1).max(65535),
  framework: z.string().optional(),
  startCommand: z.string().optional(),
});
const DevportsConfigSchema = z.record(z.string(), DevportsEntrySchema);

export interface DevportsEntry {
  port: number;
  framework?: string;
  startCommand?: string;
}
export type DevportsConfig = Record<string, DevportsEntry>;

export function loadDevportsConfig(
  path: string,
  deps: { readFileIfExists?: (p: string) => string | null } = {},
): DevportsConfig {
  const readFileIfExists = deps.readFileIfExists ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
  const raw = readFileIfExists(path);
  if (raw === null) return {};
  const parsed = JSON.parse(raw); // throws SyntaxError on malformed JSON — fail closed
  return DevportsConfigSchema.parse(parsed); // throws ZodError on schema violation — fail closed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && npx vitest run test/webpane/devports-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/lib/webpane/devports-config.ts daemon/test/webpane/devports-config.test.ts
git commit -m "feat(webpane): add devports.json loader (spec §3 tier 2)"
```

---

## Task 2: Port resolver — 3-tier resolution

**Files:**
- Create: `daemon/src/lib/webpane/port-resolver.ts`
- Test: `daemon/test/webpane/port-resolver.test.ts`

**Interfaces:**
- Consumes: `DevportsConfig` from Task 1 (`daemon/src/lib/webpane/devports-config.js`).
- Produces: `export function resolveDevServerPort(cwd: string, devports: DevportsConfig, deps?: { readFileIfExists?: (p: string) => string | null }): number | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// daemon/test/webpane/port-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDevServerPort } from '../../src/lib/webpane/port-resolver.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => files[p] ?? null };
}

describe('resolveDevServerPort (spec §3 — first match wins)', () => {
  it('tier 1: reads PORT= from the folder .env, never executes it', () => {
    const deps = fakeFs({ '/proj/.env': 'FOO=bar\nPORT=9015\nBAZ=qux\n' });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(9015);
  });

  it('tier 2: falls back to devports.json (full-path keyed) when no .env PORT', () => {
    const deps = fakeFs({});
    expect(resolveDevServerPort('/proj', { '/proj': { port: 9005 } }, deps)).toBe(9005);
  });

  it('tier 1 wins over tier 2 when both are present', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=1111\n' });
    expect(resolveDevServerPort('/proj', { '/proj': { port: 9005 } }, deps)).toBe(1111);
  });

  it('tier 3: scans vite.config.* for a port: field when tiers 1-2 are absent', () => {
    const deps = fakeFs({ '/proj/vite.config.ts': 'export default { server: { port: 3000 } }' });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(3000);
  });

  it('tier 3: scans package.json scripts for a --port flag', () => {
    const deps = fakeFs({ '/proj/package.json': JSON.stringify({ scripts: { dev: 'vite --port 4200' } }) });
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(4200);
  });

  it('returns null when no tier resolves anything', () => {
    expect(resolveDevServerPort('/proj', {}, fakeFs({}))).toBeNull();
  });

  it('never executes/imports the scanned files — only regexes their raw text', () => {
    // A file that would throw if imported/required must not crash resolution.
    const deps = fakeFs({ '/proj/vite.config.ts': 'throw new Error("do not import me"); export default { port: 3000 }' });
    expect(() => resolveDevServerPort('/proj', {}, deps)).not.toThrow();
    expect(resolveDevServerPort('/proj', {}, deps)).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && npx vitest run test/webpane/port-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// daemon/src/lib/webpane/port-resolver.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevportsConfig } from './devports-config.js';

function defaultReadFileIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Tier 1 (spec §3): a PORT= line in the folder's own .env. Text scan only — never imported/executed. */
function fromDotenv(cwd: string, readFileIfExists: (p: string) => string | null): number | null {
  const text = readFileIfExists(join(cwd, '.env'));
  if (!text) return null;
  const m = /^PORT=(\d+)$/m.exec(text);
  return m?.[1] ? Number(m[1]) : null;
}

/** Tier 2 (spec §3): microviber/devports.json, keyed by full absolute path. */
function fromDevportsConfig(cwd: string, devports: DevportsConfig): number | null {
  return devports[cwd]?.port ?? null;
}

/**
 * Tier 3 (spec §3): a non-executing regex/text scan of common dev-server
 * config files. Lowest confidence — only consulted when tiers 1-2 resolve
 * nothing. Deliberately never imports/requires any of these files (a
 * malicious or broken config file must not crash resolution, let alone
 * execute) — text pattern matching only.
 */
function fromStaticConfigScan(cwd: string, readFileIfExists: (p: string) => string | null): number | null {
  const candidates = ['vite.config.ts', 'vite.config.js', 'angular.json', 'webpack.config.js', 'webpack.config.cjs'];
  for (const file of candidates) {
    const text = readFileIfExists(join(cwd, file));
    if (!text) continue;
    const m = /port\s*:\s*(\d+)/.exec(text);
    if (m?.[1]) return Number(m[1]);
  }
  const pkgText = readFileIfExists(join(cwd, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      for (const script of Object.values(pkg.scripts ?? {})) {
        const m = /--port[= ](\d+)/.exec(script);
        if (m?.[1]) return Number(m[1]);
      }
    } catch {
      // Malformed package.json: not this resolver's problem to report — just no match.
    }
  }
  return null;
}

export function resolveDevServerPort(
  cwd: string,
  devports: DevportsConfig,
  deps: { readFileIfExists?: (p: string) => string | null } = {},
): number | null {
  const readFileIfExists = deps.readFileIfExists ?? defaultReadFileIfExists;
  return (
    fromDotenv(cwd, readFileIfExists) ??
    fromDevportsConfig(cwd, devports) ??
    fromStaticConfigScan(cwd, readFileIfExists)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && npx vitest run test/webpane/port-resolver.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/lib/webpane/port-resolver.ts daemon/test/webpane/port-resolver.test.ts
git commit -m "feat(webpane): add 3-tier dev-server port resolver (spec §3)"
```

---

## Task 3: Wire `devServerPort` into `SessionSummary` + fix `takenOver` PWA drift

**Files:**
- Modify: `daemon/src/domain/registry.ts`
- Modify: `daemon/src/services/services.ts`
- Modify: `pwa/src/lib/types.ts`
- Test: modify `daemon/test/registry.test.ts`

**Interfaces:**
- Consumes: `resolveDevServerPort` (Task 2, `daemon/src/lib/webpane/port-resolver.js`), `loadDevportsConfig` (Task 1, `daemon/src/lib/webpane/devports-config.js`).
- Produces: `SessionSummary.devServerPort: number | null` (daemon and PWA types now match). Also fixes a pre-existing drift: PWA's `SessionSummary` was missing `takenOver: boolean`, which the daemon's already has.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/registry.test.ts` (find the existing `buildSummary` describe block and add — use whatever `DiscoveredLike` fixture name the existing tests in this file already use in place of `baseDiscovered` below):

```ts
it('includes devServerPort from ctx (spec §3 — resolved once per listSessions call, not per-session logic)', () => {
  const d = { ...baseDiscovered, cwd: '/proj' };
  const summary = buildSummary(d, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: 1000, devServerPort: 9005 });
  expect(summary.devServerPort).toBe(9005);
});

it('devServerPort is null when nothing resolves', () => {
  const d = { ...baseDiscovered, cwd: '/proj' };
  const summary = buildSummary(d, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: 1000, devServerPort: null });
  expect(summary.devServerPort).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && npx vitest run test/registry.test.ts`
Expected: FAIL — `ctx.devServerPort` not accepted by the type / `summary.devServerPort` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `daemon/src/domain/registry.ts`, add the field to the `SessionSummary` interface:

```ts
export interface SessionSummary {
  id: string;
  title: string;
  folder: string;
  cwd: string;
  host: Host;
  writable: boolean;
  state: SessionState;
  lastActivityAt: string | null;
  lastPrompt: string | null;
  lastPromptAt: string | null;
  mode: SessionMode;
  takenOver: boolean;
  /** Resolved dev-server port for this folder, or null if none resolves (spec §3). */
  devServerPort: number | null;
}
```

Thread it through `buildSummary`:

```ts
export function buildSummary(
  d: DiscoveredLike,
  ctx: { isOwned: boolean; notifyIdleAt: string | null; alive: boolean; nowMs: number; devServerPort: number | null },
): SessionSummary {
  return {
    id: d.id,
    title: d.title,
    folder: d.folder,
    cwd: d.cwd,
    host: d.host,
    writable: gateWritability(d.peerProtocol).writable,
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      turnOpen: d.turnOpen,
      nowMs: ctx.nowMs,
    }),
    lastActivityAt: d.lastActivityAt,
    lastPrompt: d.lastPrompt,
    lastPromptAt: d.lastPromptAt,
    mode: ctx.isOwned ? 'owned' : 'readonly',
    takenOver: ctx.isOwned,
    devServerPort: ctx.devServerPort,
  };
}
```

In `daemon/src/services/services.ts`, load `devports.json` once at `createServices` time and resolve per-folder inside `listSessions`:

```ts
// New imports at the top:
import { loadDevportsConfig } from '../lib/webpane/devports-config.js';
import { resolveDevServerPort } from '../lib/webpane/port-resolver.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inside createServices(config, auditSink), before `function listSessions()`:
const here = dirname(fileURLToPath(import.meta.url));
const devportsPath = join(here, '..', '..', '..', 'devports.json'); // microviber/ repo root
const devports = loadDevportsConfig(devportsPath);
```

Then inside `listSessions`'s `.map`:

```ts
const out = discovered.map((d) => {
  cwdById.set(d.id, d.cwd);
  return buildSummary(d, {
    isOwned: registry.isOwned(d.id),
    notifyIdleAt: null,
    alive: true,
    nowMs: now,
    devServerPort: resolveDevServerPort(d.cwd, devports),
  });
});
```

In `pwa/src/lib/types.ts`, fix the pre-existing drift and add the new field:

```ts
export interface SessionSummary {
  id: string; title: string; folder: string; cwd: string;
  host: Host; writable: boolean; state: SessionState;
  lastActivityAt: string | null; lastPrompt: string | null; lastPromptAt: string | null; mode: SessionMode;
  /** Was missing here despite existing on the daemon's SessionSummary since Track A — fixed alongside this feature. */
  takenOver: boolean;
  /** Resolved dev-server port for this session's folder, or null (spec §3). */
  devServerPort: number | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && npx vitest run test/registry.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 5: Full typecheck (both workspaces), lint, full test suite, and commit**

```bash
cd microviber && npm run typecheck && npm run lint && npm test
git add daemon/src/domain/registry.ts daemon/src/services/services.ts daemon/test/registry.test.ts pwa/src/lib/types.ts
git commit -m "feat(webpane): wire devServerPort into SessionSummary; fix pwa takenOver drift"
```

---

## Self-Review Notes

- **Spec coverage:** AC1 → Task 1. AC2, AC3 → Task 2 (AC3 covered by the "never executes/imports" test). AC4 → Task 3 (`buildSummary` + `services.ts` wiring). AC5 → Task 3 (`pwa/src/lib/types.ts` edit, both `devServerPort` and the pre-existing `takenOver` drift).
- **Placeholder scan:** none — every step has real test/implementation code and exact commands, carried over verbatim from `docs/features/microviber-track-b/plan.md` Tasks 1-3.
- **Type consistency:** `DevportsConfig`/`DevportsEntry` (Task 1) are consumed unchanged by `resolveDevServerPort` (Task 2) and by `services.ts` (Task 3). `resolveDevServerPort`'s return type (`number | null`) matches `SessionSummary.devServerPort` and `buildSummary`'s `ctx.devServerPort` exactly across all three tasks.
- **Out of scope (deferred to later stories in this feature):** Tasks 4+ of `plan.md` (webpane auth/token store, dev-server proxy route, local-file route, PWA `WebPane.tsx` UI, etc.) are not part of this story and are intentionally excluded here.
