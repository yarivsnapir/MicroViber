import { TranscriptLineSchema } from './schemas.js';
import { detectAskUserQuestion, isResolvingUserEntry, parseAnswerText } from './ask-user-question.js';

/** The normalized event stream the rest of MicroViber consumes (spec §5). */
export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; name: string; summary: string }
  | { kind: 'thinking'; at: string }
  | { kind: 'error'; at: string; message: string }
  | {
      kind: 'askUserQuestion';
      at: string;
      toolUseId: string;
      resolved: boolean;
      /** Present iff resolved. 'tool_result' = the laptop's answer stub; 'text' = a later human turn (spec §4.1). */
      resolvedBy?: 'tool_result' | 'text';
      selectedLabels?: string[];
      questions: { question: string; header: string; options: { label: string; description: string }[] }[];
    };


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

  if (e.type === 'user') {
    const blocks = normalizeContent(e.message.content);
    return { kind: 'user', at, text: blocks.text ?? '', injected: false };
  }

  // assistant: an AskUserQuestion tool_use gets its own event kind (spec §6,
  // AC12/13) — detection is shared with transcript-meta.ts via
  // ask-user-question.ts, so the two can never drift.
  const detected = detectAskUserQuestion(e.message.content);
  if (detected) {
    return { kind: 'askUserQuestion', at, toolUseId: detected.toolUseId, resolved: false, questions: detected.questions };
  }

  // assistant: prefer a tool_use collapse, else text
  const blocks = normalizeContent(e.message.content);
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
 * Cross-line pass (spec §4.1): for each pending askUserQuestion event, the
 * FIRST later user line that isResolvingUserEntry() accepts resolves it —
 * matched by tool_use_id or by being a human turn, never by adjacency (a
 * resumed takeover writes housekeeping lines in between). A tool_result
 * resolution drops its blank bubble; a text resolution keeps the human turn
 * visible because it is a real conversational turn.
 */
function resolveAskUserQuestions(
  withIndex: { event: TranscriptEvent; lineIndex: number }[],
  rawLines: string[],
): TranscriptEvent[] {
  type AskEvent = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
  const pending = withIndex.filter((w): w is { event: AskEvent; lineIndex: number } => w.event.kind === 'askUserQuestion');
  if (pending.length === 0) return withIndex.map((w) => w.event);

  const resolutions = new Map<string, { resolvedBy: 'tool_result' | 'text'; selectedLabels: string[] | undefined; at: string | undefined }>();
  const consumedLineIndices = new Set<number>();

  rawLines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { return; }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'user') return;
    for (const p of pending) {
      if (resolutions.has(p.event.toolUseId) || i <= p.lineIndex) continue;
      const r = isResolvingUserEntry(parsed.data, p.event.toolUseId);
      if (!r) continue;
      if (r.by === 'tool_result') {
        resolutions.set(p.event.toolUseId, { resolvedBy: 'tool_result', selectedLabels: r.selectedLabels, at: parsed.data.timestamp });
        consumedLineIndices.add(i);
      } else {
        resolutions.set(p.event.toolUseId, { resolvedBy: 'text', selectedLabels: parseAnswerText(p.event.questions, r.text), at: parsed.data.timestamp });
      }
    }
  });

  if (resolutions.size === 0) return withIndex.map((w) => w.event);

  const out: TranscriptEvent[] = [];
  for (const { event, lineIndex } of withIndex) {
    if (consumedLineIndices.has(lineIndex)) continue;
    if (event.kind === 'askUserQuestion') {
      const r = resolutions.get(event.toolUseId);
      if (r) {
        // `at` becomes the resolution instant (services.ts uses it as observedAt); falls back to ask-time.
        out.push({
          ...event, resolved: true, resolvedBy: r.resolvedBy, at: r.at ?? event.at,
          ...(r.selectedLabels !== undefined ? { selectedLabels: r.selectedLabels } : {}),
        });
        continue;
      }
    }
    out.push(event);
  }
  return out;
}

/**
 * Parse an appended chunk of a transcript. Emits events for every COMPLETE
 * line; returns any partial trailing line (no newline yet) as `remainder`,
 * to be prepended to the next chunk. This is how the file-watcher tolerates
 * reading mid-write (spec §5) without ever throwing on a half-written line.
 */
export function parseChunk(chunk: string): { events: TranscriptEvent[]; remainder: string } {
  const lastNl = chunk.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : chunk.slice(0, lastNl);
  const remainder = lastNl === -1 ? chunk : chunk.slice(lastNl + 1);
  const lines = complete ? complete.split('\n') : [];

  const withIndex: { event: TranscriptEvent; lineIndex: number }[] = [];
  lines.forEach((line, i) => {
    const ev = normalizeLine(line);
    if (ev) withIndex.push({ event: ev, lineIndex: i });
  });

  return { events: resolveAskUserQuestions(withIndex, lines), remainder };
}
