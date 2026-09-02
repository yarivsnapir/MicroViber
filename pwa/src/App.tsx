import { useEffect, useState, useCallback, useRef, useMemo, type ReactElement } from 'react';
import { createApi } from './lib/api.js';
import { captureTokenFromUrl } from './lib/auth.js';
import type { SessionSummary, TranscriptEvent } from './lib/types.js';
import type { PromptState } from './lib/prompt-display.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { SessionPicker } from './components/SessionPicker.js';
import { CaretButton } from './components/CaretButton.js';
import { EmptyState, Banner, PaneSwitch, PairingScreen, TranscriptLoading } from './components/states.js';
import { WebPane, subscribeWebPaneRequests } from './components/WebPane.js';
import { TitleBar } from './components/TitleBar.js';
import { firstSentence } from './lib/text.js';

const BASE = location.origin;
const STATE_DOT: Record<string, string> = { working: 'bg-amber-400', idle: 'bg-emerald-400', stale: 'bg-zinc-600' };

export function App(): ReactElement {
  const [token] = useState(() => captureTokenFromUrl(location, (h) => history.replaceState(null, '', location.pathname + h)));
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState<PromptState | null>(null);
  const [connected, setConnected] = useState(true);
  const [loadingTranscript, setLoadingTranscript] = useState(true);
  const [takingOver, setTakingOver] = useState(false);
  const [handingBack, setHandingBack] = useState(false);
  const [pane, setPane] = useState<'claude' | 'web'>('claude');
  // A transcript link tap (SafeMarkdown -> navigateWebPane) must actually
  // bring the Web pane into view, not just buffer a target for whenever the
  // user happens to switch tabs themselves (final whole-branch review,
  // story microviber-track-b-4, Finding 1 — CRITICAL).
  useEffect(() => subscribeWebPaneRequests(() => setPane('web')), []);
  // A sent prompt still awaiting the queued -> accepted transition (see
  // prompt-lifecycle.ts). Tracked as state (not a one-shot retry loop) so
  // the recheck below keeps going for as long as the record can legitimately
  // stay 'queued' server-side (up to 10 minutes for a busy session), instead
  // of giving up after a fixed window and leaving `status` stuck stale.
  const [pendingPrompt, setPendingPrompt] = useState<{ sessionId: string; text: string; key: string } | null>(null);
  // Tracks which session we've already gotten a first transcript response
  // for, so the spinner shows only on the initial load, not every 2.5s poll.
  const loadedForRef = useRef<string | null>(null);
  // Lets an in-flight send() status poll (below) tell whether the user has
  // since switched sessions, so a late response can't overwrite `status`
  // for the wrong session.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Stable identity across renders — token never changes post-mount, but
  // without useMemo this was a fresh object every render, and as a dependency
  // of the polling effects below that tore down + rebuilt them on every
  // unrelated re-render (status updates, the 4s session-list refresh, etc.).
  // Under real network latency, a fetch could get cancelled by the next
  // teardown before it ever landed — a livelock where the transcript never
  // updates until a full reload gives it one clear run.
  const api = useMemo(() => (token ? createApi(BASE, token) : null), [token]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { const s = await api.listSessions(); setSessions(s); setConnected(true); if (!selected && s[0]) setSelected(s[0].id); }
    catch { setConnected(false); }
  }, [api, selected]);

  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 4000); return () => clearInterval(t); }, [refresh]);

  useEffect(() => {
    if (!api || !selected) return;
    let stop = false;
    if (loadedForRef.current !== selected) setLoadingTranscript(true);
    const poll = () => {
      void api.getTranscript(selected)
        .then((t) => { if (stop) return; setEvents(t.events); loadedForRef.current = selected; setLoadingTranscript(false); })
        .catch(() => { if (stop) return; loadedForRef.current = selected; setLoadingTranscript(false); });
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [api, selected]);

  useEffect(() => {
    if (!api || !pendingPrompt) return;
    let stop = false;
    const check = () => {
      // Same idempotency-key + text safely returns the current record
      // instead of resubmitting.
      void api.sendPrompt(pendingPrompt.sessionId, pendingPrompt.text, pendingPrompt.key)
        .then((rec) => {
          if (stop) return;
          if (selectedRef.current === pendingPrompt.sessionId) setStatus(rec.state as PromptState);
          if (rec.state !== 'queued') setPendingPrompt(null);
        })
        .catch(() => { /* transient — try again next tick */ });
    };
    const t = setInterval(check, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [api, pendingPrompt]);

  if (!token) return <Shell><PairingScreen /></Shell>;

  const current = sessions.find((s) => s.id === selected) ?? null;

  const takeoverSession = async () => {
    if (!api || !selected) return;
    setTakingOver(true);
    let taken: { id: string; mode: 'owned' } | null = null;
    try {
      taken = await api.takeover(selected);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not take over the session.');
      setTakingOver(false);
      return;
    }
    setTakingOver(false);
    setSelected(taken.id); setEvents([]); setStatus(null); setPendingPrompt(null); setLoadingTranscript(true);
    // The daemon already flipped ownership — a follow-up refresh() failure
    // here does not mean the takeover failed, so it must not surface as one.
    // refresh() already swallows its own errors internally (sets
    // `connected: false` instead of throwing), but that's kept separate
    // from the takeover call's own try/catch on purpose: correctness here
    // shouldn't depend on refresh() never being changed to throw. The next
    // 4s poll retries and corrects any staleness.
    try { await refresh(); } catch { /* see above — never alert for this */ }
  };

  const handbackSession = async () => {
    if (!api || !selected) return;
    setHandingBack(true);
    try {
      await api.handback(selected);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not hand back the session.');
      setHandingBack(false);
      return;
    }
    setHandingBack(false);
    // Same reasoning as takeoverSession above: the daemon already released
    // ownership, so a refresh() hiccup must stay silent, not read as a
    // failed hand-back. The next 4s poll corrects any stale local state.
    try { await refresh(); } catch { /* see above — never alert for this */ }
  };

  const send = async (text: string) => {
    if (!api || !selected) return;
    const sessionId = selected;
    const key = crypto.randomUUID();
    setStatus('sending');
    let rec;
    try {
      rec = await api.sendPrompt(sessionId, text, key);
    } catch {
      if (selectedRef.current === sessionId) setStatus('failed');
      return;
    }
    if (selectedRef.current === sessionId) setStatus(rec.state as PromptState);
    // The initial POST only reports whether the write succeeded, not
    // whether the session actually picked the prompt up (state stays
    // 'queued' until then — see prompt-lifecycle.ts). Hand off to the
    // pendingPrompt effect above to keep checking for as long as it takes.
    if (rec.state === 'queued') setPendingPrompt({ sessionId, text, key });
  };

  return (
    <Shell>
      {!connected && <Banner tone="error">Disconnected — retrying…</Banner>}
      {current && !current.writable && <Banner tone="warn">Unrecognised Claude Code build — mirroring only, sending disabled.</Banner>}
      {pane === 'claude' && (
        <>
          {/* Session header + picker trigger: Claude-pane-only chrome (post-story-3
              bug report — rendering it above the pane switch leaked the session
              dropdown into the Web pane, which has its own address bar). */}
          <header className="border-b border-zinc-800 bg-zinc-900 px-4 pb-2.5 pt-3.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-[16.5px] font-semibold text-zinc-100">{current?.title ?? 'No session'}</span>
              <CaretButton open={pickerOpen} onClick={() => setPickerOpen((o) => !o)} />
            </div>
            {current && <div className="mt-1 flex items-center gap-1.5 font-mono text-[12.5px] text-zinc-500">
              <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[current.state]}`} />{current.folder} · {current.state}{current.mode === 'owned' ? ' · owned' : ''}
            </div>}
            {current?.lastPrompt && <div className="mt-0.5 truncate text-[12.5px] text-zinc-500">{firstSentence(current.lastPrompt)}</div>}
          </header>

          {/* Everything below the header (transcript/composer + the picker
              dropdown) lives in one `relative` box that starts exactly where
              the header ends, whatever the header's current height (0, 1, or
              2 extra lines) — so SessionPicker can anchor to the TOP of this
              box instead of a hardcoded pixel offset tied to header height.
              The scrim (`absolute inset-0` inside SessionPicker) dims this
              whole box, i.e. the transcript/composer, without ever covering
              the header or the CaretButton that opened it (final whole-branch
              review, story microviber-track-b-6, Finding 1). */}
          <div className="relative flex flex-1 flex-col">
            {sessions.length === 0 ? <EmptyState onRefresh={() => void refresh()} />
              : loadingTranscript && events.length === 0 ? <TranscriptLoading />
              : <Transcript events={events} sessionId={selected} sessionCwd={current?.cwd ?? ''} />}

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
                  This session has ended — its laptop process is no longer running. Taking over a dead session isn’t supported yet.
                </div>
              ) : (
                <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] leading-snug text-zinc-400">
                  Watching this session live — it’s still working. Wait until idle to take over and send prompts from here.
                </div>
              )
            )}

            <SessionPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              sessions={sessions}
              onPick={(id) => { setSelected(id); setEvents([]); setStatus(null); setPendingPrompt(null); setLoadingTranscript(true); setPickerOpen(false); }}
            />
          </div>
        </>
      )}
      {pane === 'web' && api && (
        <WebPane api={api} sessions={sessions} activeSessionCwd={current?.cwd ?? ''} />
      )}
      <PaneSwitch pane={pane} onChange={setPane} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="relative mx-auto flex h-dvh max-w-md flex-col bg-zinc-950 text-zinc-100">
      <TitleBar />
      {children}
    </div>
  );
}
