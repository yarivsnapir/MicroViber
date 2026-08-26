import { TranscriptLineSchema } from './schemas.js';

/** The normalized event stream the rest of MicroViber consumes (spec §5). */
export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string };


/** Normalize one raw .jsonl line to a TranscriptEvent, or null if unrenderable. */
export function normalizeLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = TranscriptLineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  if (e.type !== 'user' && e.type !== 'assistant') return null;

  const at = e.timestamp ?? '';
  const blocks = normalizeContent(e.message.content);

  if (e.type === 'user') {
    return { kind: 'user', at, text: blocks.text ?? '', injected: false };
  }
  // assistant: prefer a tool_use collapse, else text
  if (blocks.tool) {
    return { kind: 'tool', at, name: blocks.tool.name, summary: blocks.tool.summary };
  }
  return { kind: 'assistant', at, text: blocks.text ?? '' };
}

interface NormalizedContent {
  text?: string;
  tool?: { name: string; summary: string };
}

function normalizeContent(content: unknown): NormalizedContent {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  let tool: { name: string; summary: string } | undefined;
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; name?: string; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.name === 'string') {
      tool = { name: block.name, summary: summarizeToolInput(block.input) };
    }
  }
  const out: NormalizedContent = {};
  if (texts.length) out.text = texts.join(' ');
  if (tool) out.tool = tool;
  return out;
}

function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const v = o[key];
    if (typeof v === 'string' && v) return v.length > 120 ? `${v.slice(0, 119)}…` : v;
  }
  return '';
}

/**
 * Parse an appended chunk of a transcript. Emits events for every COMPLETE
 * line; returns any partial trailing line (no newline yet) as `remainder`,
 * to be prepended to the next chunk. This is how the file-watcher tolerates
 * reading mid-write (spec §5) without ever throwing on a half-written line.
 */
export function parseChunk(chunk: string): { events: TranscriptEvent[]; remainder: string } {
  const events: TranscriptEvent[] = [];
  const lastNl = chunk.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : chunk.slice(0, lastNl);
  const remainder = lastNl === -1 ? chunk : chunk.slice(lastNl + 1);
  if (complete) {
    for (const line of complete.split('\n')) {
      const ev = normalizeLine(line);
      if (ev) events.push(ev);
    }
  }
  return { events, remainder };
}
