import { useEffect, useState, useCallback, type ReactElement } from 'react';
import { createApi } from './lib/api.js';
import { captureTokenFromUrl } from './lib/auth.js';
import type { SessionSummary, TranscriptEvent } from './lib/types.js';
import type { PromptState } from './lib/prompt-display.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { SessionPicker } from './components/SessionPicker.js';
import { EmptyState, Banner, PaneSwitch, PairingScreen } from './components/states.js';

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

  const api = token ? createApi(BASE, token) : null;

  const refresh = useCallback(async () => {
    if (!api) return;
    try { const s = await api.listSessions(); setSessions(s); setConnected(true); if (!selected && s[0]) setSelected(s[0].id); }
    catch { setConnected(false); }
  }, [api, selected]);

  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 4000); return () => clearInterval(t); }, [refresh]);

  useEffect(() => {
    if (!api || !selected) return;
    let stop = false;
    const poll = () => { void api.getTranscript(selected).then((t) => { if (!stop) setEvents(t.events); }).catch(() => {}); };
    poll();
    const t = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [api, selected]);

  if (!token) return <Shell><PairingScreen /></Shell>;

  const current = sessions.find((s) => s.id === selected) ?? null;

  const startOwned = async () => {
    if (!api) return;
    const cwd = window.prompt('Folder to run the phone session in (full path):', current?.cwd ?? '');
    if (!cwd) return;
    const name = 'phone-' + String(Date.now()).slice(-4);
    setPickerOpen(false);
    try {
      const { id } = await api.startOwned(cwd, name);
      await refresh();
      setSelected(id); setEvents([]); setStatus(null);
    } catch { window.alert('Could not start the session. Check the folder path.'); }
  };

  const send = async (text: string) => {
    if (!api || !selected) return;
    setStatus('sending');
    try {
      const rec = await api.sendPrompt(selected, text, crypto.randomUUID());
      setStatus(rec.state as PromptState);
    } catch { setStatus('failed'); }
  };

  return (
    <Shell>
      {!connected && <Banner tone="error">Disconnected — retrying…</Banner>}
      {current && !current.writable && <Banner tone="warn">Unrecognised Claude Code build — mirroring only, sending disabled.</Banner>}
      <header className="border-b border-zinc-800 bg-zinc-900 px-4 pb-2.5 pt-3.5" onClick={() => setPickerOpen(true)}>
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-[16.5px] font-semibold text-zinc-100">{current?.title ?? 'No session'}</span>
          <span className="text-[12.5px] text-zinc-500">▾</span>
        </div>
        {current && <div className="mt-1 flex items-center gap-1.5 font-mono text-[12.5px] text-zinc-500">
          <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[current.state]}`} />{current.folder} · {current.state}{current.mode === 'owned' ? ' · owned' : ''}
        </div>}
      </header>

      {sessions.length === 0 ? <EmptyState onRefresh={() => void refresh()} /> : <Transcript events={events} />}

      {current && current.writable && current.mode === 'owned' && <Composer mode={current.mode} status={status} onSend={(t) => void send(t)} />}
      {current && current.mode === 'readonly' && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] leading-snug text-zinc-400">
          Watching this session live. Sending to existing VS&nbsp;Code sessions isn’t available yet — tap the session name → <span className="text-amber-400 font-semibold">＋ start phone session</span> to send prompts now.
        </div>
      )}
      <PaneSwitch />

      {pickerOpen && <SessionPicker
        sessions={sessions}
        onPick={(id) => { setSelected(id); setEvents([]); setStatus(null); setPickerOpen(false); }}
        onStartOwned={() => void startOwned()}
        onClose={() => setPickerOpen(false)}
      />}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return <div className="relative mx-auto flex h-dvh max-w-md flex-col bg-zinc-950 text-zinc-100">{children}</div>;
}
