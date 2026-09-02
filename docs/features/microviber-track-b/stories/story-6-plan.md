# Session Picker Dropdown + Folder Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SessionPicker`'s always-mounted bottom sheet with a top-anchored dropdown panel triggered by the shared `CaretButton`, defaulting to a cross-folder "Recent" view (capped at 5, newest-prompt-first), with an optional folder-grouped browse mode and drill-down for users running sessions across multiple project folders.

**Architecture:** `SessionPicker` moves from `{ sessions, onPick, onClose }` (rendered only while a bottom sheet was open) to `{ open, onOpenChange, sessions, onPick }` (always mounted, returns `null` while closed — same pattern the Web pane's address-bar dropdown already uses). Internally it holds a small view-state machine (`{ kind: 'recent' } | { kind: 'folders' } | { kind: 'folder'; folder: string }`) so "Browse by folder" and drill-down swap content in place inside the same panel rather than opening new sheets. `App.tsx`'s header trigger switches from a plain `⌄` circle to the shared `CaretButton` component (Task 8 of the feature plan, delivered in story-3).

**Tech Stack:** Vite + React 19 + Tailwind 4, Vitest + Testing Library (jsdom for component/DOM tests).

## Global Constraints

- Do not duplicate `CaretButton` — import it from wherever story-3 placed it (already merged); this plan only consumes it.
- `SessionPicker`'s exported prop shape must not change again between Task 1 and Task 2 — Task 2 is internal state only, per the story's Technical Notes.
- The Recent view's sort key (newest `lastPromptAt` first) is unchanged from the original bottom-sheet picker — do not re-derive it.
- `npm run typecheck && npm run lint && npm test` (run from `microviber/`) must pass before any commit.

---

## Task 1: `SessionPicker.tsx` → dropdown panel, Recent default view

**Files:**
- Modify: `pwa/src/components/SessionPicker.tsx`, `pwa/src/App.tsx`
- Test: `pwa/test/session-picker.test.tsx` (new)

**Interfaces:**
- Consumes: `CaretButton` (from story-3).
- Produces: `export function SessionPicker({ open, onOpenChange, sessions, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; sessions: SessionSummary[]; onPick: (id: string) => void }): ReactElement | null` — **signature changes** from the current `{ sessions, onPick, onClose }`. Task 2 extends this same component with folder-browsing state — do not restructure the top-level props again there.

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
  return { id: 'a', title: 'A', folder: 'studio', cwd: '/proj/studio', host: 'terminal', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-01-01T00:00:02Z', mode: 'readonly', takenOver: false, devServerPorts: [], ...over };
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

const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };
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
              <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state} · {s.mode}</span>
              {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
            </span>
            {!s.writable && <span className="mt-0.5 shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-zinc-500">read-only</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
```

In `App.tsx`, replace `pickerOpen`/`setPickerOpen` boolean toggling with the new prop shape, and swap the header's plain `⌄` circle span for `<CaretButton open={pickerOpen} onClick={() => setPickerOpen((o) => !o)} />` (import `CaretButton` from its story-3 location). Update the render call:

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

## Task 2: `SessionPicker.tsx` → Browse-by-folder + drill-down

**Files:**
- Modify: `pwa/src/components/SessionPicker.tsx`
- Test: extend `pwa/test/session-picker.test.tsx`

**Interfaces:**
- No prop-shape change from Task 1 — internal state only (`'recent' | 'folders' | { folder: string }`).

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
// pwa/src/components/SessionPicker.tsx (revise the component body; keep the exported signature from Task 1 unchanged)
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
        <span className="mt-1 block font-mono text-[12.5px] text-zinc-500">{s.folder} · {s.state} · {s.mode}</span>
        {s.lastPrompt && <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{firstSentence(s.lastPrompt)}</span>}
      </span>
      {!s.writable && <span className="mt-0.5 shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-zinc-500">read-only</span>}
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
            : inFolder.some((s) => s.state === 'idle') ? STATE_DOT.idle
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

## Task 3: Full quality gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `cd microviber && npm run typecheck && npm run lint && npm test`
Expected: all three exit 0; no pre-existing test regressed.

- [ ] **Step 2: Commit (only if the gate required fixes)**

If Step 1 is clean with no changes needed, skip this — Task 2's commit already leaves the tree clean. If lint/typecheck required touch-ups, commit them:

```bash
cd microviber && git add -A
git commit -m "chore(pwa): satisfy lint/typecheck after SessionPicker dropdown rewrite"
```

---

## Self-Review

**Spec coverage:**
- AC #1 (shared `CaretButton` trigger, top-anchored dropdown, not a bottom sheet) → Task 1 (`App.tsx` trigger swap + panel positioning).
- AC #2 (Recent default view, 5-cap, cross-folder, unchanged sort key, folder name inline) → Task 1.
- AC #3 ("Browse by folder ›" only with >1 distinct folder; swaps in place to folder-grouped list with count + aggregated state dot) → Task 1 (visibility condition) + Task 2 (folder-grouped list + dot logic).
- AC #4 (drilling into a folder; "‹ Projects" and "‹ Recent" back rows) → Task 2.
- AC #5 (tapping a session row calls `onPick` and closes the panel in any view) → Task 1 (`Recent` view) + Task 2 (`pick()` used by folder-drill-down `Row`, and closes via `onPick`'s caller in `App.tsx` setting `pickerOpen(false)`).

**Placeholder scan:** none — every step has literal code and literal commands.

**Type consistency:** `SessionPicker`'s exported prop shape (`{ open, onOpenChange, sessions, onPick }`) is identical between Task 1 (producer) and Task 2 (revises body only, signature unchanged) — matches. `View` union (`'recent' | 'folders' | { folder: string }`) is internal-only, not exposed across the two tasks' interfaces.
