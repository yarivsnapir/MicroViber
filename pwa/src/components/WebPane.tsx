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
