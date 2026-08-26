/**
 * The one interface the write path implements. The API layer holds a
 * PromptSender per session and never knows the daemon internals behind it.
 * Read (registry/tail) is always on and shared; write exists only for a
 * taken-over session ('owned') — everything else is 'readonly' and refuses
 * to send until a deliberate takeover (spec §3.2 hard rule).
 */
export type SendOutcome =
  | { ok: true }
  | { ok: false; code: 'EXTERNAL_SERVICE_ERROR'; message: string; retryable: boolean };

export interface PromptSender {
  readonly mode: 'readonly' | 'owned';
  send(prompt: string, signal?: AbortSignal): Promise<SendOutcome>;
}

/** A plain stream-json user turn — the documented transport, no wrapper (findings F11). */
export function userFrame(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}
