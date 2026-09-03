// Wire DTOs mirrored from daemon/src (the fence forbids importing across).
// SYNC: keep in step with daemon/src/domain/registry.ts + tail.ts + prompt-lifecycle.ts.
export type Host = 'vscode' | 'terminal';
export type SessionState = 'working' | 'idle' | 'stale' | 'awaiting-input';
export type SessionMode = 'readonly' | 'owned';

export interface SessionSummary {
  id: string; title: string; folder: string; cwd: string;
  host: Host; writable: boolean; state: SessionState;
  lastActivityAt: string | null; lastPrompt: string | null; lastPromptAt: string | null; mode: SessionMode;
  /** Was missing here despite existing on the daemon's SessionSummary since Track A — fixed alongside this feature. */
  takenOver: boolean;
  /**
   * Dev servers resolved for this session — cwd itself plus any immediate
   * child directory that independently resolves its own port (spec §3);
   * empty when none resolve. A session's cwd is often a multi-project
   * workspace root, so this is a list, not a single nullable port.
   */
  devServerPorts: { folder: string; port: number }[];
}

export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | { kind: 'askUserQuestion'; at: string; toolUseId: string; resolved: boolean; selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[] };

export type PromptStateName = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';
export interface PromptRecord {
  id: string; sessionId: string; text: string; toolUseId?: string; state: PromptStateName; sentAt: number; observedAt?: string;
}
