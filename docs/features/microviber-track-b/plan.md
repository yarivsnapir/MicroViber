# MicroViber Track B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five Track B feature areas from `docs/features/microviber-track-b/spec.md` — PWA installability, an embedded "Web pane" (dev-server proxy + local file viewer), UX/UI polish, transcript link handling, and `AskUserQuestion` support (a genuine Track A bug fix).

**Architecture:** New daemon-side logic lives in a fresh `daemon/src/lib/webpane/` module (mirroring the `lib/claude-adapter/` isolation pattern) exposed to `api/app.ts` through small, focused `AppDeps` additions — the same wiring style already used for every existing route. PWA-side, a new `WebPane.tsx` + `CaretButton.tsx` + `TitleBar.tsx` join the existing component set; `SessionPicker.tsx` is restructured from a bottom sheet into a dropdown panel. Feature 5 modifies four existing Track A daemon modules directly (`session-state.ts`, `ownership.ts`, `transcript-meta.ts`, `notify-policy.ts`) rather than adding new ones.

**Tech Stack:** Node 22 + TypeScript + Fastify 5 + Zod 3 (daemon); Vite + React 19 + Tailwind 4 + react-markdown (PWA); Vitest 4 for both.

## Global Constraints

- Test gate: `npm run typecheck && npm run lint && npm test` (run from `microviber/` root) must pass before every commit — this is the CI gate (architecture-spec.md §6).
- TS strictness per `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. `@typescript-eslint/no-explicit-any` is an eslint error — any `any` needs a `// reason:` comment.
- Adapter quarantine: nothing outside `daemon/src/lib/claude-adapter/` may read `~/.claude/*` paths, touch the messaging socket, or parse a transcript entry's Claude-Code-internal vocabulary directly. New webpane code lives in `daemon/src/lib/webpane/`, which is *not* exempt from FENCE 2's literal-path-string rule but also has no reason to reference `~/.claude` paths at all.
- Layering fence: `schemas/ → domain/ → services/ → api/`, no upward imports. The PWA must never import daemon internals (existing `no-restricted-imports` eslint rule, unaffected).
- Fail closed: an invalid/missing required config crashes at startup with a clear error, never a silent fallback. `microviber/devports.json` is the one *optional* new config surface — see Task 1 for exactly which failure modes crash vs. silently no-op.
- Audit every write attempt, not only successes (architecture-spec.md §6) — Feature 5's answer-submission path reuses the existing `sendPrompt`/audit-log path verbatim, so this is inherited for free, not something to re-implement.
- Relative imports use explicit `.js` extensions throughout the daemon (ESM convention already in force — match it in every new daemon file).
- **Scope decision, made explicit per the spec review's own recommendation:** `domain/notify-policy.ts` currently has zero call sites anywhere in the shipped app (confirmed via workspace-wide grep — its only consumer is its own unit test), and the daemon has **no push-dispatch mechanism of any kind** — no `web-push` dependency, no subscription-storage endpoint, nothing that actually calls the Web Push protocol despite `MV_VAPID_PUBLIC_KEY`/`MV_VAPID_PRIVATE_KEY` existing in `config.ts`. Standing up real push delivery is a separate, large body of work (a `web-push`-based sender, a subscription-registration endpoint, PWA-side `pushManager.subscribe()` wiring) that "AskUserQuestion support" does not imply. **This plan's scope is: extend `NotifyPolicy`'s logic correctly (Task 20) so it is ready the moment a dispatch mechanism exists, but does NOT build that dispatch mechanism.** File the missing push-dispatch subsystem as a separate follow-up story — do not silently expand this plan to cover it.
- Every `git commit` in this plan's steps is a real commit — run it, don't skip it, even though these steps are terse.

---

## File Structure

**New daemon module — `daemon/src/lib/webpane/`** (mirrors `lib/claude-adapter/`'s isolation pattern; nothing here touches `~/.claude/*`):
- `devports-config.ts` — loads/validates `microviber/devports.json`.
- `port-resolver.ts` — the 3-tier port resolution (env scan → devports.json → static config scan).
- `webpane-auth.ts` — the shared token-mint + cookie-validation mechanism (T14) for both content sources.
- `proxy.ts` — reverse-proxies to `http://127.0.0.1:<port>/*` (dev-server content source).
- `local-file.ts` — reads and serves an arbitrary local file with content-type guessing (local-file content source; T16's accepted-risk surface).

**Modified daemon files:**
- `domain/registry.ts` — `SessionSummary` gains `devServerPort: number | null` and `pendingQuestion: PendingQuestion | null`.
- `domain/session-state.ts` — `SessionState` gains `'awaiting-input'`; `deriveState` gets one new structural rule.
- `domain/ownership.ts` — `assertIdleForTakeover` accepts `'awaiting-input'` alongside `'idle'`.
- `domain/notify-policy.ts` — its independent `State` type gains `'awaiting-input'` as a second notify-triggering value.
- `lib/claude-adapter/transcript-meta.ts` — detects a pending/resolved `AskUserQuestion` tool call, adds `pendingQuestion` to `TranscriptMeta`.
- `lib/claude-adapter/schemas.ts` — adds a `ToolResultBlock` schema and an `AskUserQuestionInput` schema.
- `api/app.ts` — three new routes (`POST /api/webpane-token`, `/api/webpane/devserver/:port/*`, `GET /api/webpane/localfile`), one auth-hook carve-out.
- `services/services.ts` — wires the new `lib/webpane/` resolver/auth/proxy/local-file functions into `AppDeps`; wires `transcript-meta`'s `pendingQuestion` into `buildSummary`'s inputs.

**New PWA files:**
- `pwa/src/components/CaretButton.tsx` — the one shared dropdown-trigger button style (rounded-square, SVG chevron, amber-open) used by both the session picker and the Web pane's address bar.
- `pwa/src/components/WebPane.tsx` — address bar + dropdown (Recent + Dev servers) + sandboxed iframe.
- `pwa/src/components/TitleBar.tsx` — icon + wordmark + conditional install button.
- `pwa/src/lib/link-classify.ts` — local-vs-external link classification + relative-path resolution.
- `pwa/src/lib/install-prompt.ts` — captures `beforeinstallprompt`, detects standalone mode.
- Icon art (`pwa/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon.png`) — human deliverable per spec §2, already provided (delivered 2026-08-28, flat in `pwa/public/`, not under an `icons/` subdirectory); Task 12 only wires these into the manifest and `index.html`.

**Modified PWA files:**
- `pwa/src/lib/types.ts` — `SessionSummary` gains `devServerPort`, `takenOver` (currently missing — a pre-existing drift from the daemon's own type, fixed in Task 3), and `pendingQuestion`; `SessionState` gains `'awaiting-input'`; `TranscriptEvent` gains an `askUserQuestion` kind.
- `pwa/src/lib/api.ts` — adds `mintWebpaneToken`, keeps everything else unchanged.
- `pwa/src/components/SessionPicker.tsx` — rewritten from a bottom sheet into a `CaretButton`-triggered dropdown panel with Recent/Browse-by-folder/drill-down states.
- `pwa/src/components/Composer.tsx` — action-row alignment fix; `awaiting-input` status-bar mapping.
- `pwa/src/components/Transcript.tsx` — routes markdown link taps through `link-classify.ts`; renders `askUserQuestion` events expanded.
- `pwa/src/components/states.tsx` — `PaneSwitch`'s "Web · coming soon" placeholder is removed once `WebPane.tsx` lands (Task 10).
- `pwa/src/App.tsx` — wires `TitleBar`, `WebPane`, the new dropdown `SessionPicker`, and `awaiting-input` composer/answer-submission logic.
- `pwa/index.html` — apple-touch-icon and favicon `<link>` tags.
- `pwa/public/manifest.webmanifest` — full manifest replacing the `icons: []` stub.

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

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/devports-config.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/webpane/devports-config.js'`

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/devports-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `cd daemon && npm run typecheck`
```bash
git add daemon/src/lib/webpane/devports-config.ts daemon/test/webpane/devports-config.test.ts
git commit -m "feat(webpane): add devports.json loader (spec §3 tier 2)"
```

---

## Task 2: Port resolver — 3-tier resolution

**Files:**
- Create: `daemon/src/lib/webpane/port-resolver.ts`
- Test: `daemon/test/webpane/port-resolver.test.ts`

**Interfaces:**
- Consumes: `DevportsConfig` from Task 1.
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

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/port-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify pass**

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
- Modify: `daemon/src/domain/registry.ts`, `daemon/src/services/services.ts`
- Modify: `pwa/src/lib/types.ts`
- Test: modify `daemon/test/registry.test.ts`

**Interfaces:**
- Consumes: `resolveDevServerPort` (Task 2), `loadDevportsConfig` (Task 1).
- Produces: `SessionSummary.devServerPort: number | null` (daemon and PWA types now match). Also fixes a pre-existing drift: PWA's `SessionSummary` was missing `takenOver: boolean`, which the daemon's already has.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/registry.test.ts` (find the existing `buildSummary` describe block and add):

```ts
it('includes devServerPort from ctx (spec §3 — resolved once per listSessions call, not per-session logic)', () => {
  const d = { ...baseDiscovered, cwd: '/proj' }; // baseDiscovered is the existing fixture in this file
  const summary = buildSummary(d, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: 1000, devServerPort: 9005 });
  expect(summary.devServerPort).toBe(9005);
});

it('devServerPort is null when nothing resolves', () => {
  const d = { ...baseDiscovered, cwd: '/proj' };
  const summary = buildSummary(d, { isOwned: false, notifyIdleAt: null, alive: true, nowMs: 1000, devServerPort: null });
  expect(summary.devServerPort).toBeNull();
});
```

(If `baseDiscovered` isn't the exact fixture name in the existing file, use whatever `DiscoveredLike` fixture object the existing tests already construct — match the file's own naming.)

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/registry.test.ts`
Expected: FAIL — `ctx.devServerPort` not accepted by the type / `summary.devServerPort` is `undefined`

- [ ] **Step 3: Implement**

In `daemon/src/domain/registry.ts`, add the field to the interface and thread it through `buildSummary`:

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

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/registry.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 5: Full typecheck (both workspaces) and commit**

```bash
cd microviber && npm run typecheck
git add daemon/src/domain/registry.ts daemon/src/services/services.ts daemon/test/registry.test.ts pwa/src/lib/types.ts
git commit -m "feat(webpane): wire devServerPort into SessionSummary; fix pwa takenOver drift"
```

---

## Task 4: Web pane shared auth — token mint + cookie validation (T14)

**Files:**
- Create: `daemon/src/lib/webpane/webpane-auth.ts`
- Test: `daemon/test/webpane/webpane-auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WebpaneResource = { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string };
  export class WebpaneTokenStore {
    mint(resource: WebpaneResource, nowMs: number): string; // returns opaque cookie value
    check(cookieValue: string | undefined, resource: WebpaneResource, nowMs: number): boolean;
  }
  export function parseCookieHeader(header: string | undefined, name: string): string | undefined;
  export function resourceKey(r: WebpaneResource): string;
  ```

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

describe('WebpaneTokenStore (spec §3 "Iframe auth" / T14)', () => {
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
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// daemon/src/lib/webpane/webpane-auth.ts
import { randomBytes } from 'node:crypto';

export type WebpaneResource = { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string };

const TOKEN_TTL_MS = 5 * 60_000; // 5 minutes — spec §3 "Iframe auth" Max-Age=300

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
 * In-memory only (daemon restart clears it, same pattern as OwnershipRegistry
 * — spec §3 "Iframe auth"). Each token is bound to exactly one resource (a
 * port, or a path) at mint time; `check` validates both identity and TTL.
 * T14: this is the mechanism behind the mv_webpane cookie's narrow scope.
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
git commit -m "feat(webpane): add shared token-mint/cookie-check store (spec T14)"
```

---

## Task 5: Register `POST /api/webpane-token` + the auth-hook cookie carve-out

**Files:**
- Modify: `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: modify `daemon/test/app.test.ts`

**Interfaces:**
- Consumes: `WebpaneTokenStore`, `WebpaneResource`, `parseCookieHeader` (Task 4).
- Produces: `AppDeps` gains `mintWebpaneToken(resource: WebpaneResource): { cookieValue: string; maxAgeSeconds: number }` and `checkWebpaneCookie(cookieValue: string | undefined, resource: WebpaneResource): boolean`. Later tasks (6, 7) consume these two methods — do not rename them.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/app.test.ts` (using the file's existing `deps()`/`buildApp(...).inject(...)` pattern — extend the fake `deps()` factory with the two new methods, matching how every other `AppDeps` method is already faked there):

```ts
describe('POST /api/webpane-token', () => {
  it('requires bearer auth like every other route', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });

  it('mints a resource-scoped cookie on success', async () => {
    const app = buildApp(deps({ mintWebpaneToken: () => ({ cookieValue: 'tok123', maxAgeSeconds: 300 }) }));
    const res = await app.inject({
      method: 'POST', url: '/api/webpane-token',
      headers: { authorization: 'Bearer test-token' },
      payload: { kind: 'devserver', port: 9005 },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    expect(String(setCookie)).toMatch(/mv_webpane=tok123/);
    expect(String(setCookie)).toMatch(/Path=\/api\/webpane\//);
    expect(String(setCookie)).toMatch(/HttpOnly/);
    expect(String(setCookie)).toMatch(/SameSite=Strict/);
    expect(String(setCookie)).toMatch(/Max-Age=300/);
  });

  it('rejects an invalid body', async () => {
    const app = buildApp(deps());
    const res = await app.inject({
      method: 'POST', url: '/api/webpane-token',
      headers: { authorization: 'Bearer test-token' },
      payload: { kind: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('bearer-auth hook cookie carve-out for /api/webpane/*', () => {
  it('accepts a valid webpane cookie in place of the Authorization header, ONLY on /api/webpane/* routes', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx', headers: { cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).not.toBe(401);
  });

  it('does NOT accept the webpane cookie on any other /api/* route', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: 'mv_webpane=tok123' } });
    expect(res.statusCode).toBe(401);
  });

  it('the mint endpoint itself never accepts the cookie as a header substitute', async () => {
    const app = buildApp(deps({ checkWebpaneCookie: () => true }));
    const res = await app.inject({ method: 'POST', url: '/api/webpane-token', headers: { cookie: 'mv_webpane=tok123' }, payload: { kind: 'devserver', port: 9005 } });
    expect(res.statusCode).toBe(401);
  });
});
```

(Match whatever the existing `deps()` factory's exact override style is in this file — it already supports partial overrides for other `AppDeps` methods; extend it the same way for `mintWebpaneToken`/`checkWebpaneCookie` rather than introducing a second pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: FAIL — route not found (404) instead of the expected statuses, and `deps()` missing the two new methods

- [ ] **Step 3: Implement**

In `daemon/src/api/app.ts`, extend `AppDeps`:

```ts
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';

export interface AppDeps {
  // ...existing fields...
  mintWebpaneToken(resource: WebpaneResource): { cookieValue: string; maxAgeSeconds: number };
  checkWebpaneCookie(cookieValue: string | undefined, resource: WebpaneResource): boolean;
}
```

Add a zod body schema (co-locate with the other schemas in `daemon/src/schemas/api.ts`):

```ts
// Add to daemon/src/schemas/api.ts
export const WebpaneTokenBody = z.union([
  z.object({ kind: z.literal('devserver'), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal('localfile'), path: z.string().min(1) }),
]);
```

In `app.ts`, adjust the bearer-auth hook to carve out the cookie fallback (find the existing hook — replace its body with this extended version):

```ts
import { parseCookieHeader } from '../lib/webpane/webpane-auth.js';

// Bearer auth protects DATA routes only (/api/* except health, and /ws).
app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0] ?? req.url;
  const isData = url.startsWith('/api/') || url.startsWith('/ws');
  if (!isData) return;
  if (url === '/api/health') return;
  if (checkBearer(req.headers.authorization, config.bearerToken)) return;

  // Narrow carve-out (spec §3 "Iframe auth" / T14): an <iframe src> can't
  // attach a header, so /api/webpane/devserver/* and /api/webpane/localfile
  // ALSO accept the scoped mv_webpane cookie — every other route, INCLUDING
  // the token-mint endpoint itself, still requires the real header.
  const isWebpaneContent = url.startsWith('/api/webpane/devserver/') || url.startsWith('/api/webpane/localfile');
  if (isWebpaneContent) {
    const cookieValue = parseCookieHeader(req.headers.cookie, 'mv_webpane');
    const resource = resourceFromUrl(url); // implemented in Task 6/7 — for now, always undefined
    if (resource && deps.checkWebpaneCookie(cookieValue, resource)) return;
  }

  return reply.code(401).send(errorEnvelope('UNAUTHENTICATED', 'missing or invalid bearer token'));
});
```

Note: `resourceFromUrl` is intentionally deferred — Task 6 (dev-server proxy) and Task 7 (local file) each define how to parse their own URL shape into a `WebpaneResource`. For this task, stub it minimally so the file compiles and the "does NOT accept on any other route" test passes (the two webpane-content tests above that need it to actually work are written now but will only fully pass once Tasks 6/7 land — mark them `.todo` is NOT an option per "no placeholders", so instead implement a minimal version now that Task 6/7 will extend, not replace):

```ts
// In app.ts, near the hook:
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

This makes `resourceFromUrl` fully correct for both content routes right away (Tasks 6/7 register the routes themselves but don't need to touch this function again).

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

In `daemon/src/services/services.ts`, wire real implementations:

```ts
import { WebpaneTokenStore } from '../lib/webpane/webpane-auth.js';
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';

// Inside createServices(...), alongside `const registry = new OwnershipRegistry();`:
const webpaneTokens = new WebpaneTokenStore();

// Add to the returned AppDeps object:
mintWebpaneToken(resource: WebpaneResource) {
  return { cookieValue: webpaneTokens.mint(resource, Date.now()), maxAgeSeconds: 300 };
},
checkWebpaneCookie(cookieValue, resource) {
  return webpaneTokens.check(cookieValue, resource, Date.now());
},
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/app.test.ts`
Expected: PASS (all existing tests plus the 6 new ones)

- [ ] **Step 5: Full typecheck and commit**

```bash
cd microviber && npm run typecheck
git add daemon/src/api/app.ts daemon/src/services/services.ts daemon/src/schemas/api.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add POST /api/webpane-token + cookie auth carve-out (spec T14)"
```

---

## Task 6: Dev-server proxy route (`/api/webpane/devserver/:port/*`, T13)

**Files:**
- Create: `daemon/src/lib/webpane/proxy.ts`
- Modify: `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: `daemon/test/webpane/proxy.test.ts`, extend `daemon/test/app.test.ts`

**Interfaces:**
- Consumes: native `fetch` (Node 22).
- Produces: `export async function proxyToLoopback(port: number, path: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>`. `AppDeps` gains `listResolvedDevServerPorts(): number[]` and `proxyDevServer` (same signature as `proxyToLoopback`, minus the port-allowlist check which the route itself performs).

- [ ] **Step 1: Write the failing tests**

```ts
// daemon/test/webpane/proxy.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { proxyToLoopback } from '../../src/lib/webpane/proxy.js';

describe('proxyToLoopback (spec §3 — target host hardcoded to loopback, only port varies)', () => {
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

- [ ] **Step 3: Implement**

```ts
// daemon/src/lib/webpane/proxy.ts

/**
 * Reverse-proxies to a resolved local dev-server port. The target host is
 * hardcoded to loopback — only the port varies, never proxying to a
 * non-loopback host (spec §3, T13). The port-allowlist check itself lives in
 * the route handler (app.ts), not here — this function trusts its caller.
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

In `daemon/src/api/app.ts`, extend `AppDeps`:

```ts
export interface AppDeps {
  // ...existing...
  listResolvedDevServerPorts(): number[];
  proxyDevServer(port: number, path: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}
```

Register the route (a Fastify wildcard, all methods — use `app.all` on a wildcard pattern):

```ts
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
    if (typeof v === 'string' && !['host', 'authorization', 'cookie'].includes(k)) headers[k] = v;
  }
  try {
    const upstream = await deps.proxyDevServer(port, forwardPath, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? (req.body as Uint8Array | undefined) : undefined,
    });
    for (const [k, v] of Object.entries(upstream.headers)) reply.header(k, v);
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

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/proxy.test.ts test/app.test.ts`
Expected: PASS

- [ ] **Step 5: Add an app.ts-level 403 test, typecheck, commit**

Add to `daemon/test/app.test.ts`:

```ts
describe('GET /api/webpane/devserver/:port/*', () => {
  it('403s a port not in the resolved allowlist (T13)', async () => {
    const app = buildApp(deps({ listResolvedDevServerPorts: () => [9005] }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9999/', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(403);
  });

  it('proxies an allowed port, preserving the sub-path', async () => {
    const app = buildApp(deps({
      listResolvedDevServerPorts: () => [9005],
      proxyDevServer: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<html></html>') }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/devserver/9005/scenarios/42', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(200);
  });
});
```

```bash
cd daemon && npx vitest run test/app.test.ts && cd .. && npm run typecheck
git add daemon/src/lib/webpane/proxy.ts daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/webpane/proxy.test.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add dev-server reverse-proxy route with port allowlist (spec T13)"
```

---

## Task 7: Local file route (`/api/webpane/localfile`, T15/T16)

**Files:**
- Create: `daemon/src/lib/webpane/local-file.ts`
- Modify: `daemon/src/api/app.ts`, `daemon/src/services/services.ts`
- Test: `daemon/test/webpane/local-file.test.ts`, extend `daemon/test/app.test.ts`

**Interfaces:**
- Produces: `export function readLocalFile(path: string, deps?: { readFileIfExists?: (p: string) => Buffer | null }): { bytes: Buffer; contentType: string } | null`. `AppDeps` gains `readLocalFile` (same signature).

- [ ] **Step 1: Write the failing tests**

```ts
// daemon/test/webpane/local-file.test.ts
import { describe, it, expect } from 'vitest';
import { readLocalFile } from '../../src/lib/webpane/local-file.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => (files[p] !== undefined ? Buffer.from(files[p]) : null) };
}

describe('readLocalFile (spec §3 — no folder restriction, T16 accepted risk)', () => {
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
  it('falls back to application/octet-stream for an unrecognized extension', () => {
    const r = readLocalFile('/x/data.bin', fakeFs({ '/x/data.bin': 'binary' }));
    expect(r?.contentType).toBe('application/octet-stream');
  });
  it('returns null when the file does not exist or is unreadable — no folder restriction, but a real read attempt', () => {
    expect(readLocalFile('/anywhere/at/all.txt', fakeFs({}))).toBeNull();
  });
  it('does not restrict which absolute paths are attempted (explicit spec deviation, T16)', () => {
    // Any path is *attempted* — the accepted risk is that there's no allowlist,
    // not that this function should add one back in.
    const r = readLocalFile('/etc/hosts', fakeFs({ '/etc/hosts': '127.0.0.1 localhost' }));
    expect(r?.bytes.toString()).toBe('127.0.0.1 localhost');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/webpane/local-file.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// daemon/src/lib/webpane/local-file.ts
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * No folder restriction — any path the daemon process can read is servable
 * (spec §3 "Local file viewing", explicit deviation recorded in spec §9,
 * accepted risk T16, contained by iframe sandboxing T15). This function only
 * reads bytes; it never executes, interprets, or evaluates file content.
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

In `daemon/src/api/app.ts`, extend `AppDeps`:

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

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/webpane/local-file.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Add app.ts route tests, typecheck, commit**

Add to `daemon/test/app.test.ts`:

```ts
describe('GET /api/webpane/localfile', () => {
  it('404s when the file cannot be read', async () => {
    const app = buildApp(deps({ readLocalFile: () => null }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fmissing', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(404);
  });

  it('serves the file with its guessed content-type', async () => {
    const app = buildApp(deps({ readLocalFile: () => ({ bytes: Buffer.from('<h1>hi</h1>'), contentType: 'text/html' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile?path=%2Fx.html', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
  });

  it('400s when path is missing', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/webpane/localfile', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(400);
  });
});
```

```bash
cd daemon && npx vitest run test/app.test.ts && cd .. && npm run typecheck
git add daemon/src/lib/webpane/local-file.ts daemon/src/api/app.ts daemon/src/services/services.ts daemon/test/webpane/local-file.test.ts daemon/test/app.test.ts
git commit -m "feat(webpane): add local file route, no folder restriction (spec T16 accepted risk)"
```

---

## Task 8: Shared `CaretButton` PWA component

**Files:**
- Create: `pwa/src/components/CaretButton.tsx`
- Test: `pwa/test/caret-button.test.tsx`

**Interfaces:**
- Produces: `export function CaretButton({ open, onClick }: { open: boolean; onClick: () => void }): ReactElement` — consumed by Task 10 (`WebPane`) and Task 14 (`SessionPicker`). Do not change this signature later; both consumers depend on it exactly as defined here.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// pwa/test/caret-button.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CaretButton } from '../src/components/CaretButton.js';

afterEach(cleanup);

describe('CaretButton (spec §4/§3 — one shared dropdown-trigger style)', () => {
  it('calls onClick when tapped', () => {
    const onClick = vi.fn();
    render(<CaretButton open={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('reflects open state visually via a distinct class/attribute', () => {
    const { rerender } = render(<CaretButton open={false} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.className).not.toMatch(/bg-amber-400/);
    rerender(<CaretButton open onClick={() => {}} />);
    expect(screen.getByRole('button').className).toMatch(/bg-amber-400/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/caret-button.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```tsx
// pwa/src/components/CaretButton.tsx
import type { ReactElement } from 'react';

/**
 * The one dropdown-trigger button style used identically by the session
 * picker header and the Web pane's address bar (spec §4/§3) — rounded
 * square, SVG chevron, amber when open. Keep this the single source of that
 * visual language; do not fork it per-caller.
 */
export function CaretButton({ open, onClick }: { open: boolean; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border transition-colors ${
        open ? 'border-amber-400 bg-amber-400 text-amber-950' : 'border-zinc-700 bg-zinc-800 text-zinc-200'
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
      </svg>
    </button>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/caret-button.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/components/CaretButton.tsx pwa/test/caret-button.test.tsx
git commit -m "feat(ui): add shared CaretButton component (spec §4)"
```

---

## Task 9: `link-classify.ts` — local vs external link classification

**Files:**
- Create: `pwa/src/lib/link-classify.ts`
- Test: `pwa/test/link-classify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ClassifiedLink =
    | { kind: 'external'; href: string }
    | { kind: 'devserver'; port: number; path: string }
    | { kind: 'localfile'; path: string };
  export function classifyLink(href: string, sessionCwd: string): ClassifiedLink;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// pwa/test/link-classify.test.ts
import { describe, it, expect } from 'vitest';
import { classifyLink } from '../src/lib/link-classify.js';

describe('classifyLink (spec §5)', () => {
  it('classifies an http://localhost:<port> link as devserver, preserving the path', () => {
    expect(classifyLink('http://localhost:9005/scenarios/42', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/scenarios/42' });
  });
  it('classifies https://localhost too — scheme does not matter', () => {
    expect(classifyLink('https://localhost:9005/', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/' });
  });
  it('classifies 127.0.0.1 the same as localhost', () => {
    expect(classifyLink('http://127.0.0.1:9008/health', '/proj')).toEqual({ kind: 'devserver', port: 9008, path: '/health' });
  });
  it('classifies a file:// URI as localfile, used as-is', () => {
    expect(classifyLink('file:///Users/you/spec.md', '/proj')).toEqual({ kind: 'localfile', path: '/Users/you/spec.md' });
  });
  it('classifies an absolute bare path as localfile, used as-is', () => {
    expect(classifyLink('/Users/you/mockup.html', '/proj')).toEqual({ kind: 'localfile', path: '/Users/you/mockup.html' });
  });
  it('classifies a relative bare path as localfile, resolved against sessionCwd', () => {
    expect(classifyLink('docs/spec.md', '/proj')).toEqual({ kind: 'localfile', path: '/proj/docs/spec.md' });
  });
  it('classifies a real external URL as external', () => {
    expect(classifyLink('https://github.com/yarivsnapir/MicroViber/pull/1', '/proj')).toEqual({ kind: 'external', href: 'https://github.com/yarivsnapir/MicroViber/pull/1' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/link-classify.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// pwa/src/lib/link-classify.ts

export type ClassifiedLink =
  | { kind: 'external'; href: string }
  | { kind: 'devserver'; port: number; path: string }
  | { kind: 'localfile'; path: string };

/**
 * Spec §5: local (file:// / bare path / localhost|127.0.0.1 of any scheme)
 * vs external (any other http(s) URL). A relative bare path resolves
 * against the originating session's cwd before being sent anywhere.
 */
export function classifyLink(href: string, sessionCwd: string): ClassifiedLink {
  if (href.startsWith('file://')) {
    return { kind: 'localfile', path: href.slice('file://'.length) };
  }

  const httpMatch = /^https?:\/\/(localhost|127\.0\.0\.1)(:(\d+))?(\/.*)?$/.exec(href);
  if (httpMatch) {
    const port = httpMatch[3] ? Number(httpMatch[3]) : 80;
    const path = httpMatch[4] ?? '/';
    return { kind: 'devserver', port, path };
  }

  if (/^https?:\/\//.test(href)) {
    return { kind: 'external', href };
  }

  // Bare filesystem path: absolute (leading '/') used as-is, relative resolved against sessionCwd.
  if (href.startsWith('/')) return { kind: 'localfile', path: href };
  return { kind: 'localfile', path: `${sessionCwd.replace(/\/$/, '')}/${href}` };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/link-classify.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/lib/link-classify.ts pwa/test/link-classify.test.ts
git commit -m "feat(ui): add local-vs-external link classification (spec §5)"
```

---

## Task 10: `WebPane.tsx` — address bar, dropdown, sandboxed iframe

**Files:**
- Create: `pwa/src/components/WebPane.tsx`
- Modify: `pwa/src/lib/api.ts`, `pwa/src/App.tsx`, `pwa/src/components/states.tsx` (remove the "coming soon" `PaneSwitch` placeholder)
- Test: `pwa/test/webpane.test.tsx`

**Interfaces:**
- Consumes: `CaretButton` (Task 8), `WebpaneResource`-shaped navigation targets from `link-classify.ts` (Task 9) or the dropdown's own list.
- Produces: `export function WebPane({ api, sessions, activeSessionCwd }: { api: Api; sessions: SessionSummary[]; activeSessionCwd: string }): ReactElement`. Also exports `export function navigateWebPane(target: { kind: 'devserver'; port: number; path: string } | { kind: 'localfile'; path: string }): void` via a small module-level event target so `Transcript.tsx` (Task 11) can trigger navigation without prop-drilling through `App.tsx` — see Step 3 for the exact mechanism.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// pwa/test/webpane.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { WebPane } from '../src/components/WebPane.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(cleanup);

const session: SessionSummary = {
  id: 's1', title: 'studio', folder: 'studio', cwd: '/proj/studio', host: 'terminal',
  writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: null,
  mode: 'readonly', takenOver: false, devServerPort: 9005,
};

function fakeApi(overrides: Partial<{ mintWebpaneToken: () => Promise<void> }> = {}) {
  return { mintWebpaneToken: vi.fn().mockResolvedValue(undefined), ...overrides } as never;
}

describe('WebPane (spec §3)', () => {
  it('shows the empty state when no dev server is resolved and nothing selected', () => {
    render(<WebPane api={fakeApi()} sessions={[{ ...session, devServerPort: null }]} activeSessionCwd="/proj/studio" />);
    expect(screen.getByText(/nothing configured|no dev server/i)).toBeInTheDocument();
  });

  it('lists resolved dev servers in the dropdown, deduped by folder', async () => {
    render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button')); // the CaretButton
    await waitFor(() => expect(screen.getByText(/studio/)).toBeInTheDocument());
    expect(screen.getByText(/localhost:9005/)).toBeInTheDocument();
  });

  it('mints a token before navigating to a dev server, then shows an iframe with sandbox and no allow-same-origin', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('src')).toBe('/api/webpane/devserver/9005/');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/webpane.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

First, add `mintWebpaneToken` to `pwa/src/lib/api.ts` (append inside the returned object, after `handback`):

```ts
mintWebpaneToken: async (resource: { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string }): Promise<void> => {
  const r = await fetch(`${baseUrl}/api/webpane-token`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(resource),
    credentials: 'same-origin', // so the Set-Cookie response actually gets stored
  });
  const body = await r.json();
  if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
},
```

Now `WebPane.tsx`:

```tsx
// pwa/src/components/WebPane.tsx
import { useState, useEffect, type ReactElement } from 'react';
import type { Api } from '../lib/api.js';
import type { SessionSummary } from '../lib/types.js';
import { CaretButton } from './CaretButton.js';

type Target = { kind: 'devserver'; port: number; path: string } | { kind: 'localfile'; path: string };
const RECENT_KEY = 'mv_webpane_recent';
const RECENT_MAX = 10;

function loadRecent(): Target[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Target[]; } catch { return []; }
}
function pushRecent(t: Target): void {
  const next = [t, ...loadRecent().filter((r) => JSON.stringify(r) !== JSON.stringify(t))].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable — non-fatal */ }
}

function targetLabel(t: Target): string {
  return t.kind === 'devserver' ? `localhost:${t.port}${t.path}` : t.path;
}
function targetSrc(t: Target): string {
  return t.kind === 'devserver' ? `/api/webpane/devserver/${t.port}${t.path}` : `/api/webpane/localfile?path=${encodeURIComponent(t.path)}`;
}

// Module-level target setter so Transcript.tsx (Task 11) can drive navigation
// without prop-drilling the whole session tree through App.tsx. Exactly one
// WebPane instance is ever mounted (it's a pane, not a list), so a single
// module-level subscriber is sufficient and avoids a context provider for one value.
let externalNavigate: ((t: Target) => void) | null = null;
export function navigateWebPane(target: Target): void {
  externalNavigate?.(target);
}

export function WebPane({ api, sessions, activeSessionCwd }: { api: Api; sessions: SessionSummary[]; activeSessionCwd: string }): ReactElement {
  const [current, setCurrent] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Target[]>(() => loadRecent());

  const devServers = Array.from(
    new Map(sessions.filter((s) => s.devServerPort !== null).map((s) => [s.folder, { folder: s.folder, port: s.devServerPort! }])).values(),
  );

  const go = async (t: Target) => {
    await api.mintWebpaneToken(t.kind === 'devserver' ? { kind: 'devserver', port: t.port } : { kind: 'localfile', path: t.path });
    setCurrent(t);
    pushRecent(t);
    setRecent(loadRecent());
    setOpen(false);
  };

  useEffect(() => {
    externalNavigate = (t) => { void go(t); };
    return () => { externalNavigate = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go closes over stable-enough deps for this pane's lifetime
  }, []);

  if (!current && devServers.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-zinc-400">
        <p className="text-[14px]">No dev server configured for this folder — nothing to browse yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2.5">
        <span className="flex-1 truncate font-mono text-[14px] text-zinc-100">
          {current ? targetLabel(current) : 'select a dev server'}
        </span>
        <CaretButton open={open} onClick={() => setOpen((o) => !o)} />
      </div>
      {open && (
        <div className="absolute inset-x-3 top-[52px] z-10 max-h-[60vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
          {recent.length > 0 && (
            <>
              <div className="px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Recent</div>
              {recent.map((t, i) => (
                <button key={i} onClick={() => void go(t)} className="block w-full truncate px-4 py-2 text-left font-mono text-[13.5px] text-zinc-300">
                  {targetLabel(t)}
                </button>
              ))}
              <div className="mx-4 my-1 h-px bg-zinc-700" />
            </>
          )}
          <div className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Dev servers</div>
          {devServers.map((d) => (
            <button key={d.folder} onClick={() => void go({ kind: 'devserver', port: d.port, path: '/' })} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
              <span className="font-semibold text-zinc-100">{d.folder}</span>
              <span className="font-mono text-[13px] text-amber-400">localhost:{d.port}</span>
            </button>
          ))}
        </div>
      )}
      {current ? (
        // Deliberately no allow-same-origin (spec §3 "Iframe sandboxing" / T15):
        // forces an opaque origin so any script in the proxied/served content
        // cannot reach this app's own localStorage, cookies, or control-plane API.
        <iframe title="web-pane-content" src={targetSrc(current)} sandbox="allow-scripts allow-forms" className="flex-1 border-0 bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-zinc-500">Pick a dev server above</div>
      )}
    </div>
  );
}
```

Wire into `App.tsx`: replace the `<PaneSwitch />` usage and its "Claude"/"Web" tab state. Add a `pane: 'claude' | 'web'` state, render `<WebPane api={api} sessions={sessions} activeSessionCwd={current?.cwd ?? ''} />` when `pane === 'web'`, and update `PaneSwitch` (or inline the two tabs) so tapping "Web" no longer shows "coming soon". In `pwa/src/components/states.tsx`, remove the `<span className="text-[10px] uppercase tracking-wide">coming soon</span>` line and its now-permanently-`text-zinc-600` styling on the Web tab — it becomes a normal, tappable tab like "Claude".

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/webpane.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Full typecheck, run whole PWA suite (App.tsx changed), commit**

```bash
cd pwa && npm run typecheck && npx vitest run
git add pwa/src/components/WebPane.tsx pwa/src/lib/api.ts pwa/src/App.tsx pwa/src/components/states.tsx pwa/test/webpane.test.tsx
git commit -m "feat(ui): add WebPane with sandboxed iframe, wire into pane switch (spec §3, T15)"
```

---

## Task 11: Transcript link tap-routing (Feature 4)

**Files:**
- Modify: `pwa/src/lib/markdown.tsx`, `pwa/src/components/Transcript.tsx`
- Test: extend `pwa/test/markdown-safety.test.tsx` or add `pwa/test/transcript-links.test.tsx`

**Interfaces:**
- Consumes: `classifyLink` (Task 9), `navigateWebPane` (Task 10).
- Produces: `SafeMarkdown` gains an optional `onLocalLink` prop; external links keep plain anchor behavior.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// pwa/test/transcript-links.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SafeMarkdown } from '../src/lib/markdown.js';

afterEach(cleanup);

describe('SafeMarkdown link routing (spec §5)', () => {
  it('external links render as target=_blank anchors, untouched', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[pr](https://github.com/x/y/pull/1)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'pr' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
  });

  it('a local link is intercepted (no default navigation) and routed to the Web pane', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[spec](docs/spec.md)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'spec' });
    expect(a.getAttribute('target')).toBeNull(); // not opened in a new external tab
    const evt = fireEvent.click(a);
    expect(evt).toBe(false); // preventDefault() was called, per @testing-library/react's fireEvent return
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx`
Expected: FAIL — `SafeMarkdown` doesn't accept a `sessionCwd` prop yet / links aren't classified

- [ ] **Step 3: Implement**

```tsx
// pwa/src/lib/markdown.tsx
import Markdown from 'react-markdown';
import type { ReactElement } from 'react';
import { classifyLink } from './link-classify.js';
import { navigateWebPane } from '../components/WebPane.js';

/**
 * Safe transcript markdown. react-markdown renders to a React tree and does
 * NOT use innerHTML; raw HTML in content is inert (we never add rehype-raw),
 * and javascript: URLs are stripped by the default URL transform (T7).
 * Feature 4 (spec §5): links are classified local vs external at render
 * time — local links route into the Web pane instead of navigating away.
 */
export function SafeMarkdown({ children, sessionCwd }: { children: string; sessionCwd: string }): ReactElement {
  return (
    <Markdown
      components={{
        a: ({ href, children: linkChildren }) => {
          const classified = classifyLink(href ?? '', sessionCwd);
          if (classified.kind === 'external') {
            return <a href={classified.href} target="_blank" rel="noopener noreferrer">{linkChildren}</a>;
          }
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                navigateWebPane(classified.kind === 'devserver'
                  ? { kind: 'devserver', port: classified.port, path: classified.path }
                  : { kind: 'localfile', path: classified.path });
              }}
            >
              {linkChildren}
            </a>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}
```

In `pwa/src/components/Transcript.tsx`, thread `sessionCwd` through. `Transcript` currently receives `sessionId`, not `cwd` — add a `sessionCwd: string` prop (the caller in `App.tsx` already has `current?.cwd` available from `SessionSummary`):

```tsx
export function Transcript({ events, sessionId, sessionCwd }: { events: TranscriptEvent[]; sessionId: string | null; sessionCwd: string }): ReactElement {
  // ...unchanged body, except:
  case 'assistant':
    return <Gutter><div className="prose-invert text-[16.5px]"><SafeMarkdown sessionCwd={sessionCwd}>{e.text}</SafeMarkdown></div></Gutter>;
  // ...
}
```

Update the `EventRow` function signature to also receive `sessionCwd` (thread it as a second prop, or close over it via a wrapper — simplest: pass `sessionCwd` into `EventRow`'s props alongside `e`). Update `App.tsx`'s `<Transcript events={events} sessionId={selected} />` call to `<Transcript events={events} sessionId={selected} sessionCwd={current?.cwd ?? ''} />`.

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Run full PWA suite (Transcript.tsx signature changed), typecheck, commit**

```bash
cd pwa && npx vitest run && npm run typecheck
git add pwa/src/lib/markdown.tsx pwa/src/components/Transcript.tsx pwa/src/App.tsx pwa/test/transcript-links.test.tsx
git commit -m "feat(ui): route transcript links to Web pane or external browser (spec §5)"
```

---

## Task 12: Manifest, icons, install-prompt capture

**Files:**
- Modify: `pwa/public/manifest.webmanifest`, `pwa/index.html`
- Create: `pwa/src/lib/install-prompt.ts`
- Test: `pwa/test/install-prompt.test.ts`, `pwa/test/manifest.test.ts`
- **Icon art already delivered** (human deliverable per spec §2, provided 2026-08-28) at `pwa/public/icon-192.png`, `pwa/public/icon-512.png`, `pwa/public/apple-touch-icon.png`, `pwa/public/favicon.png` — flat in `public/`, **not** under an `icons/` subdirectory as originally drafted here. Reference the flat paths below; no `icons/` subfolder or README placeholder is needed.

**Interfaces:**
- Produces: `export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean }` (module-level singleton capturing `beforeinstallprompt`).

- [ ] **Step 1: Write the failing tests**

```ts
// pwa/test/manifest.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('manifest.webmanifest (spec §2)', () => {
  it('has both icon sizes with any+maskable purpose', () => {
    const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
    expect(m.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icon-192.png', sizes: '192x192', purpose: 'any maskable' }),
      expect.objectContaining({ src: '/icon-512.png', sizes: '512x512', purpose: 'any maskable' }),
    ]));
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
  });
});
```

```ts
// @vitest-environment jsdom
// pwa/test/install-prompt.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureInstallPrompt } from '../src/lib/install-prompt.js';

describe('captureInstallPrompt (spec §2)', () => {
  beforeEach(() => { Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true }); });

  it('captures a beforeinstallprompt event and exposes it', () => {
    const { getEvent } = captureInstallPrompt();
    expect(getEvent()).toBeNull();
    const evt = new Event('beforeinstallprompt');
    Object.assign(evt, { preventDefault: vi.fn() });
    window.dispatchEvent(evt);
    expect(getEvent()).toBe(evt);
  });

  it('isStandalone reflects display-mode: standalone', () => {
    const { isStandalone } = captureInstallPrompt();
    expect(isStandalone()).toBe(false);
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    expect(isStandalone()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/manifest.test.ts test/install-prompt.test.ts`
Expected: FAIL — manifest lacks icons, `install-prompt.ts` doesn't exist

- [ ] **Step 3: Implement**

```json
// pwa/public/manifest.webmanifest (full replacement — spec §2)
{
  "name": "MicroViber",
  "short_name": "MicroViber",
  "description": "Mirror and drive your Claude Code sessions from your phone.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#09090b",
  "theme_color": "#09090b",
  "orientation": "portrait",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

Add to `pwa/index.html`'s `<head>` (after the existing `<link rel="manifest">` line):

```html
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="icon" href="/favicon.png" />
```

Icon deliverables are already present at `pwa/public/icon-192.png`, `pwa/public/icon-512.png`, `pwa/public/apple-touch-icon.png`, `pwa/public/favicon.png` — nothing further to place.

Also place at `pwa/public/` (sibling to this directory, not inside it):
- `apple-touch-icon.png` — 180×180, opaque background.
- `favicon.png` — 32×32.

Suggested background: `#09090b` (matches `theme_color`/`background_color`).
```

```ts
// pwa/src/lib/install-prompt.ts

/**
 * Captures beforeinstallprompt once at module load (fires only on
 * Chrome/Android, never iOS Safari — spec §2, no iOS support by design).
 * A module-level singleton mirrors main.tsx's existing top-level
 * service-worker registration pattern — no React context needed for one flag.
 */
let capturedEvent: Event | null = null;
let initialized = false;

export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean } {
  if (!initialized) {
    initialized = true;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      capturedEvent = e;
    });
  }
  return {
    getEvent: () => capturedEvent,
    isStandalone: () => window.matchMedia('(display-mode: standalone)').matches,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/manifest.test.ts test/install-prompt.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/public/manifest.webmanifest pwa/index.html pwa/src/lib/install-prompt.ts pwa/test/manifest.test.ts pwa/test/install-prompt.test.ts
git commit -m "feat(pwa): real manifest + icon links + beforeinstallprompt capture (spec §2)"
```

---

## Task 13: `TitleBar.tsx` — icon, wordmark, install button

**Files:**
- Create: `pwa/src/components/TitleBar.tsx`
- Modify: `pwa/src/App.tsx`
- Test: `pwa/test/title-bar.test.tsx`

**Interfaces:**
- Consumes: `captureInstallPrompt` (Task 12).
- Produces: `export function TitleBar(): ReactElement`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// pwa/test/title-bar.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TitleBar } from '../src/components/TitleBar.js';

afterEach(cleanup);

describe('TitleBar (spec §4)', () => {
  beforeEach(() => { Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true }); });

  it('shows the wordmark always', () => {
    render(<TitleBar />);
    expect(screen.getByText('MICROVIBER')).toBeInTheDocument();
  });

  it('shows no install button before beforeinstallprompt fires', () => {
    render(<TitleBar />);
    expect(screen.queryByText(/install/i)).not.toBeInTheDocument();
  });

  it('shows the install button after beforeinstallprompt fires, and calls .prompt() on tap', () => {
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn() });
    fireEvent(window, evt);
    // Re-render is driven by the component's own listener + state; find the button after the event.
    const btn = screen.getByText(/install/i);
    fireEvent.click(btn);
    expect((evt as unknown as { prompt: () => void }).prompt).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/title-bar.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```tsx
// pwa/src/components/TitleBar.tsx
import { useEffect, useState, type ReactElement } from 'react';
import { captureInstallPrompt } from '../lib/install-prompt.js';

/** Dedicated app-identity bar (spec §4) — icon + wordmark + conditional install button. */
export function TitleBar(): ReactElement {
  const [installEvent, setInstallEvent] = useState<Event | null>(null);

  useEffect(() => {
    const { getEvent, isStandalone } = captureInstallPrompt();
    if (isStandalone()) return;
    const check = () => setInstallEvent(getEvent());
    check();
    const t = setInterval(check, 500); // beforeinstallprompt fires asynchronously post-mount
    return () => clearInterval(t);
  }, []);

  const install = () => {
    (installEvent as unknown as { prompt: () => void } | null)?.prompt();
  };

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3.5 py-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-gradient-to-br from-amber-400 to-amber-700 text-[11px] font-black text-zinc-950">◈</span>
      <span className="flex-1 text-[12.5px] font-bold tracking-wide text-zinc-400">MICROVIBER</span>
      {installEvent && (
        <button onClick={install} className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-bold text-amber-400">
          ⇩ Install
        </button>
      )}
    </div>
  );
}
```

Wire into `App.tsx`'s `Shell` (add `<TitleBar />` as the first child inside `Shell`, before the existing pairing/empty/session-view content — every screen renders inside `Shell`, so this makes it appear everywhere per spec §4):

```tsx
function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="relative mx-auto flex h-dvh max-w-md flex-col bg-zinc-950 text-zinc-100">
      <TitleBar />
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/title-bar.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Run full PWA suite, typecheck, commit**

```bash
cd pwa && npx vitest run && npm run typecheck
git add pwa/src/components/TitleBar.tsx pwa/src/App.tsx pwa/test/title-bar.test.tsx
git commit -m "feat(ui): add TitleBar with install button, wire into Shell (spec §4)"
```

---

## Task 14: `SessionPicker.tsx` → dropdown panel, Recent default view

**Files:**
- Modify: `pwa/src/components/SessionPicker.tsx`, `pwa/src/App.tsx`
- Test: rewrite the session-picker test coverage (find/replace any existing picker-specific tests; if none exist as a standalone file, add `pwa/test/session-picker.test.tsx`)

**Interfaces:**
- Consumes: `CaretButton` (Task 8).
- Produces: `export function SessionPicker({ open, onOpenChange, sessions, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; sessions: SessionSummary[]; onPick: (id: string) => void }): ReactElement` — **signature changes** from the current `{ sessions, onPick, onClose }` (no more always-mounted-when-open bottom sheet; the caret lives in the header now, so `SessionPicker` needs `open`/`onOpenChange` instead of only being conditionally rendered). Task 15 extends this same component with folder-browsing state — do not restructure the top-level props again there.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// pwa/test/session-picker.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionPicker } from '../src/components/SessionPicker.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(cleanup);

function s(over: Partial<SessionSummary>): SessionSummary {
  return { id: 'a', title: 'A', folder: 'studio', cwd: '/proj/studio', host: 'terminal', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-01-01T00:00:02Z', mode: 'readonly', takenOver: false, devServerPort: null, ...over };
}

describe('SessionPicker as a dropdown (spec §4)', () => {
  it('renders nothing when closed', () => {
    render(<SessionPicker open={false} onOpenChange={() => {}} sessions={[s({})]} onPick={() => {}} />);
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('shows the 5 most recent sessions across folders when open (Recent, default view)', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => s({ id: `s${i}`, title: `T${i}`, lastPromptAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
    render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
    expect(screen.getByText('T6')).toBeInTheDocument(); // newest
    expect(screen.queryByText('T0')).not.toBeInTheDocument(); // oldest, beyond the cap of 5
  });

  it('shows the folder name inline per row', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'audio-producer' })]} onPick={() => {}} />);
    expect(screen.getByText(/audio-producer/)).toBeInTheDocument();
  });

  it('calls onPick when a session row is tapped', () => {
    const onPick = vi.fn();
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ id: 'a', title: 'A' })]} onPick={onPick} />);
    fireEvent.click(screen.getByText('A'));
    expect(onPick).toHaveBeenCalledWith('a');
  });

  it('hides the "Browse by folder" link when only one folder exists', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'studio' }), s({ id: 'b', folder: 'studio' })]} onPick={() => {}} />);
    expect(screen.queryByText(/browse by folder/i)).not.toBeInTheDocument();
  });

  it('shows the "Browse by folder" link when multiple folders exist', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'studio' }), s({ id: 'b', folder: 'audio-producer' })]} onPick={() => {}} />);
    expect(screen.getByText(/browse by folder/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/session-picker.test.tsx`
Expected: FAIL — old props shape (`onClose` instead of `open`/`onOpenChange`)

- [ ] **Step 3: Implement**

```tsx
// pwa/src/components/SessionPicker.tsx (full replacement)
import type { ReactElement } from 'react';
import type { SessionSummary } from '../lib/types.js';
import { firstSentence } from '../lib/text.js';

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600', 'awaiting-input': 'bg-fuchsia-400' };
const RECENT_CAP = 5;

/**
 * A top-anchored dropdown panel (spec §4), not a bottom sheet — same
 * expand-directly-below metaphor as the Web pane's address bar dropdown.
 * Default view: Recent (flat, cross-folder, capped, sorted newest-prompt-first
 * — unchanged sort key from the original bottom-sheet picker).
 */
export function SessionPicker({ open, onOpenChange, sessions, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onPick: (id: string) => void;
}): ReactElement | null {
  if (!open) return null;

  const recent = [...sessions].sort((a, b) => (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '')).slice(0, RECENT_CAP);
  const folders = new Set(sessions.map((s) => s.folder));

  return (
    <div className="absolute inset-0 z-10" onClick={() => onOpenChange(false)}>
      <div className="absolute inset-x-3 top-[52px] max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Recent · {recent.length}</span>
          {folders.size > 1 && <span className="text-[12px] font-bold text-amber-400">Browse by folder ›</span>}
        </div>
        {recent.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} className="flex w-full items-start gap-3 border-t border-zinc-800 px-4 py-3 text-left">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-zinc-100">{s.title}</span>
              <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state}</span>
              {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

In `App.tsx`, replace `pickerOpen`/`setPickerOpen` boolean toggling with the new prop shape, and swap the header's plain `⌄` circle span for `<CaretButton open={pickerOpen} onClick={() => setPickerOpen((o) => !o)} />` (import `CaretButton` from Task 8). Update the render call:

```tsx
<SessionPicker
  open={pickerOpen}
  onOpenChange={setPickerOpen}
  sessions={sessions}
  onPick={(id) => { setSelected(id); setEvents([]); setStatus(null); setPendingPrompt(null); setLoadingTranscript(true); setPickerOpen(false); }}
/>
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/session-picker.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Run full PWA suite (App.tsx changed), typecheck, commit**

```bash
cd pwa && npx vitest run && npm run typecheck
git add pwa/src/components/SessionPicker.tsx pwa/src/App.tsx pwa/test/session-picker.test.tsx
git commit -m "feat(ui): SessionPicker becomes a top-anchored dropdown, Recent default view (spec §4)"
```

---

## Task 15: `SessionPicker.tsx` → Browse-by-folder + drill-down

**Files:**
- Modify: `pwa/src/components/SessionPicker.tsx`
- Test: extend `pwa/test/session-picker.test.tsx`

**Interfaces:**
- No prop-shape change from Task 14 — internal state only (`'recent' | 'folders' | { folder: string }`).

- [ ] **Step 1: Write the failing tests**

Add to `pwa/test/session-picker.test.tsx`:

```tsx
it('tapping "Browse by folder" swaps to a folder-grouped list with counts and aggregated state dots', () => {
  const sessions = [
    s({ id: 'a', folder: 'studio', state: 'working' }),
    s({ id: 'b', folder: 'studio', state: 'idle' }),
    s({ id: 'c', folder: 'audio-producer', state: 'idle' }),
  ];
  render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
  fireEvent.click(screen.getByText(/browse by folder/i));
  expect(screen.getByText('studio')).toBeInTheDocument();
  expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
  expect(screen.getByText('audio-producer')).toBeInTheDocument();
  expect(screen.getByText(/1 session\b/)).toBeInTheDocument();
});

it('drilling into a folder shows its sessions with a back row to Projects, then to Recent', () => {
  const sessions = [s({ id: 'a', folder: 'studio', title: 'Studio session' }), s({ id: 'c', folder: 'audio-producer', title: 'AP session' })];
  render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
  fireEvent.click(screen.getByText(/browse by folder/i));
  fireEvent.click(screen.getByText('studio'));
  expect(screen.getByText('Studio session')).toBeInTheDocument();
  expect(screen.queryByText('AP session')).not.toBeInTheDocument();
  expect(screen.getByText(/‹ Projects/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/‹ Projects/));
  expect(screen.getByText('studio')).toBeInTheDocument(); // back at folder list
  fireEvent.click(screen.getByText(/‹ Recent/));
  expect(screen.getByText('Studio session')).toBeInTheDocument(); // back at Recent (only 2 sessions total, both shown)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/session-picker.test.tsx`
Expected: FAIL — "Browse by folder" click does nothing yet

- [ ] **Step 3: Implement**

Replace `SessionPicker`'s body with a small internal view-state machine:

```tsx
// pwa/src/components/SessionPicker.tsx (revise the component body; keep the exported signature from Task 14 unchanged)
import { useState, type ReactElement } from 'react';
// ...existing imports and STATE_DOT/RECENT_CAP...

type View = { kind: 'recent' } | { kind: 'folders' } | { kind: 'folder'; folder: string };

export function SessionPicker({ open, onOpenChange, sessions, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onPick: (id: string) => void;
}): ReactElement | null {
  const [view, setView] = useState<View>({ kind: 'recent' });
  if (!open) return null;

  const recent = [...sessions].sort((a, b) => (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '')).slice(0, RECENT_CAP);
  const folderNames = Array.from(new Set(sessions.map((s) => s.folder)));

  const pick = (id: string) => { onPick(id); setView({ kind: 'recent' }); };

  const Row = ({ s }: { s: SessionSummary }): ReactElement => (
    <button onClick={() => pick(s.id)} className="flex w-full items-start gap-3 border-t border-zinc-800 px-4 py-3 text-left">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-zinc-100">{s.title}</span>
        <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state}</span>
      </span>
    </button>
  );

  let body: ReactElement;
  if (view.kind === 'recent') {
    body = (
      <>
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Recent · {recent.length}</span>
          {folderNames.length > 1 && (
            <button onClick={() => setView({ kind: 'folders' })} className="text-[12px] font-bold text-amber-400">Browse by folder ›</button>
          )}
        </div>
        {recent.map((s) => <Row key={s.id} s={s} />)}
      </>
    );
  } else if (view.kind === 'folders') {
    body = (
      <>
        <button onClick={() => setView({ kind: 'recent' })} className="block w-full border-b border-zinc-800 px-4 py-3 text-left text-[13px] text-zinc-400">‹ Recent</button>
        <div className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Projects · {folderNames.length}</div>
        {folderNames.map((folder) => {
          const inFolder = sessions.filter((s) => s.folder === folder);
          const dot = inFolder.some((s) => s.state === 'working') ? STATE_DOT.working
            : inFolder.some((s) => s.state === 'idle' || s.state === 'awaiting-input') ? STATE_DOT.idle
            : STATE_DOT.stale;
          return (
            <button key={folder} onClick={() => setView({ kind: 'folder', folder })} className="flex w-full items-center gap-3 border-t border-zinc-800 px-4 py-3.5 text-left">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-zinc-100">{folder}</span>
                <span className="block text-[12px] text-zinc-500">{inFolder.length} session{inFolder.length === 1 ? '' : 's'}</span>
              </span>
              <span className="text-zinc-600">›</span>
            </button>
          );
        })}
      </>
    );
  } else {
    const inFolder = sessions.filter((s) => s.folder === view.folder);
    body = (
      <>
        <button onClick={() => setView({ kind: 'folders' })} className="block w-full border-b border-zinc-800 px-4 py-3 text-left text-[13px] text-zinc-400">‹ Projects</button>
        <div className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">{view.folder} · {inFolder.length} session{inFolder.length === 1 ? '' : 's'}</div>
        {inFolder.map((s) => <Row key={s.id} s={s} />)}
      </>
    );
  }

  return (
    <div className="absolute inset-0 z-10" onClick={() => onOpenChange(false)}>
      <div className="absolute inset-x-3 top-[52px] max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/session-picker.test.tsx`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/components/SessionPicker.tsx pwa/test/session-picker.test.tsx
git commit -m "feat(ui): add Browse-by-folder drill-down to SessionPicker dropdown (spec §4)"
```

---

## Task 16: Composer action-row alignment

**Files:**
- Modify: `pwa/src/components/Composer.tsx`
- Test: modify `pwa/test/composer-gate.test.tsx` (or add a focused new test if that file's existing structure doesn't fit a targeted addition — check first)

**Interfaces:** No signature change — visual/DOM-order change only.

- [ ] **Step 1: Write the failing test**

Add a new test (in whichever composer test file fits — matching existing conventions in that file for rendering `<Composer>` directly, `mode: 'owned'`):

```tsx
it('right-aligns actions with Send as the rightmost element, Hand back to its left (spec §4)', () => {
  render(<Composer mode="owned" status={null} onSend={() => {}} onHandback={() => {}} />);
  const actionsRow = screen.getByRole('button', { name: '↑' }).parentElement!;
  expect(actionsRow.className).toMatch(/justify-end/);
  // Hand back is rendered in its own row above the input today; this test
  // asserts the row containing Send also contains Hand back once merged —
  // adjust the query to match whatever single row the implementation below produces.
});
```

(Given the existing `Composer.tsx` renders Hand back in a separate row *above* the textarea, not alongside Send — re-read the file once more at implementation time and write the test against the actual resulting DOM structure from Step 3 below, rather than guessing blind. The core assertion that must hold: whichever row contains the Send button, Hand back is either absent (readonly mode) or immediately to Send's left, and the row is right-aligned.)

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/composer-gate.test.tsx`
Expected: FAIL — current layout has Hand back in a separate `mb-2 flex justify-end` row above the input, not alongside Send

- [ ] **Step 3: Implement**

Restructure `Composer.tsx` to merge Hand back into the same row as Send, right-aligned, Send rightmost:

```tsx
// pwa/src/components/Composer.tsx (revised — merges the two action rows into one)
import { useState, type ReactElement } from 'react';
import { promptDisplay, type PromptState } from '../lib/prompt-display.js';

export function Composer({ mode, status, onSend, onHandback, handingBack }: {
  mode: 'readonly' | 'owned';
  status: PromptState | null;
  onSend: (text: string) => void;
  onHandback: () => void;
  handingBack?: boolean;
}): ReactElement {
  const [text, setText] = useState('');
  const disp = status ? promptDisplay(status) : null;
  const submit = () => { if (text.trim()) { onSend(text.trim()); if (!disp?.keepText) setText(''); } };

  return (
    <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-3">
      <div className={`rounded-xl border bg-zinc-950 px-3 py-2.5 ${disp?.tone === 'error' ? 'border-red-700' : disp?.tone === 'warn' ? 'border-amber-700' : 'border-zinc-700'}`}>
        <textarea
          className="w-full resize-none bg-transparent text-[16.5px] text-zinc-100 outline-none placeholder:text-zinc-500"
          rows={7} style={{ maxHeight: '15rem' }}
          placeholder="Message this session…"
          value={text} onChange={(ev) => setText(ev.target.value)}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {mode === 'readonly' && <span className="mr-auto text-[11.5px] text-zinc-500">sends as message — can’t answer prompts</span>}
          {mode === 'owned' && (
            <button onClick={onHandback} disabled={handingBack} className="rounded-lg border border-zinc-700 px-3 py-1 text-[12.5px] font-semibold text-zinc-400 disabled:opacity-60">
              {handingBack ? 'Handing back…' : 'Hand back'}
            </button>
          )}
          <button onClick={submit} className="grid h-7 w-7 place-items-center rounded-full bg-amber-400 text-[15.5px] font-bold text-amber-950">↑</button>
        </div>
      </div>
      {disp?.message && (
        <div className={`mt-2 flex items-center gap-2 text-[12.5px] ${disp.tone === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
          {disp.message}
          {disp.showResend && <button onClick={submit} className="ml-auto font-bold underline">Resend</button>}
        </div>
      )}
    </div>
  );
}
```

Note: `mr-auto` on the readonly hint pushes only itself left while the (now single) action group stays right-aligned via `justify-end` — matches spec §4's rule exactly (status/hint content left, CTA group right, primary CTA rightmost) using the codebase's existing Tailwind idiom rather than introducing a new layout pattern.

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/composer-gate.test.tsx`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/components/Composer.tsx pwa/test/composer-gate.test.tsx
git commit -m "feat(ui): right-align composer actions, Send/Resend rightmost (spec §4)"
```

---

## Task 17: SPIKE — verify `tool_result`-over-stdin write mechanism

**Files:** none (investigation task — produces a documented finding, not shipped code). If it succeeds, append the finding to `microviber/docs/architecture-spec.md`'s verified-claims table (§2) as a new F-numbered row, matching the existing F11/F13-F15 style.

This task is a hard prerequisite gate for Tasks 21's answer-submission piece. **Do not implement answer submission before this task's outcome is known.**

- [ ] **Step 1: Set up a real, disposable test session**

In a scratch directory, start a real Claude Code session and get it to reach a state where the *next* model turn will call `AskUserQuestion` — the simplest reliable way is to literally instruct it: run `claude` interactively in a scratch folder and prompt it with something like *"Call the AskUserQuestion tool right now with a single yes/no question, verbatim, no other action."* Confirm (by watching the terminal) that it does call the tool and is now waiting.

- [ ] **Step 2: Note the live session's id and resume it headlessly, matching MicroViber's exact takeover invocation**

```bash
# From the scratch folder, find the session id (it's in the terminal's own
# output, or via `ls ~/.claude/projects/<encoded-cwd>/` for the newest .jsonl).
claude -p --verbose --resume <sessionId> --input-format stream-json --output-format stream-json --dangerously-skip-permissions
```

Leave this process running, reading its stdout in the same terminal (do not background it — you need to watch what it does live).

- [ ] **Step 3: Inspect the transcript's pending tool_use to get the exact `tool_use_id`**

```bash
tail -5 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

Find the `assistant` entry whose content includes a `tool_use` block with `"name":"AskUserQuestion"` — copy its `"id"` field (the `tool_use_id` the answer must reference).

- [ ] **Step 4: Attempt the write — send a `tool_result` frame on the resumed process's stdin**

In a second terminal, find the resumed process's stdin (this requires either piping stdin at spawn time in a small Node harness, or — simpler for a manual spike — spawning the same command from a small script that writes to `child.stdin` directly, mirroring exactly what `daemon/src/lib/claude-adapter/session-manager.ts`'s `stdinWrite` does). Write:

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"<the id from Step 3>","content":"yes"}]}}
```

followed by a newline (matching `userFrame()`'s exact framing style in `prompt-sender.ts` — a single JSON object per line).

- [ ] **Step 5: Observe and record the outcome**

Watch both the process's stdout and the transcript file (`tail -f` it). Record exactly one of these outcomes:

- **PASS** — the transcript grows with a new `user` entry containing the `tool_result`, immediately followed by a new `assistant` entry that acknowledges the answer (e.g. continues the conversation referencing "yes"). This confirms the mechanism works exactly like a plain user turn does (F11), just with a `tool_result` content block instead of a `text` block.
- **FAIL (rejected)** — the process errors, exits, or the transcript does not grow / grows with something indicating the frame was invalid.
- **FAIL (silently ignored)** — the write returns success but nothing happens (matches the I6 pattern from the peer-socket investigation — the write superficially succeeds but produces no effect).

- [ ] **Step 6: Document the finding and gate the remaining Feature 5 tasks on it**

Write the exact finding (PASS/FAIL, with the raw transcript excerpt as evidence) into `microviber/docs/architecture-spec.md` §2's verified-claims table, following the existing F11-style row format exactly:

```markdown
| F16 | `tool_result` content blocks can be written over the same takeover stdin transport as plain user turns | <PASS/FAIL — paste the actual transcript excerpt observed in Step 5> |
```

**If PASS:** proceed to Tasks 18-21 as written below — Task 21's answer-submission step reuses the existing `send()`/`userFrame()`-style path with a `tool_result` frame instead of a `text` frame.

**If FAIL:** STOP. Do not implement Task 21's answer-submission mechanism as currently scoped. Instead, this becomes a new open design question requiring a return to `syncounter-brainstorming` for Feature 5's answer-submission path specifically (Tasks 18-20, which only touch state *derivation*, not submission, remain valid either way and can proceed) — do not invent an unreviewed alternative mechanism inline.

```bash
git add microviber/docs/architecture-spec.md
git commit -m "docs: record F16 finding — tool_result-over-stdin spike for AskUserQuestion answers"
```

---

## Task 18: `transcript-meta.ts` — `AskUserQuestion` detection

**Files:**
- Modify: `daemon/src/lib/claude-adapter/transcript-meta.ts`, `daemon/src/lib/claude-adapter/schemas.ts`
- Test: extend `daemon/test/transcript-meta.test.ts`, extend `daemon/test/schemas.test.ts`

**Interfaces:**
- Produces: `TranscriptMeta` gains `pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null`. `schemas.ts` gains `export const ToolResultBlock = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown() })` and `export const AskUserQuestionInputSchema = z.object({ questions: z.array(z.object({ question: z.string(), header: z.string(), options: z.array(z.object({ label: z.string(), description: z.string() })), multiSelect: z.boolean().optional() })) })`.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/schemas.test.ts`:

```ts
import { ToolResultBlock, AskUserQuestionInputSchema } from '../src/lib/claude-adapter/schemas.js';

describe('ToolResultBlock', () => {
  it('parses a tool_result content block', () => {
    const r = ToolResultBlock.safeParse({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'yes' });
    expect(r.success).toBe(true);
  });
});

describe('AskUserQuestionInputSchema', () => {
  it('parses the tool\'s documented input shape', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
    });
    expect(r.success).toBe(true);
  });
  it('rejects a shape missing required fields', () => {
    expect(AskUserQuestionInputSchema.safeParse({ questions: [{ question: 'x' }] }).success).toBe(false);
  });
});
```

Add to `daemon/test/transcript-meta.test.ts` (matching the file's existing fixture-line-building helper style — e.g. if it has a `toolUseLine()`/similar helper, extend that pattern rather than hand-writing raw JSON each time):

```ts
it('detects a pending AskUserQuestion (tool_use with no matching tool_result yet)', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }], multiSelect: false }] } }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' }),
  ].join('\n');
  const meta = scanTranscriptMeta(jsonl);
  expect(meta.pendingQuestion).not.toBeNull();
  expect(meta.pendingQuestion?.questions[0]?.question).toBe('Proceed?');
});

it('clears pendingQuestion once a matching tool_result arrives', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }], multiSelect: false }] } }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] }, timestamp: '2026-01-01T00:00:02Z' }),
  ].join('\n');
  const meta = scanTranscriptMeta(jsonl);
  expect(meta.pendingQuestion).toBeNull();
});

it('ignores a tool_use for any tool other than AskUserQuestion', () => {
  const jsonl = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' }, timestamp: '2026-01-01T00:00:01Z' });
  expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
});
```

Note: to make the "matching" test meaningful, `ToolUseBlock` needs an `id` field the current schema doesn't have — add it as part of Step 3 below (it's a real gap: the current schema can't identify *which* tool call a later tool_result answers).

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/schemas.test.ts test/transcript-meta.test.ts`
Expected: FAIL — new exports don't exist, `pendingQuestion` isn't on `TranscriptMeta`

- [ ] **Step 3: Implement**

In `daemon/src/lib/claude-adapter/schemas.ts`, add the `id` field to `ToolUseBlock` (a real, necessary fix — without it, tool_use/tool_result matching by id is impossible) and add the two new exports:

```ts
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string().max(128),
  input: z.unknown(),
});

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
});

export const AskUserQuestionInputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean().optional(),
  })),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>['questions'][number];
```

In `daemon/src/lib/claude-adapter/transcript-meta.ts`:

```ts
import { TranscriptLineSchema, ToolResultBlock, AskUserQuestionInputSchema, type AskUserQuestionInput } from './schemas.js';

export interface TranscriptMeta {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null;
}

export function scanTranscriptMeta(jsonl: string): TranscriptMeta {
  // ...existing local vars...
  let pendingQuestion: TranscriptMeta['pendingQuestion'] = null;

  for (const line of jsonl.split('\n')) {
    // ...existing parse/skip logic...

    if (e.type === 'assistant') {
      turnOpen = e.message.stop_reason !== 'end_turn';
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use' && (block as { name?: string }).name === 'AskUserQuestion') {
            const parsedInput = AskUserQuestionInputSchema.safeParse((block as { input?: unknown }).input);
            if (parsedInput.success) {
              pendingQuestion = { toolUseId: (block as { id: string }).id, questions: parsedInput.data.questions };
            }
          }
        }
      }
    } else if (e.type === 'user') {
      // ...existing extractText/turnOpen logic...
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const parsed = ToolResultBlock.safeParse(block);
          if (parsed.success && pendingQuestion && parsed.data.tool_use_id === pendingQuestion.toolUseId) {
            pendingQuestion = null;
          }
        }
      }
    }
  }

  return { title: customTitle ?? aiTitle, lastPrompt, lastPromptAt, lastActivityAt, turnOpen, pendingQuestion };
}
```

(Splice this into the existing function body at the marked points — do not duplicate the existing `extractText`/title logic already there.)

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/schemas.test.ts test/transcript-meta.test.ts`
Expected: PASS (all existing tests plus the 5 new ones)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/lib/claude-adapter/transcript-meta.ts daemon/src/lib/claude-adapter/schemas.ts daemon/test/transcript-meta.test.ts daemon/test/schemas.test.ts
git commit -m "feat(askuserquestion): detect pending/resolved AskUserQuestion in transcript-meta (spec §6)"
```

---

## Task 19: `session-state.ts` `awaiting-input` state + `ownership.ts` gate extension

**Files:**
- Modify: `daemon/src/domain/session-state.ts`, `daemon/src/domain/ownership.ts`, `daemon/src/domain/registry.ts`, `daemon/src/services/services.ts`
- Test: extend `daemon/test/session-state.test.ts`, `daemon/test/ownership.test.ts`, `daemon/test/registry.test.ts`

**Interfaces:**
- Produces: `SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input'`. `deriveState` gains a `hasPendingQuestion: boolean` input. `assertIdleForTakeover` accepts `'idle' | 'awaiting-input'`.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/session-state.test.ts`:

```ts
it('a pending AskUserQuestion overrides every timing-based rule — awaiting-input even with fresh growth', () => {
  const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: true, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
  expect(state).toBe('awaiting-input');
});

it('a dead session is still stale even with a pending question — !alive is checked first', () => {
  const state = deriveState({ alive: false, lastActivityAt: null, notifyIdleAt: null, turnOpen: true, hasPendingQuestion: true, nowMs: 0 });
  expect(state).toBe('stale');
});

it('without a pending question, behavior is unchanged from before (regression guard)', () => {
  const state = deriveState({ alive: true, lastActivityAt: '2026-01-01T00:00:00.000Z', notifyIdleAt: null, turnOpen: true, hasPendingQuestion: false, nowMs: Date.parse('2026-01-01T00:00:01.000Z') });
  expect(state).toBe('working');
});
```

Add to `daemon/test/ownership.test.ts`:

```ts
it('assertIdleForTakeover accepts awaiting-input alongside idle (the actual bug fix)', () => {
  expect(() => assertIdleForTakeover('awaiting-input')).not.toThrow();
});
it('assertIdleForTakeover still rejects working and stale', () => {
  expect(() => assertIdleForTakeover('working')).toThrow(ForbiddenTakeoverError);
  expect(() => assertIdleForTakeover('stale')).toThrow(ForbiddenTakeoverError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/session-state.test.ts test/ownership.test.ts`
Expected: FAIL — `deriveState` doesn't accept `hasPendingQuestion`, `assertIdleForTakeover` still rejects `'awaiting-input'`

- [ ] **Step 3: Implement**

In `daemon/src/domain/session-state.ts`:

```ts
export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';

export function deriveState(input: {
  alive: boolean;
  lastActivityAt: string | null;
  notifyIdleAt: string | null;
  turnOpen: boolean;
  /** A structural override (spec Feature 5 §6): a session genuinely blocked
   * on AskUserQuestion is awaiting-input regardless of transcript timing —
   * this is NOT a heuristic like the growth-window rules below it, so it's
   * checked right after the only other structural check (!alive) and before
   * every timing-based rule, including notify_idle. */
  hasPendingQuestion: boolean;
  nowMs: number;
}): SessionState {
  if (!input.alive) return 'stale';
  if (input.hasPendingQuestion) return 'awaiting-input';

  if (input.notifyIdleAt) {
    const idleAt = Date.parse(input.notifyIdleAt);
    const growthAt = input.lastActivityAt ? Date.parse(input.lastActivityAt) : -Infinity;
    if (!Number.isNaN(idleAt) && idleAt >= growthAt) return 'idle';
  }

  if (input.lastActivityAt) {
    const growthAt = Date.parse(input.lastActivityAt);
    if (!Number.isNaN(growthAt)) {
      const sinceGrowth = input.nowMs - growthAt;
      if (sinceGrowth < IDLE_AFTER_MS) return 'working';
      if (input.turnOpen && sinceGrowth < OPEN_TURN_MAX_MS) return 'working';
    }
  }

  return 'idle';
}
```

In `daemon/src/domain/ownership.ts`:

```ts
export function assertIdleForTakeover(state: SessionState): void {
  if (state !== 'idle' && state !== 'awaiting-input') throw new ForbiddenTakeoverError(state);
}
```

In `daemon/src/domain/registry.ts`, thread `pendingQuestion` through so `buildSummary` can pass `hasPendingQuestion` to `deriveState`:

```ts
export interface DiscoveredLike {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
}

export interface SessionSummary {
  // ...existing fields...
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
}

export function buildSummary(d: DiscoveredLike, ctx: { /* ...existing... */ }): SessionSummary {
  return {
    // ...existing fields...
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      turnOpen: d.turnOpen,
      hasPendingQuestion: d.pendingQuestion !== null,
      nowMs: ctx.nowMs,
    }),
    pendingQuestion: d.pendingQuestion,
  };
}
```

`DiscoveredLike` is populated from `discoverSessions()` (in `lib/claude-adapter/discovery.ts`), which already reads `scanTranscriptMeta`'s output for `turnOpen`/`lastActivityAt`/etc. — extend that same call site to also pass through `pendingQuestion` (find where `discovery.ts` destructures `scanTranscriptMeta`'s return value and constructs its own discovered-session object; add `pendingQuestion: meta.pendingQuestion` alongside the existing fields it already copies).

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/session-state.test.ts test/ownership.test.ts test/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Full typecheck (this touches discovery.ts too — check it compiles) and commit**

```bash
cd daemon && npm run typecheck && npx vitest run
git add daemon/src/domain/session-state.ts daemon/src/domain/ownership.ts daemon/src/domain/registry.ts daemon/src/lib/claude-adapter/discovery.ts daemon/test/session-state.test.ts daemon/test/ownership.test.ts daemon/test/registry.test.ts
git commit -m "fix(askuserquestion): add awaiting-input state, unblock takeover during AskUserQuestion (spec §6 — the actual bug)"
```

---

## Task 20: `notify-policy.ts` — extend state type (logic only, no push dispatch)

**Files:**
- Modify: `daemon/src/domain/notify-policy.ts`
- Test: extend `daemon/test/notify-policy.test.ts`

**Interfaces:** `NotifyPolicy`'s private `State` type gains `'awaiting-input'` as a second notify-triggering value alongside `'idle'`.

**Explicit scope note (see Global Constraints):** this task makes the logic correct. It does **not** wire `NotifyPolicy` into `app.ts`/`services.ts`, and does **not** build a push-dispatch mechanism — neither exists today for the plain `idle` case either, and building one is out of scope for "AskUserQuestion support." File that as a separate follow-up story.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/notify-policy.test.ts`:

```ts
it('notifies when a session transitions into awaiting-input, same as transitioning into idle', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  expect(intents).toEqual([{ type: 'notify', sessionId: 's1', tag: 'session:s1', title: 'T', body: '' }]);
});

it('does not double-notify transitioning directly from idle to awaiting-input or back', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  expect(intents).toEqual([]); // both are "waiting for you" states — no re-notify between them
});

it('dismisses when leaving awaiting-input for working', () => {
  const policy = new NotifyPolicy();
  policy.reconcile([{ id: 's1', state: 'awaiting-input', title: 'T' }]);
  const intents = policy.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
  expect(intents).toEqual([{ type: 'dismiss', tag: 'session:s1' }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd daemon && npx vitest run test/notify-policy.test.ts`
Expected: FAIL — `'awaiting-input'` isn't assignable to the current `State` type; the idle-to-awaiting-input case incorrectly re-notifies

- [ ] **Step 3: Implement**

```ts
// daemon/src/domain/notify-policy.ts
type State = 'working' | 'idle' | 'stale' | 'awaiting-input';
interface SessionLite { id: string; state: State; title: string; statusLine?: string }

// ...NotifyIntent, tagOf unchanged...

function isWaitingForYou(s: State): boolean {
  return s === 'idle' || s === 'awaiting-input';
}

export class NotifyPolicy {
  private last = new Map<string, State>();

  reconcile(sessions: readonly SessionLite[]): NotifyIntent[] {
    const intents: NotifyIntent[] = [];
    const seen = new Set<string>();

    for (const s of sessions) {
      seen.add(s.id);
      const prev = this.last.get(s.id);
      const prevWaiting = prev !== undefined && isWaitingForYou(prev);
      const nowWaiting = isWaitingForYou(s.state);
      if (nowWaiting && !prevWaiting) {
        intents.push({ type: 'notify', sessionId: s.id, tag: tagOf(s.id), title: s.title, body: s.statusLine ?? '' });
      } else if (!nowWaiting && prevWaiting) {
        intents.push({ type: 'dismiss', tag: tagOf(s.id) });
      }
      this.last.set(s.id, s.state);
    }

    for (const [id, prev] of this.last) {
      if (!seen.has(id)) {
        if (isWaitingForYou(prev)) intents.push({ type: 'dismiss', tag: tagOf(id) });
        this.last.delete(id);
      }
    }
    return intents;
  }

  onOpened(sessionId: string): NotifyIntent {
    return { type: 'dismiss', tag: tagOf(sessionId) };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd daemon && npx vitest run test/notify-policy.test.ts`
Expected: PASS (all existing 5 tests, unchanged behavior for plain idle transitions, plus the 3 new ones)

- [ ] **Step 5: Typecheck and commit**

```bash
cd daemon && npm run typecheck
git add daemon/src/domain/notify-policy.ts daemon/test/notify-policy.test.ts
git commit -m "feat(askuserquestion): treat awaiting-input as a notify-triggering state in NotifyPolicy (logic only — no push dispatch exists yet, filed separately)"
```

---

## Task 21: PWA — `awaiting-input` UI (session list, Transcript rendering, Composer, answer submission)

**Files:**
- Modify: `pwa/src/lib/types.ts`, `pwa/src/components/SessionPicker.tsx`, `pwa/src/components/Transcript.tsx`, `pwa/src/components/Composer.tsx`, `pwa/src/App.tsx`
- Test: extend relevant tests in each touched area

**Interfaces:**
- `SessionState` (PWA) gains `'awaiting-input'`. `TranscriptEvent` gains `{ kind: 'askUserQuestion'; at: string; toolUseId: string; questions: {...}[]; resolved: boolean; selectedLabels?: string[] }`.
- **Gated on Task 17's spike outcome:** the answer-submission wiring below assumes PASS. If Task 17 recorded FAIL, implement everything in this task except the final "submit an answer" step, and leave the option list read-only-but-visible even when taken over, with a one-line TODO-free note in the PR description (not the code) that submission is pending a resolved design.

- [ ] **Step 1: Write the failing tests**

Session-list dot (add to `pwa/test/session-picker.test.tsx`):

```tsx
it('renders a distinct dot color for awaiting-input, different from idle and working', () => {
  render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ state: 'awaiting-input' })]} onPick={() => {}} />);
  const dot = screen.getByText('A').parentElement!.previousElementSibling!;
  expect(dot.className).toMatch(/bg-fuchsia-400/);
});
```

Transcript rendering (add a new test file `pwa/test/transcript-askuserquestion.test.tsx`):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';

afterEach(cleanup);

describe('Transcript AskUserQuestion rendering (spec §6)', () => {
  it('renders a pending question expanded, never collapsed to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders a resolved question read-only with the selected option highlighted', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    const yes = screen.getByText('Yes');
    expect(yes.className).toMatch(/amber|selected/);
  });
});
```

Composer mapping (add to composer tests):

```tsx
it('shows the Take-over button for awaiting-input, exactly like idle (spec §6, no shortcut)', () => {
  // This asserts against App.tsx's composer-gating switch, not Composer.tsx directly —
  // find App.tsx's existing readonly-mode state switch (working/idle/stale ternary) and
  // add this as a 4th branch there, then test it at whatever level the existing
  // working/idle/stale gating is already tested (likely composer-gate.test.tsx via full App render).
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run`
Expected: FAIL — `'askUserQuestion'` isn't a valid `TranscriptEvent` kind, `'awaiting-input'` isn't a valid `SessionState`

- [ ] **Step 3: Implement**

In `pwa/src/lib/types.ts`:

```ts
export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';

export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean; selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[] };
```

In `pwa/src/components/SessionPicker.tsx`, `STATE_DOT` already has `'awaiting-input': 'bg-fuchsia-400'` from Task 15 — no further change needed there.

In `pwa/src/components/Transcript.tsx`, add a case to `EventRow`'s switch:

```tsx
case 'askUserQuestion':
  return (
    <div className="rounded-lg border border-fuchsia-700/50 bg-fuchsia-500/5 p-3">
      {e.questions.map((q, qi) => (
        <div key={qi} className="mb-2 last:mb-0">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-fuchsia-400">{q.header}</div>
          <div className="mb-2 text-[15px] text-zinc-100">{q.question}</div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => {
              const isSelected = e.resolved && e.selectedLabels?.includes(o.label);
              return (
                <span key={o.label} className={`rounded-full border px-3 py-1 text-[13px] ${isSelected ? 'border-amber-400 bg-amber-400/10 text-amber-300 font-semibold' : 'border-zinc-600 text-zinc-300'} ${e.resolved ? 'opacity-80' : ''}`}>
                  {o.label}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
```

In `pwa/src/App.tsx`, find the existing readonly-mode ternary (`current.state === 'idle' ? ... : current.state === 'stale' ? ... : ...` — the block rendering "Take over" / "session has ended" / "still working") and add `awaiting-input` as mapping to the same branch as `idle`:

```tsx
current.state === 'idle' || current.state === 'awaiting-input' ? (
  <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
    <button onClick={() => void takeoverSession()} disabled={takingOver}
      className="w-full rounded-lg bg-amber-400 py-2.5 text-[14px] font-semibold text-amber-950 disabled:opacity-60">
      {takingOver ? 'Taking over…' : 'Take over — send from phone'}
    </button>
  </div>
) : current.state === 'stale' ? (
  // ...unchanged...
```

**Answer submission (gated on Task 17 PASS):** once taken over, tapping an option in a *pending* (`resolved: false`) question should call `send()` with the option's label as plain text — reusing the exact existing `send` function in `App.tsx` unchanged (per spec §6: "follows the same accepted/queued/failed lifecycle as an ordinary sent prompt"). Add an `onClick` to the pending-question option buttons in `Transcript.tsx` (thread a new `onAnswerQuestion: (toolUseId: string, label: string) => void` prop through `Transcript`/`EventRow`, wired in `App.tsx` to `(toolUseId, label) => void send(label)` — the existing `send` function already handles the accepted/queued/failed lifecycle correctly for any text, including an answer label). Only render options as clickable when `current.mode === 'owned'` (taken over) and `!e.resolved`; otherwise render them as the inert, non-interactive spans shown above.

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run`
Expected: PASS (full suite)

- [ ] **Step 5: Full typecheck, full test suite both workspaces, commit**

```bash
cd microviber && npm run typecheck && npm test
git add pwa/src/lib/types.ts pwa/src/components/Transcript.tsx pwa/src/components/SessionPicker.tsx pwa/src/App.tsx pwa/test/
git commit -m "feat(askuserquestion): render pending/resolved questions in transcript, wire answer submission through existing send() (spec §6)"
```

---

## Post-plan checklist (not a task — a final gate before code review)

- [ ] Run `npm run lint` from `microviber/` root — this plan's steps only ran `typecheck`/`test` per-task; lint should also pass before the story moves to code review.
- [x] Icon PNGs (spec §2) confirmed present at `pwa/public/` (delivered 2026-08-28) — Task 12 just needs to wire the correct flat paths, not wait on the art.
- [ ] File a follow-up story for the push-dispatch subsystem gap noted in Task 20's Global Constraints — do not let it silently disappear once this plan is closed out.
- [ ] Reconcile `microviber/docs/functional-spec.md` §3 (composer-gating table, session-list description) per spec.md §7/§8's noted required reconciliation — this plan's tasks changed the *code*; the doc still needs the matching update pass.
