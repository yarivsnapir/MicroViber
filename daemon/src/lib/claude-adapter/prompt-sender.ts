/**
 * The one interface the write path implements. The API layer holds a
 * PromptSender per session and never knows the daemon internals behind it.
 * Read (registry/tail) is always on and shared; write exists only for a
 * taken-over session ('owned') — a session with no owned handle has no
 * PromptSender at all and is rejected with FORBIDDEN before ever reaching
 * one (services.ts's sendPrompt, spec §3.2 hard rule). 'readonly' mode
 * appears only in the audit log, as the outcome of that rejected attempt.
 */
export type SendOutcome =
  | { ok: true }
  | { ok: false; code: 'EXTERNAL_SERVICE_ERROR'; message: string; retryable: boolean };

export interface PromptSender {
  readonly mode: 'readonly' | 'owned';
  send(prompt: string, signal?: AbortSignal): Promise<SendOutcome>;
  /** Answers a pending AskUserQuestion with a real tool_result frame (spec §6) — see toolResultFrame(). */
  sendAnswer(toolUseId: string, label: string, signal?: AbortSignal): Promise<SendOutcome>;
}

/** A plain stream-json user turn — the documented transport, no wrapper (findings F11). */
export function userFrame(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}

/** A tool_result frame answering a pending AskUserQuestion — the mechanism
 * verified by architecture-spec.md §2's F16 finding. Same one-line-JSON
 * framing as userFrame(), just a tool_result content block instead of text. */
export function toolResultFrame(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}
