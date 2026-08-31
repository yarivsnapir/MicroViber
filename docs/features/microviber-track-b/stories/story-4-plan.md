# Transcript Link Handling — Local vs External Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify markdown links in the transcript as local (file/dev-server) vs external, and route local links into the existing Web pane instead of navigating away.

**Architecture:** A pure classification function (`classifyLink`) decides `localfile` / `devserver` / `external` for a given href + originating session cwd. `SafeMarkdown` gains an `a` component override that calls it: external links render as plain `target="_blank"` anchors (unchanged behavior); local links render an anchor whose `onClick` calls `preventDefault()` and forwards to `WebPane.tsx`'s already-shipped `navigateWebPane()`. `Transcript.tsx` and `App.tsx` thread the session's `cwd` down to `SafeMarkdown` so relative paths resolve correctly.

**Tech Stack:** Vite + React 19 + Tailwind 4, TypeScript strict mode, vitest (`@vitest-environment jsdom` pragma for DOM tests), `@testing-library/react`.

## Global Constraints

- Full quality gate before any commit that isn't mid-task: `cd /Users/yariv_s/Harness-2/microviber && npm run typecheck && npm run lint && npm test` (per-task steps below use the faster `npx vitest run <file>` from `pwa/`, but the last task in this plan runs the full gate).
- `WebPane.tsx`'s `navigateWebPane(target: Target): void` already exists and is NOT touched by this plan — `Target` is not exported, so callers pass a structurally-matching object literal (`{ kind: 'devserver', port, path }` or `{ kind: 'localfile', path }`), not an imported type.
- `App.tsx`'s `<WebPane .../>` wiring (activeSessionCwd, pane switch) already exists from story microviber-track-b-3 — do not modify it.
- No new dependencies.

---

## Task 1: `link-classify.ts` — classification function

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

describe('classifyLink (story microviber-track-b-4, spec §5)', () => {
  it('classifies an http://localhost:<port> link as devserver, preserving the path', () => {
    expect(classifyLink('http://localhost:9005/scenarios/42', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/scenarios/42' });
  });
  it('classifies https://localhost too — scheme does not matter', () => {
    expect(classifyLink('https://localhost:9005/', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/' });
  });
  it('classifies 127.0.0.1 the same as localhost', () => {
    expect(classifyLink('http://127.0.0.1:9008/health', '/proj')).toEqual({ kind: 'devserver', port: 9008, path: '/health' });
  });
  it('defaults devserver path to "/" when the URL has no trailing path', () => {
    expect(classifyLink('http://localhost:9005', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/' });
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
  it('resolves a relative path against sessionCwd even when sessionCwd has a trailing slash', () => {
    expect(classifyLink('docs/spec.md', '/proj/')).toEqual({ kind: 'localfile', path: '/proj/docs/spec.md' });
  });
  it('classifies a real external URL as external', () => {
    expect(classifyLink('https://github.com/yarivsnapir/MicroViber/pull/1', '/proj')).toEqual({ kind: 'external', href: 'https://github.com/yarivsnapir/MicroViber/pull/1' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/link-classify.test.ts`
Expected: FAIL — `../src/lib/link-classify.js` module not found

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
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/yariv_s/Harness-2/microviber && npm run typecheck --workspace pwa
git add pwa/src/lib/link-classify.ts pwa/test/link-classify.test.ts
git commit -m "feat(pwa): add local-vs-external link classification (story microviber-track-b-4, spec §5)"
```

---

## Task 2: `SafeMarkdown` — route local links to the Web pane, external links unchanged

**Files:**
- Modify: `pwa/src/lib/markdown.tsx`
- Test: `pwa/test/transcript-links.test.tsx` (new)
- Not modified, but re-run as a regression check: `pwa/test/markdown-safety.test.tsx` (its 4 existing calls omit `sessionCwd` entirely and must keep compiling/passing unchanged)

**Interfaces:**
- Consumes: `classifyLink` (Task 1), `navigateWebPane` (already exported by `pwa/src/components/WebPane.tsx`).
- Produces: `SafeMarkdown({ children, sessionCwd })` — `sessionCwd` is optional, defaulting to `''`, so the 4 pre-existing `markdown-safety.test.tsx` calls (which only exercise T7 script/HTML/URL sanitization, not link routing) keep compiling and passing unchanged without needing a cwd.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// pwa/test/transcript-links.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { SafeMarkdown } from '../src/lib/markdown.js';

afterEach(cleanup);

describe('SafeMarkdown link routing (story microviber-track-b-4, spec §5)', () => {
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
    const notPrevented = fireEvent.click(a);
    expect(notPrevented).toBe(false); // preventDefault() was called, per @testing-library/react's fireEvent return
  });

  it('a devserver link is intercepted the same way', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[app](http://localhost:9005/scenarios/42)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'app' });
    expect(a.getAttribute('target')).toBeNull();
    const notPrevented = fireEvent.click(a);
    expect(notPrevented).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx`
Expected: FAIL — `SafeMarkdown` doesn't accept a `sessionCwd` prop yet / links render with default react-markdown anchor behavior, not the target/rel assertions above

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
 * and javascript: URLs are stripped by the default URL transform. This is the
 * T7 defense — rendering transcripts IS the product, and transcript content is
 * arbitrary model output, source code, and scraped web text.
 *
 * Story microviber-track-b-4 (spec §5): links are additionally classified
 * local vs external at render time — local links route into the Web pane
 * instead of navigating away. `sessionCwd` defaults to '' so callers that
 * only render fixed (non-relative-path) content don't need to supply one.
 */
export function SafeMarkdown({ children, sessionCwd = '' }: { children: string; sessionCwd?: string }): ReactElement {
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

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx test/markdown-safety.test.tsx`
Expected: PASS (3 new tests + all 4 pre-existing `markdown-safety.test.tsx` tests still green — none of them contain a relative bare-path or devserver link, so the new `a` override doesn't change their assertions)

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/yariv_s/Harness-2/microviber && npm run typecheck --workspace pwa
git add pwa/src/lib/markdown.tsx pwa/test/transcript-links.test.tsx
git commit -m "feat(pwa): route SafeMarkdown local links to the Web pane, external links unchanged (story microviber-track-b-4, spec §5)"
```

---

## Task 3: Thread `sessionCwd` through `Transcript.tsx` and `App.tsx`

**Files:**
- Modify: `pwa/src/components/Transcript.tsx`
- Modify: `pwa/src/App.tsx:178`
- Test: extend `pwa/test/transcript-links.test.tsx`

**Interfaces:**
- Consumes: `SafeMarkdown` with `sessionCwd` prop (Task 2).
- Produces: `Transcript({ events, sessionId, sessionCwd })` — `sessionCwd: string` is a required prop (App.tsx already has `current?.cwd ?? ''` available from `SessionSummary`, so there's no caller that can't supply it).

- [ ] **Step 1: Write the failing test**

Append to `pwa/test/transcript-links.test.tsx`:

```tsx
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

describe('Transcript threads sessionCwd into SafeMarkdown (story microviber-track-b-4)', () => {
  it('a relative link in an assistant message resolves against the session cwd, not the browser default', () => {
    const events: TranscriptEvent[] = [{ kind: 'assistant', at: '2026-01-01T00:00:00Z', text: '[spec](docs/spec.md)' }];
    render(<Transcript events={events} sessionId="s1" sessionCwd="/proj/studio" />);
    const a = screen.getByRole('link', { name: 'spec' });
    // Not classified as external (no target=_blank) — proves classifyLink ran with a real cwd, not ''.
    expect(a.getAttribute('target')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx`
Expected: FAIL — `Transcript` does not accept a `sessionCwd` prop (TypeScript error) / `SafeMarkdown` inside it renders with `sessionCwd=''` regardless of what's passed

- [ ] **Step 3: Implement**

In `pwa/src/components/Transcript.tsx`, add `sessionCwd` to the component's props and thread it down to `EventRow` and `SafeMarkdown`:

```tsx
export function Transcript({ events, sessionId, sessionCwd }: { events: TranscriptEvent[]; sessionId: string | null; sessionCwd: string }): ReactElement {
  // ...unchanged body (useEffect/useRef scroll logic stays as-is)...
  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-[16.5px] leading-relaxed">
      {events.map((e, i) => <EventRow key={i} e={e} sessionCwd={sessionCwd} />)}
    </div>
  );
}

function EventRow({ e, sessionCwd }: { e: TranscriptEvent; sessionCwd: string }): ReactElement {
  switch (e.kind) {
    // ...user/tool/thinking/error cases unchanged...
    case 'assistant':
      return <Gutter><div className="prose-invert text-[16.5px]"><SafeMarkdown sessionCwd={sessionCwd}>{e.text}</SafeMarkdown></div></Gutter>;
  }
}
```

In `pwa/src/App.tsx`, update the call at line 178:

```tsx
: <Transcript events={events} sessionId={selected} sessionCwd={current?.cwd ?? ''} />}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd pwa && npx vitest run test/transcript-links.test.tsx`
Expected: PASS (4 tests total in the file)

- [ ] **Step 5: Run the full PWA suite (Transcript.tsx and App.tsx signatures changed), typecheck, commit**

```bash
cd pwa && npx vitest run
cd /Users/yariv_s/Harness-2/microviber && npm run typecheck --workspace pwa
git add pwa/src/components/Transcript.tsx pwa/src/App.tsx pwa/test/transcript-links.test.tsx
git commit -m "feat(pwa): thread sessionCwd through Transcript into SafeMarkdown (story microviber-track-b-4, spec §5)"
```

---

## Task 4: Full quality gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate from the repo root**

```bash
cd /Users/yariv_s/Harness-2/microviber && npm run typecheck && npm run lint && npm test
```

Expected: all three pass — 0 typecheck errors, 0 lint errors, full test suite green (including the new `link-classify.test.ts` and `transcript-links.test.tsx`, and the untouched `markdown-safety.test.tsx`, `webpane.test.tsx`).

- [ ] **Step 2: No commit needed for this task** — it's a verification-only checkpoint; Task 3's commit already captured the last code change.
