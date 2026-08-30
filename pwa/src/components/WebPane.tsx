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

// The webpane CONTENT origin (spec T15, redesigned in this story): the same
// daemon served on a second tailscale HTTPS port. Framed dev-server content
// loads from this origin with allow-same-origin, so real apps get working
// storage/fetch/cookies — while remaining a DIFFERENT origin from this
// control plane, so framed code can never reach the PWA's bearer token. The
// daemon routes every path on this origin to the mv_webpane cookie's bound
// port (the cookie is the routing key), which is also what makes a framed
// app's absolute-path requests (/, /_next/*, its own /api/*) and redirects
// just work. Port kept in sync with INSTALL.md's `tailscale serve --https=8443`
// step and the daemon's MV_WEBPANE_CONTENT_PORT default.
const WEBPANE_CONTENT_PORT = 8443;
function contentOrigin(): string {
  return `https://${location.hostname}:${WEBPANE_CONTENT_PORT}`;
}

function targetLabel(t: Target): string {
  return t.kind === 'devserver' ? `localhost:${t.port}${t.path}` : t.path;
}
function targetSrc(t: Target): string {
  return t.kind === 'devserver' ? `${contentOrigin()}${t.path}` : `/api/webpane/localfile?path=${encodeURIComponent(t.path)}`;
}
// Devserver frames get allow-same-origin: their isolation comes from the
// separate content ORIGIN above, not from an opaque origin — an opaque
// origin bans storage/fetch-credentials outright, which broke every real
// app (Firebase auth throws SecurityError on localStorage). Localfile frames
// keep the opaque-origin sandbox: they load from THIS origin, so
// allow-same-origin here would hand an arbitrary local file same-origin
// access to the control plane (and the daemon additionally serves them with
// a `CSP: sandbox allow-scripts` header as the server-side backstop).
function targetSandbox(t: Target): string {
  return t.kind === 'devserver' ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts allow-forms';
}

// Module-level target setter so Transcript.tsx (story microviber-track-b-4) can
// drive navigation without prop-drilling the whole session tree through
// App.tsx. WebPane is unmounted whenever the Claude pane is active (see
// App.tsx's `{pane === 'web' && api && <WebPane .../>}`) — that's the default
// state, not a rare edge case — so a call made while the Claude pane is
// showing has no live subscriber. `pendingTarget` buffers exactly one such
// call so the next WebPane mount applies it instead of silently dropping it.
let externalNavigate: ((t: Target) => void) | null = null;
let pendingTarget: Target | null = null;
export function navigateWebPane(target: Target): void {
  if (externalNavigate) externalNavigate(target);
  else pendingTarget = target;
}

export function WebPane({ api, sessions, activeSessionCwd: _activeSessionCwd }: { api: Api; sessions: SessionSummary[]; activeSessionCwd: string }): ReactElement {
  const [current, setCurrent] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Target[]>(() => loadRecent());

  // Dedupe globally by folder across ALL sessions' devServerPorts, not per-session:
  // two workspace-root sessions can each independently resolve the same
  // subproject (e.g. both resolve "studio"), and a single session's cwd can
  // itself resolve several (a multi-project workspace root).
  const devServers = Array.from(
    new Map(sessions.flatMap((s) => s.devServerPorts).map((r) => [r.folder, r])).values(),
  );

  const [pathDraft, setPathDraft] = useState('/');
  useEffect(() => { if (current?.kind === 'devserver') setPathDraft(current.path); }, [current]);

  const go = async (t: Target) => {
    try {
      await api.mintWebpaneToken(t.kind === 'devserver' ? { kind: 'devserver', port: t.port } : { kind: 'localfile', path: t.path });
    } catch (err) {
      // Mint failed (e.g. the port left the live allowlist, the file vanished,
      // or a network error) — leave `current` untouched (never set it
      // optimistically before mint resolves) and surface the failure the same
      // way App.tsx's takeoverSession/handbackSession do.
      window.alert(err instanceof Error ? err.message : 'Could not open that target.');
      setOpen(false);
      return;
    }
    setCurrent(t);
    pushRecent(t);
    saveLast(t);
    setRecent(loadRecent());
    setOpen(false);
  };

  useEffect(() => {
    externalNavigate = (t) => { void go(t); };
    const restoreTarget = pendingTarget ?? loadLast();
    pendingTarget = null;
    if (restoreTarget) void go(restoreTarget);
    return () => { externalNavigate = null; };
  }, []);

  // Path-only editing within the current dev server (port stays fixed). No
  // re-mint needed: the daemon's mv_webpane cookie is scoped by {kind, port}
  // (see resourceFromUrl in api/app.ts), never by the exact path, so a
  // cookie already minted for this port authorizes any path under it.
  const navigateToPath = (rawPath: string) => {
    if (!current || current.kind !== 'devserver') return;
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const target: Target = { kind: 'devserver', port: current.port, path };
    setCurrent(target);
    pushRecent(target);
    saveLast(target);
    setRecent(loadRecent());
  };

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
        {current?.kind === 'devserver' ? (
          <div className="flex min-w-0 flex-1 items-center gap-0.5 font-mono text-[14px]">
            <span className="shrink-0 text-zinc-400">localhost:{current.port}</span>
            <input
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigateToPath(pathDraft); }}
              aria-label="path"
              className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none"
            />
          </div>
        ) : (
          <span className="flex-1 truncate font-mono text-[14px] text-zinc-100">
            {current ? targetLabel(current) : 'select a dev server'}
          </span>
        )}
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
              <span className="text-zinc-500">·</span>
              <span className="font-mono text-[13px] text-amber-400">localhost:{d.port}</span>
            </button>
          ))}
        </div>
      )}
      {current ? (
        // Isolation model (spec T15, see targetSandbox above): devserver
        // content is same-origin-enabled but on a SEPARATE origin; localfile
        // content stays opaque-origin on this one.
        <iframe title="web-pane-content" src={targetSrc(current)} sandbox={targetSandbox(current)} className="flex-1 border-0 bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-zinc-500">Pick a dev server above</div>
      )}
    </div>
  );
}
