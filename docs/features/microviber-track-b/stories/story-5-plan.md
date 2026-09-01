# Title Bar + PWA Install Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MicroViber a real app identity (manifest icons, favicon/apple-touch-icon — the latter already done) and a title bar with a conditional one-tap PWA install button.

**Architecture:** A module-level singleton (`captureInstallPrompt`) listens for `beforeinstallprompt` once and exposes a getter plus a `display-mode: standalone` check via `matchMedia`. A new `TitleBar` component polls that singleton on an interval (the event fires asynchronously after mount) and renders an install button only when an event has been captured and the app isn't already running standalone. `TitleBar` is mounted once inside `Shell`, so it appears on every screen.

**Tech Stack:** Vite + React 19 + Tailwind 4, Vitest + Testing Library (jsdom for component/DOM tests).

## Global Constraints

- Manifest icons must use `purpose: "any maskable"` (not `"any"`) per story AC #1.
- No install detection/fallback UI on iOS — Android/Chrome only, by explicit spec decision (`docs/features/microviber-track-b/spec.md` §9). Since `beforeinstallprompt` never fires on iOS Safari, satisfying this requires no iOS-specific branching — just never show the button in the absence of a captured event.
- `npm run typecheck && npm run lint && npm test` (run from `microviber/`) must pass before any commit.

---

## Task 1: Manifest icon `purpose` fix

**Files:**
- Modify: `pwa/public/manifest.webmanifest`
- Test: `pwa/test/manifest.test.ts`

**Interfaces:** none (static asset only).

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && npx vitest run test/manifest.test.ts`
Expected: FAIL — current `purpose` is `"any"`, not `"any maskable"`.

- [ ] **Step 3: Implement**

Edit `pwa/public/manifest.webmanifest`, changing both icon entries' `"purpose": "any"` to `"purpose": "any maskable"`. Leave every other field (`name`, `short_name`, `start_url`, `display`, `background_color`, `theme_color`) untouched — they already satisfy the story.

```json
{
  "name": "MicroViber",
  "short_name": "MicroViber",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#09090b",
  "theme_color": "#09090b",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && npx vitest run test/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd microviber && git add pwa/public/manifest.webmanifest pwa/test/manifest.test.ts
git commit -m "fix(pwa): manifest icons use any+maskable purpose (spec §2)"
```

**Note:** `pwa/index.html` already links `apple-touch-icon.png` and `favicon.png` (delivered in an earlier story) — AC #2 needs no changes and has no task here.

---

## Task 2: `install-prompt.ts` — capture `beforeinstallprompt` + standalone check

**Files:**
- Create: `pwa/src/lib/install-prompt.ts`
- Test: `pwa/test/install-prompt.test.ts`

**Interfaces:**
- Produces: `export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean }`

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && npx vitest run test/install-prompt.test.ts`
Expected: FAIL — `pwa/src/lib/install-prompt.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

```ts
// pwa/src/lib/install-prompt.ts
let capturedEvent: Event | null = null;
let listenerAttached = false;

/** Captures the one-shot `beforeinstallprompt` event and exposes standalone-mode detection (spec §2). */
export function captureInstallPrompt(): { getEvent: () => Event | null; isStandalone: () => boolean } {
  if (!listenerAttached) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      capturedEvent = e;
    });
    listenerAttached = true;
  }
  return {
    getEvent: () => capturedEvent,
    isStandalone: () => window.matchMedia('(display-mode: standalone)').matches,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && npx vitest run test/install-prompt.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd microviber && git add pwa/src/lib/install-prompt.ts pwa/test/install-prompt.test.ts
git commit -m "feat(pwa): capture beforeinstallprompt + standalone detection (spec §2)"
```

---

## Task 3: `TitleBar.tsx` — icon, wordmark, conditional install button

**Files:**
- Create: `pwa/src/components/TitleBar.tsx`
- Test: `pwa/test/title-bar.test.tsx`

**Interfaces:**
- Consumes: `captureInstallPrompt` from Task 2 (`{ getEvent, isStandalone }`).
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
    const btn = screen.getByText(/install/i);
    fireEvent.click(btn);
    expect((evt as unknown as { prompt: () => void }).prompt).toHaveBeenCalled();
  });

  it('shows no install button when already running standalone', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn() });
    fireEvent(window, evt);
    expect(screen.queryByText(/install/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && npx vitest run test/title-bar.test.tsx`
Expected: FAIL — `pwa/src/components/TitleBar.tsx` doesn't exist yet.

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && npx vitest run test/title-bar.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd microviber && git add pwa/src/components/TitleBar.tsx pwa/test/title-bar.test.tsx
git commit -m "feat(pwa): add TitleBar with conditional install button (spec §4)"
```

---

## Task 4: Wire `TitleBar` into `Shell`

**Files:**
- Modify: `pwa/src/App.tsx:1-11` (imports), `pwa/src/App.tsx:223-225` (`Shell`)

**Interfaces:**
- Consumes: `TitleBar` from Task 3.

- [ ] **Step 1: Confirm the existing full-suite baseline**

Run: `cd pwa && npx vitest run`
Expected: all pre-existing tests still pass (no test targets `Shell`'s children directly, so this wiring is validated by App-level behavior already covered elsewhere plus Task 3's own TitleBar tests — no new test file needed for this task).

- [ ] **Step 2: Implement**

Add the import alongside the other component imports in `pwa/src/App.tsx`:

```tsx
import { TitleBar } from './components/TitleBar.js';
```

Update `Shell` (currently `pwa/src/App.tsx:223-225`) to render `TitleBar` as the first child, before `{children}`, so it appears on every screen (pairing, empty state, session view, Web pane) that renders inside `Shell`:

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

- [ ] **Step 3: Run full suite + typecheck to verify no regressions**

Run: `cd pwa && npx vitest run && cd .. && npm run typecheck`
Expected: PASS, exit 0

- [ ] **Step 4: Commit**

```bash
cd microviber && git add pwa/src/App.tsx
git commit -m "feat(pwa): mount TitleBar in Shell so it renders on every screen (spec §4)"
```

---

## Task 5: Full quality gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: all three exit 0; no pre-existing test regressed.

- [ ] **Step 2: Commit (only if the gate required fixes)**

If Step 1 is clean with no changes needed, skip this — Task 4's commit already leaves the tree clean. If lint/typecheck required touch-ups, commit them:

```bash
cd microviber && git add -A
git commit -m "chore(pwa): satisfy lint/typecheck after TitleBar wiring"
```

---

## Self-Review

**Spec coverage:**
- AC #1 (manifest icons, `any maskable`, standalone, start_url) → Task 1.
- AC #2 (apple-touch-icon/favicon links) → already satisfied by an earlier story; explicitly noted, no task needed.
- AC #3 (title bar visible on every screen) → Task 3 (renders) + Task 4 (mounted once in `Shell`, which wraps every screen).
- AC #4 (install button only when event captured AND not standalone) → Task 2 (`isStandalone`) + Task 3 (both conditions gate `installEvent`, and the "already standalone" test in Task 3 covers the second half of AC #4 that the original spec snippet didn't explicitly test).
- AC #5 (tapping calls `.prompt()`) → Task 3.

**Placeholder scan:** none — every step has literal code and literal commands.

**Type consistency:** `captureInstallPrompt` returns `{ getEvent: () => Event | null; isStandalone: () => boolean }` in both Task 2 (producer) and Task 3 (consumer) — matches.
