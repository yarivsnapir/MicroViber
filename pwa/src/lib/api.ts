import type { SessionSummary, TranscriptEvent, PromptRecord } from './types.js';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }; // header only, never query/body (T8)
}

/** r.statusText is "" for HTTP/2 responses in Chrome — never surface a blank error message. */
function fallbackMessage(r: Response): string {
  return r.statusText || `request failed (${r.status})`;
}

export function createApi(baseUrl: string, token: string) {
  async function get<T>(path: string): Promise<T> {
    const r = await fetch(baseUrl + path, { headers: authHeaders(token) });
    const body = await r.json();
    if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
    return body.data as T;
  }

  return {
    listSessions: () => get<SessionSummary[]>('/api/sessions'),
    getTranscript: (id: string) => get<{ events: TranscriptEvent[]; nextCursor: string | null }>(`/api/sessions/${encodeURIComponent(id)}/transcript`),
    sendPrompt: async (id: string, text: string, idemKey: string, toolUseId?: string): Promise<PromptRecord> => {
      const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify({ text, ...(toolUseId ? { toolUseId } : {}) }),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
      return body.data as PromptRecord;
    },
    /** Take over an existing idle session so the phone can send to it (spec §3.2 write path). */
    takeover: async (id: string): Promise<{ id: string; mode: 'owned' }> => {
      const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/takeover`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
      return body.data as { id: string; mode: 'owned' };
    },
    /** Return a taken-over session to the laptop (readonly mirror), idempotently (spec §3.2). */
    handback: async (id: string): Promise<{ id: string; mode: 'readonly' }> => {
      const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/handback`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const body = await r.json();
      if (!r.ok || body.success === false) throw new ApiError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? fallbackMessage(r));
      return body.data as { id: string; mode: 'readonly' };
    },
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
        /** Live event stream for a session over WS (bearer in a subprotocol-free query-less upgrade uses header via cookie? -> we pass token as Sec-WebSocket-Protocol). */
    openStream: (id: string, onEvent: (e: TranscriptEvent) => void): WebSocket => {
      const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?session=${encodeURIComponent(id)}`;
      const ws = new WebSocket(wsUrl, ['bearer', token]);
      ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data as string) as TranscriptEvent); } catch { /* ignore */ } };
      return ws;
    },
  };
}
export type Api = ReturnType<typeof createApi>;
