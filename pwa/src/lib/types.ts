// Wire DTOs mirrored from daemon/src (the fence forbids importing across).
// SYNC: keep in step with daemon/src/domain/registry.ts + tail.ts + prompt-lifecycle.ts.
export type Host = 'vscode' | 'terminal';
export type SessionState = 'working' | 'idle' | 'stale';
export type SessionMode = 'readonly' | 'owned';

export interface SessionSummary {
  id: string; title: string; folder: string; cwd: string;
  host: Host; writable: boolean; state: SessionState;
  lastActivityAt: string | null; lastPrompt: string | null; lastPromptAt: string | null; mode: SessionMode;
}

export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string };

export type PromptStateName = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';
export interface PromptRecord {
  id: string; sessionId: string; text: string; state: PromptStateName; sentAt: number; observedAt?: string;
}
