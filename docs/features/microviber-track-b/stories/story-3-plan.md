# Web Pane UI — Dropdown Address Bar + Sandboxed Iframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the PWA a real "Web" pane — a dropdown-driven address bar over a sandboxed iframe — that lets a phone browse a session folder's resolved dev server, replacing the static "coming soon" tab.

**Architecture:** Two new leaf components (`CaretButton`, a generic dropdown trigger; `WebPane`, the address bar/dropdown/iframe) plus one new `Api` method (`mintWebpaneToken`). `App.tsx` gains a `pane: 'claude' | 'web'` state so `PaneSwitch` becomes interactive instead of static, and renders `WebPane` when the Web tab is active. `WebPane` mints a scoped, short-lived `mv_webpane` cookie (already implemented server-side in story microviber-track-b-2) before ever pointing the iframe at a resolved dev server, and the iframe is sandboxed with `allow-scripts allow-forms` and explicitly no `allow-same-origin` (T15) — the framed page gets an opaque origin and can never reach this app's own bearer token, `localStorage`, or control-plane API.

**Tech Stack:** Vite + React 19 + Tailwind 4 (pwa/), Vitest + @testing-library/react + jsdom for tests. Quality gate: `npm run typecheck && npm run lint && npm test` run from the microviber repo root.

## Global Constraints

- `CaretButton`'s signature is exactly `{ open: boolean; onClick: () => void }` — story microviber-track-b-6 depends on it being stable; do not add, rename, or widen any prop.
- `WebPane` must export a module-level `navigateWebPane(target)` function so story microviber-track-b-4 (transcript-link tap routing) can drive navigation later without prop-drilling. No context provider — a single module-level subscriber is sufficient because exactly one `WebPane` is ever mounted.
- The iframe's `sandbox` attribute must be the literal string `"allow-scripts allow-forms"` — no `allow-same-origin`, ever (T15, spec §3 "Iframe sandboxing"). This is a hard security invariant, not a default to be "improved" later.
- A webpane token (`POST /api/webpane-token`) must be minted and awaited **before** the iframe is pointed at a resolved target — never fire the navigation optimistically and mint in parallel.
- `@typescript-eslint/no-explicit-any` is an eslint error in this repo — no `any` without a `// reason:` comment.
- `npm run typecheck && npm run lint && npm test` (from repo root, all workspaces) must be green before any commit — this is the CI gate (architecture-spec.md §6).
- Do not touch `pwa/src/lib/link-classify.ts` or any transcript tap-routing — that is story microviber-track-b-4's scope, explicitly out of this story.

---

### Task 1: Shared `CaretButton` component

**Files:**
- Create: `pwa/src/components/CaretButton.tsx`
- Test: `pwa/test/caret-button.test.tsx`

**Interfaces:**
- Produces: `export function CaretButton({ open, onClick }: { open: boolean; onClick: () => void }): ReactElement` — consumed by Task 3 (`WebPane`) below, and later by story microviber-track-b-6 (`SessionPicker`). Signature is frozen per the Global Constraints above.

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

- [ ] **Step 2: Run to verify it fails**

Run: `cd pwa && npx vitest run test/caret-button.test.tsx`
Expected: FAIL — `../src/components/CaretButton.js` not found

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd pwa && npx vitest run test/caret-button.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/components/CaretButton.tsx pwa/test/caret-button.test.tsx
git commit -m "feat(ui): add shared CaretButton component (spec §4)"
```

---

### Task 2: `mintWebpaneToken` on the `Api`

**Files:**
- Modify: `pwa/src/lib/api.ts` (append inside the object returned by `createApi`, after `handback`)
- Test: `pwa/test/api.test.ts` (existing file — add a `describe` block)

**Interfaces:**
- Consumes: `authHeaders`, `ApiError`, `fallbackMessage` — all already defined in `pwa/src/lib/api.ts`, unchanged.
- Produces: `mintWebpaneToken(resource: { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string }): Promise<void>` on the object returned by `createApi` (and therefore on the `Api` type). Consumed by Task 3 (`WebPane`).
- Server contract (already implemented and merged in story microviber-track-b-2, `daemon/src/api/app.ts`): `POST /api/webpane-token` accepts exactly this body shape, re-validates the resource (403/404 if not currently resolvable/readable), and responds `{ success: true, data: { ok: true } }` while setting the `mv_webpane` cookie via `Set-Cookie`.

- [ ] **Step 1: Write the failing test**

Read `pwa/test/api.test.ts` first to match its existing `fetch`-mocking style exactly (it already mocks `global.fetch` for the other `createApi` methods — reuse that same pattern, do not introduce a second mocking approach). Add:

```ts
describe('mintWebpaneToken', () => {
  it('POSTs the resource and resolves on success, without requiring cookies to be visible to JS (HttpOnly)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('http://x', 'tok');
    await api.mintWebpaneToken({ kind: 'devserver', port: 9005 });
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/webpane-token', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ kind: 'devserver', port: 9005 }),
    }));
  });

  it('throws ApiError on a non-ok response (e.g. port no longer resolved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ success: false, error: { code: 'FORBIDDEN', message: 'port is not currently resolved' } }),
    }));
    const api = createApi('http://x', 'tok');
    await expect(api.mintWebpaneToken({ kind: 'devserver', port: 9999 })).rejects.toThrow('port is not currently resolved');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd pwa && npx vitest run test/api.test.ts`
Expected: FAIL — `api.mintWebpaneToken is not a function`

- [ ] **Step 3: Implement**

In `pwa/src/lib/api.ts`, inside the object returned by `createApi`, immediately after the existing `handback` method:

```ts
    /** Mints the scoped mv_webpane cookie for one resource (spec §3/T15) — must resolve before the iframe is pointed at it. */
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

- [ ] **Step 4: Run to verify it passes**

Run: `cd pwa && npx vitest run test/api.test.ts`
Expected: PASS (all existing api.test.ts tests + the 2 new ones)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/lib/api.ts pwa/test/api.test.ts
git commit -m "feat(webpane): add mintWebpaneToken to the Api (spec §3, T15)"
```

---

### Task 3: `WebPane.tsx` — address bar, dropdown, sandboxed iframe

**Files:**
- Create: `pwa/src/components/WebPane.tsx`
- Test: `pwa/test/webpane.test.tsx`

**Interfaces:**
- Consumes: `CaretButton` (Task 1), `mintWebpaneToken` (Task 2) via the `Api` type, `SessionSummary` (`pwa/src/lib/types.ts`, already has `devServerPort: number | null`).
- Produces:
  - `export function WebPane({ api, sessions, activeSessionCwd }: { api: Api; sessions: SessionSummary[]; activeSessionCwd: string }): ReactElement`
  - `export function navigateWebPane(target: { kind: 'devserver'; port: number; path: string } | { kind: 'localfile'; path: string }): void` — module-level, for story microviber-track-b-4 to call later. `activeSessionCwd` is accepted now (for interface stability with that later story) even though this story's own dropdown never needs it — only `Recent`/`Dev servers` selection paths are exercised here.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// pwa/test/webpane.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { WebPane } from '../src/components/WebPane.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(() => { cleanup(); localStorage.clear(); });

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
    render(<WebPane api={fakeApi()} sessions={[session, { ...session, id: 's2' }]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button')); // the CaretButton
    await waitFor(() => expect(screen.getByText(/studio/)).toBeInTheDocument());
    expect(screen.getAllByText(/localhost:9005/)).toHaveLength(1); // deduped by folder, not one row per session
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

  it('remembers the last-selected server across remounts (localStorage-backed)', async () => {
    const { unmount } = render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await screen.findByTitle('web-pane-content');
    unmount();
    render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    expect(await screen.findByTitle('web-pane-content')).toHaveAttribute('src', '/api/webpane/devserver/9005/');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd pwa && npx vitest run test/webpane.test.tsx`
Expected: FAIL — `../src/components/WebPane.js` not found

- [ ] **Step 3: Implement**

```tsx
// pwa/src/components/WebPane.tsx
import { useState, useEffect, type ReactElement } from 'react';
import type { Api } from '../lib/api.js';
import type { SessionSummary } from '../lib/types.js';
import { CaretButton } from './CaretButton.js';

type Target = { kind: 'devserver'; port: number; path: string } | { kind: 'localfile'; path: string };
const RECENT_KEY = 'mv_webpane_recent';
const LAST_KEY = 'mv_webpane_last';
const RECENT_MAX = 10;

function loadRecent(): Target[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Target[]; } catch { return []; }
}
function pushRecent(t: Target): void {
  const next = [t, ...loadRecent().filter((r) => JSON.stringify(r) !== JSON.stringify(t))].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable — non-fatal */ }
}
function loadLast(): Target | null {
  try { const raw = localStorage.getItem(LAST_KEY); return raw ? (JSON.parse(raw) as Target) : null; } catch { return null; }
}
function saveLast(t: Target): void {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(t)); } catch { /* storage unavailable — non-fatal */ }
}

function targetLabel(t: Target): string {
  return t.kind === 'devserver' ? `localhost:${t.port}${t.path}` : t.path;
}
function targetSrc(t: Target): string {
  return t.kind === 'devserver' ? `/api/webpane/devserver/${t.port}${t.path}` : `/api/webpane/localfile?path=${encodeURIComponent(t.path)}`;
}

// Module-level target setter so Transcript.tsx (story microviber-track-b-4) can
// drive navigation without prop-drilling the whole session tree through
// App.tsx. Exactly one WebPane instance is ever mounted (it's a pane, not a
// list), so a single module-level subscriber is sufficient and avoids a
// context provider for one value.
let externalNavigate: ((t: Target) => void) | null = null;
export function navigateWebPane(target: Target): void {
  externalNavigate?.(target);
}

export function WebPane({ api, sessions, activeSessionCwd: _activeSessionCwd }: { api: Api; sessions: SessionSummary[]; activeSessionCwd: string }): ReactElement {
  const [current, setCurrent] = useState<Target | null>(() => loadLast());
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Target[]>(() => loadRecent());

  const devServers = Array.from(
    new Map(sessions.filter((s) => s.devServerPort !== null).map((s) => [s.folder, { folder: s.folder, port: s.devServerPort! }])).values(),
  );

  const go = async (t: Target) => {
    await api.mintWebpaneToken(t.kind === 'devserver' ? { kind: 'devserver', port: t.port } : { kind: 'localfile', path: t.path });
    setCurrent(t);
    pushRecent(t);
    saveLast(t);
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
    <div className="relative flex flex-1 flex-col">
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

Note the `_activeSessionCwd` naming: the parameter is accepted (interface stability for story microviber-track-b-4, which will need it to resolve relative local-file links) but unused by this story's own logic — prefixing avoids an unused-var lint error without disabling the rule.

- [ ] **Step 4: Run to verify they pass**

Run: `cd pwa && npx vitest run test/webpane.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd pwa && npm run typecheck
git add pwa/src/components/WebPane.tsx pwa/test/webpane.test.tsx
git commit -m "feat(ui): add WebPane with sandboxed iframe, address bar, dropdown (spec §3, T15)"
```

---

### Task 4: Wire `WebPane` into the pane switch, remove the "coming soon" placeholder

**Files:**
- Modify: `pwa/src/components/states.tsx:28-35` (`PaneSwitch` — currently a static, non-interactive pair of `div`s with no props; the "Web" tab hardcodes a `coming soon` sub-label and neither tab has an `onClick`)
- Modify: `pwa/src/App.tsx:9,195` (imports `PaneSwitch` from `states.js`; renders it with no props at the bottom of the shell, unconditionally alongside the Claude-pane content above it)

**Interfaces:**
- Consumes: `WebPane` (Task 3), `Api` type (`pwa/src/lib/api.ts`).
- Changes `PaneSwitch`'s signature from `(): ReactElement` (no props) to `({ pane, onChange }: { pane: 'claude' | 'web'; onChange: (pane: 'claude' | 'web') => void }): ReactElement`. `PaneSwitch` has no other consumers in this repo (verified: only `App.tsx` imports it) — this is a widening from zero props to two required props, not a narrowing, and is safe to change directly rather than layering a new component.

- [ ] **Step 1: Update `PaneSwitch` to be interactive**

In `pwa/src/components/states.tsx`, replace the current `PaneSwitch` (lines 28-35):

```tsx
export function PaneSwitch({ pane, onChange }: { pane: 'claude' | 'web'; onChange: (pane: 'claude' | 'web') => void }): ReactElement {
  return (
    <div className="flex border-t border-zinc-800 bg-zinc-900">
      <button
        onClick={() => onChange('claude')}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[12.5px] ${pane === 'claude' ? 'text-amber-400' : 'text-zinc-600'}`}
      >
        <span className="text-[17.5px]">◈</span>Claude
      </button>
      <button
        onClick={() => onChange('web')}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[12.5px] ${pane === 'web' ? 'text-amber-400' : 'text-zinc-600'}`}
      >
        <span className="text-[17.5px]">⬡</span>Web
      </button>
    </div>
  );
}
```

This removes the `coming soon` sub-label entirely — the Web tab is now a normal, tappable tab styled identically to Claude, differing only by which one is active (amber vs. zinc-600), matching the existing active/inactive convention this file already used for the Claude tab.

- [ ] **Step 2: Wire `pane` state and `WebPane` into `App.tsx`**

In `pwa/src/App.tsx`:

1. Add the import (next to the existing `states.js` import on line 9):
   ```tsx
   import { WebPane } from './components/WebPane.js';
   ```

2. Add pane state, next to the other `useState` declarations (near line 20):
   ```tsx
   const [pane, setPane] = useState<'claude' | 'web'>('claude');
   ```

3. Replace the unconditional Claude-pane block (lines 169-194: the `sessions.length === 0 ? ... : ...` transcript/composer/takeover block) so it renders only `pane === 'claude'`, and add the `WebPane` branch for `pane === 'web'`. The block becomes:
   ```tsx
   {pane === 'claude' && (
     <>
       {sessions.length === 0 ? <EmptyState onRefresh={() => void refresh()} />
         : loadingTranscript && events.length === 0 ? <TranscriptLoading />
         : <Transcript events={events} sessionId={selected} />}

       {current && current.writable && current.mode === 'owned' && (
         <Composer mode={current.mode} status={status} onSend={(t) => void send(t)}
           onHandback={() => void handbackSession()} handingBack={handingBack} />
       )}
       {current && current.writable && current.mode === 'readonly' && (
         current.state === 'idle' ? (
           <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
             <button onClick={() => void takeoverSession()} disabled={takingOver}
               className="w-full rounded-lg bg-amber-400 py-2.5 text-[14px] font-semibold text-amber-950 disabled:opacity-60">
               {takingOver ? 'Taking over…' : 'Take over — send from phone'}
             </button>
           </div>
         ) : current.state === 'stale' ? (
           <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] leading-snug text-zinc-400">
             This session has ended — its laptop process is no longer running. Taking over a dead session isn't supported yet.
           </div>
         ) : (
           <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] leading-snug text-zinc-400">
             Watching this session live — it's still working. Wait until idle to take over and send prompts from here.
           </div>
         )
       )}
     </>
   )}
   {pane === 'web' && api && (
     <WebPane api={api} sessions={sessions} activeSessionCwd={current?.cwd ?? ''} />
   )}
   ```

4. Replace the `<PaneSwitch />` call (line 195) with:
   ```tsx
   <PaneSwitch pane={pane} onChange={setPane} />
   ```

- [ ] **Step 3: Full typecheck, lint, and whole test suite (App.tsx and states.tsx changed — both have existing consumers elsewhere in the suite)**

```bash
cd /Users/yariv_s/Harness-2/microviber && npm run typecheck && npm run lint && npm test
```

Expected: all green — no regressions in any existing pwa or daemon test.

- [ ] **Step 4: Commit**

```bash
cd microviber
git add pwa/src/components/states.tsx pwa/src/App.tsx
git commit -m "feat(ui): wire WebPane into the pane switch, drop 'coming soon' placeholder (AC1, AC6)"
```

---

### Task 5: Verify the SameSite=Strict / opaque-origin interaction against a real multi-asset dev server (T14/T15 gate for AC3/AC4)

**Why this is its own task, not a "nice to have":** story microviber-track-b-2's review flagged a specific, plausible failure mode that no jsdom/Vitest test in Tasks 1-4 can catch, because it depends on real browser cookie-jar behavior (`SameSite` enforcement) that jsdom does not implement. `mv_webpane` is minted with `SameSite=Strict` (`daemon/src/api/app.ts:186`, confirmed T15 in `docs/architecture-spec.md`). Because the iframe in Task 3 has `sandbox="allow-scripts allow-forms"` with no `allow-same-origin`, the framed document runs in a unique **opaque origin** — its own subsequent requests (its JS/CSS bundle fetches, any `fetch()` it issues itself) are cross-site from the cookie's point of view and will NOT carry `mv_webpane`, even though the iframe's own *initial* navigation (parent-initiated) does carry it. A single self-contained local HTML file will likely still render fully; a real dev server serving separate JS/CSS files (Vite, CRA, Next dev mode) may render blank or partially broken — and that failure looks identical to AC5's "nothing configured" empty state unless the network tab is actually inspected.

**This task must be run against a real dev server before AC3/AC4 are considered done** — the automated tests in Tasks 1-4 verify the sandbox attribute and the mint-before-navigate ordering, but cannot verify that the resulting page actually renders.

**Files:** none created or modified by this task itself — it is a verification procedure. If it reproduces the failure, its output feeds a follow-up decision (see Step 4), not a silent code change in this task.

- [ ] **Step 1: Start a real multi-asset dev server and the daemon**

Use any locally available multi-asset dev server for a folder MicroViber already resolves a port for (e.g. `studio`, `audio-producer`, or `scenario-creator` from the sibling Syncounter workspace, using this machine's port from `CLAUDE.local.md` — do NOT hardcode a port number in any committed file). Start the daemon per `microviber/INSTALL.md`. Confirm `GET /api/sessions` shows a `devServerPort` for that folder.

- [ ] **Step 2: Load it through the Web pane and inspect the network tab**

From a phone or a narrow browser window pointed at the daemon's PWA, tap the Web tab, open the dropdown, tap the resolved dev-server row. In the browser devtools Network tab (not just the visible page), check:
- Does the initial HTML document request (the iframe's own navigation) return 200?
- Do the subsequent JS/CSS/asset requests the loaded page issues itself return 200, or 401?

- [ ] **Step 3: Record the outcome**

Two possible outcomes:
- **No 401s — the page renders fully.** The theoretical failure mode does not reproduce in practice (e.g. because the specific dev server's asset requests happen not to require the cookie, or because same-site classification behaves differently than reasoned above for the daemon's actual bind address). Note this finding in this story's PR description. No further action needed for this task.
- **401s on subresources — the page renders blank or broken.** The failure reproduces. Do NOT patch around it locally (e.g. by quietly adding `allow-same-origin` to the iframe, which would defeat T15's entire mitigation). Instead:
  1. Flag it explicitly in this story's PR description and in the code-review pass as a spec amendment candidate, not a bug in this story's own code.
  2. The documented fix candidate (from the story's technical notes) is relaxing `mv_webpane`'s cookie attribute from `SameSite=Strict` to `SameSite=None; Secure` in `daemon/src/api/app.ts:186` — whose CSRF exposure is still bounded by the existing `Path=/api/webpane/` scoping, the single-resource token capability, and the 5-minute TTL (the same three bounds T15 already documents). That change belongs to a follow-up story/task against the daemon (out of this story's own Affected Files), since it touches the T14/T15 threat-model text in `docs/architecture-spec.md` and is a security-relevant amendment that deserves its own review, not a fix folded silently into this UI story.

- [ ] **Step 4: If a follow-up is needed, do not block this story's own ACs on it**

AC3 ("mints a token before navigating, then loads the iframe") and AC4 ("iframe has the exact sandbox attribute, no allow-same-origin") are about this story's own code, which Tasks 2-3's automated tests already verify. If Step 3 found subresource 401s, that is evidence for a *separate*, already-flagged, pre-existing risk in the shared auth mechanism (built in story microviber-track-b-2) — not a defect introduced by this story. Record the finding for the code-review/manual-test phase; do not add `allow-same-origin` or otherwise weaken the sandbox to work around it.

---

## Self-Review

**Spec coverage:**
- AC1 (real tappable Web tab, no "coming soon") → Task 4.
- AC2 (address bar, CaretButton dropdown, Recent + Dev servers, deduped by folder) → Task 3.
- AC3 (mint token before navigating, iframe src) → Task 2 (mint) + Task 3 (ordering, asserted by test).
- AC4 (exact sandbox attribute, no allow-same-origin, verified via rendered DOM) → Task 3's test asserts `iframe.getAttribute('sandbox')` directly.
- AC5 (empty state for no resolved dev server) → Task 3's first test.
- AC6 (last-selected remembered across reopen) → Task 3's fourth test (`localStorage`-backed `LAST_KEY`, separate from the `RECENT_KEY` history list).
- The flagged SameSite=Strict/opaque-origin risk (must verify before AC3/AC4 are "done", not just unit-tested) → Task 5.
- `CaretButton` signature freeze (for story microviber-track-b-6) → Global Constraints + Task 1's Interfaces block.
- `navigateWebPane` export (for story microviber-track-b-4) → Task 3's Interfaces block and implementation.
- Task 9 (`link-classify.ts`) is out of scope for this story (confirmed: not in the story's Affected Files) — correctly excluded from this plan.

**Placeholder scan:** no TBD/TODO, no "add appropriate handling," no unshown code — every step has literal file contents.

**Type consistency:** `Target` type in `WebPane.tsx` matches `navigateWebPane`'s parameter type and `go`'s parameter type throughout Task 3. `Api['mintWebpaneToken']`'s parameter type (Task 2) matches exactly what `WebPane.go` (Task 3) passes to it. `PaneSwitch`'s new prop names (`pane`, `onChange`) match exactly what `App.tsx` passes in Task 4 Step 2.4 (`pane={pane} onChange={setPane}`).
