import { TranscriptLineSchema } from './schemas.js';

export interface TranscriptMeta {
  title: string | null;      // newest ai-title, else null
  lastPrompt: string | null; // newest last-prompt / user turn text, for title fallback
  lastPromptAt: string | null;   // timestamp of newest USER turn
  lastActivityAt: string | null; // timestamp of newest entry of any kind
}

/**
 * Scan raw transcript .jsonl text for the metadata the session list needs.
 * Cheap forward pass; tolerant of malformed/partial lines (skips them).
 * "lastPromptAt" is the newest USER turn specifically — a session can churn
 * tools for an hour after its last prompt, and the list sorts by "who I last
 * talked to" (spec §3).
 */
export function scanTranscriptMeta(jsonl: string): TranscriptMeta {
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let lastPromptAt: string | null = null;
  let lastActivityAt: string | null = null;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // partial trailing line or noise
    }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;

    if (e.type === 'ai-title') title = e.aiTitle;
    else if (e.type === 'last-prompt') lastPrompt = e.lastPrompt;

    const ts = 'timestamp' in e ? e.timestamp : undefined;
    if (ts) lastActivityAt = ts;
    if (e.type === 'user') {
      if (ts) lastPromptAt = ts;
      const text = extractText(e.message.content);
      if (text) lastPrompt = text;
    }
  }
  return { title, lastPrompt, lastPromptAt, lastActivityAt };
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text);
    if (parts.length) return parts.join(' ');
  }
  return null;
}
