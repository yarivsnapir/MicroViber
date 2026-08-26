import { createHash } from 'node:crypto';

export interface AuditEntry {
  sessionId: string;
  mode: 'readonly' | 'owned';
  clientId: string;
  prompt: string;      // hashed on record; the text is NEVER written (§16.4)
  outcome: string;
  requestId: string;
  at: string;
}

/**
 * Append-only local record of every injected prompt (spec §9.5). Stores a
 * SHA-256 of the prompt, never the text (§16.4 — no prompt content in logs).
 * This is what turns "I think nothing was sent" into knowing. The sink is
 * injected so it unit-tests without touching disk; production appends JSONL.
 */
export class AuditLog {
  constructor(private readonly append: (line: string) => void) {}

  record(entry: AuditEntry): void {
    const { prompt, ...rest } = entry;
    const line = JSON.stringify({
      ...rest,
      promptHash: createHash('sha256').update(prompt).digest('hex'),
    });
    this.append(line + '\n');
  }
}
