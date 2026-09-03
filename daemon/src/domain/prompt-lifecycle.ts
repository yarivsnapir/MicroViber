import type { PromptSender } from '../lib/claude-adapter/prompt-sender.js';

export type PromptStateName = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';

export interface PromptRecord {
  id: string;         // the Idempotency-Key doubles as the id (spec §5)
  sessionId: string;
  text: string;
  toolUseId?: string;
  state: PromptStateName;
  sentAt: number;
  observedAt?: string;
}

export class ActionError extends Error {
  constructor(public code: 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

const EXPIRE_AFTER_MS = 10 * 60_000;

/**
 * Tracks the fate of every injected prompt. The load-bearing rule (spec F10,
 * and the false-failure bug the spec review caught): a prompt becomes
 * `accepted` ONLY when the tailer observes it in the transcript -- never
 * because the transport write returned. Until observed it stays `queued`;
 * after 10 min unobserved it `expired`.
 */
export class PromptLifecycle {
  private byKey = new Map<string, PromptRecord>();

  get(key: string): PromptRecord | undefined {
    return this.byKey.get(key);
  }

  async submit(args: {
    key: string;
    sessionId: string;
    text: string;
    sender: PromptSender;
    nowMs: number;
  }): Promise<PromptRecord> {
    const existing = this.byKey.get(args.key);
    if (existing) {
      // §16.2 idempotency: same key + same body -> original; different body -> reject.
      if (existing.text !== args.text || existing.sessionId !== args.sessionId) {
        throw new ActionError('INVALID_INPUT', 'Idempotency-Key reused with a different prompt');
      }
      return existing;
    }

    const rec: PromptRecord = {
      id: args.key,
      sessionId: args.sessionId,
      text: args.text,
      state: 'sending',
      sentAt: args.nowMs,
    };
    this.byKey.set(args.key, rec);

    const outcome = await args.sender.send(args.text);
    rec.state = outcome.ok ? 'queued' : 'failed';
    return rec;
  }

  /** The tailer calls this when it sees a user turn; matches a queued prompt by session+text. */
  observe(ev: { sessionId: string; text: string; atISO: string }): void {
    for (const rec of this.byKey.values()) {
      if (rec.state === 'queued' && rec.sessionId === ev.sessionId && rec.text === ev.text) {
        rec.state = 'accepted';
        rec.observedAt = ev.atISO;
        return;
      }
    }
  }

  async submitAnswer(args: {
    key: string;
    sessionId: string;
    toolUseId: string;
    label: string;
    sender: PromptSender;
    nowMs: number;
  }): Promise<PromptRecord> {
    const existing = this.byKey.get(args.key);
    if (existing) {
      // §16.2 idempotency: same key + same answer -> original; anything
      // different (toolUseId, session, or label) -> reject, same as submit().
      if (existing.toolUseId !== args.toolUseId || existing.sessionId !== args.sessionId || existing.text !== args.label) {
        throw new ActionError('INVALID_INPUT', 'Idempotency-Key reused with a different answer');
      }
      return existing;
    }

    const rec: PromptRecord = {
      id: args.key,
      sessionId: args.sessionId,
      text: args.label,
      toolUseId: args.toolUseId,
      state: 'sending',
      sentAt: args.nowMs,
    };
    this.byKey.set(args.key, rec);

    const outcome = await args.sender.sendAnswer(args.toolUseId, args.label);
    rec.state = outcome.ok ? 'queued' : 'failed';
    return rec;
  }

  /** The tailer calls this when tail.ts reports a pending AskUserQuestion just
   * resolved — matches a queued ANSWER by session+toolUseId, never by text
   * (a plain-text observation would never fire for a tool_result frame, since
   * tail.ts's resolution path drops the blank tool_result-only user bubble
   * from the emitted event stream entirely — see tail.ts's resolveAskUserQuestions). */
  observeAnswer(ev: { sessionId: string; toolUseId: string; atISO: string }): void {
    for (const rec of this.byKey.values()) {
      if (rec.state === 'queued' && rec.sessionId === ev.sessionId && rec.toolUseId === ev.toolUseId) {
        rec.state = 'accepted';
        rec.observedAt = ev.atISO;
        return;
      }
    }
  }

  /** Move long-unobserved queued prompts to expired (spec R3). */
  sweepExpired(nowMs: number): void {
    for (const rec of this.byKey.values()) {
      if (rec.state === 'queued' && nowMs - rec.sentAt > EXPIRE_AFTER_MS) {
        rec.state = 'expired';
      }
    }
  }
}
