import type { PromptSender } from '../lib/claude-adapter/prompt-sender.js';

export type PromptStateName = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';

export interface PromptRecord {
  id: string;         // the Idempotency-Key doubles as the id (spec §5)
  sessionId: string;
  text: string;       // for an answer: the daemon-composed text (ask-user-question.ts composeAnswerText)
  /** Canonical answer body (domain/answer.ts canonicalAnswerBody), set only for answer records — replay matching only (spec §5.2 step 2). */
  answerBody?: string;
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

  /**
   * §16.2 idempotency, shared by submit() and services.sendPrompt's answer
   * path: an existing record for `key` is returned when the request is the
   * same one (same session; same answerBody for an answer; same text for a
   * plain prompt) and rejected otherwise. An answer replay compares ONLY the
   * canonical answerBody — the status poll re-POSTs the same body after the
   * pending question is gone, so recomposing the text is neither possible
   * nor needed. Kind mismatch (text vs answer under one key) is a mismatch.
   */
  findReplay(args: { key: string; sessionId: string; text?: string; answerBody?: string }): PromptRecord | undefined {
    const existing = this.byKey.get(args.key);
    if (!existing) return undefined;
    const sameKind = existing.answerBody === args.answerBody; // both undefined for text; equal strings for the same answer
    const sameText = args.answerBody !== undefined || existing.text === args.text;
    if (existing.sessionId !== args.sessionId || !sameKind || !sameText) {
      throw new ActionError('INVALID_INPUT', 'Idempotency-Key reused with a different prompt');
    }
    return existing;
  }

  async submit(args: {
    key: string;
    sessionId: string;
    text: string;
    sender: PromptSender;
    nowMs: number;
    answerBody?: string;
  }): Promise<PromptRecord> {
    const replay = this.findReplay({ key: args.key, sessionId: args.sessionId, text: args.text, ...(args.answerBody !== undefined ? { answerBody: args.answerBody } : {}) });
    if (replay) return replay;

    const rec: PromptRecord = {
      id: args.key,
      sessionId: args.sessionId,
      text: args.text,
      ...(args.answerBody !== undefined ? { answerBody: args.answerBody } : {}),
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

  /** Move long-unobserved queued prompts to expired (spec R3). */
  sweepExpired(nowMs: number): void {
    for (const rec of this.byKey.values()) {
      if (rec.state === 'queued' && nowMs - rec.sentAt > EXPIRE_AFTER_MS) {
        rec.state = 'expired';
      }
    }
  }
}
