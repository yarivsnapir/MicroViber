import { TranscriptLineSchema, ToolUseBlock, ToolResultBlock, AskUserQuestionInputSchema } from './schemas.js';

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
  // AC12/13) instead of collapsing to the generic { kind: 'tool' } shape —
  // detected via its own zod-validated pass over the raw content blocks
  // (architecture-spec.md §6: every parse boundary goes through zod, not a
  // raw cast), independent of normalizeContent's pre-existing, looser
  // tool_use handling below (which stays backward-compatible with tool_use
  // blocks that omit `id`, as its own tests rely on).
  const askUserQuestion = extractAskUserQuestion(e.message.content, at);
  if (askUserQuestion) return askUserQuestion;

  // assistant: prefer a tool_use collapse, else text
  const blocks = normalizeContent(e.message.content);
  if (blocks.tool) {
    return { kind: 'tool', at, name: blocks.tool.name, summary: blocks.tool.summary };
  }
  return { kind: 'assistant', at, text: blocks.text ?? '' };
}

/**
 * Defensive, zod-validated detection of an AskUserQuestion tool_use block
 * within one assistant message's content array. Returns null (never throws)
 * for anything that isn't a well-formed AskUserQuestion tool_use, so a
 * malformed or future-shaped block just falls through to the generic
 * tool-collapse path in normalizeLine.
 */
function extractAskUserQuestion(content: unknown, at: string): TranscriptEvent | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const parsedBlock = ToolUseBlock.safeParse(block);
    if (!parsedBlock.success || parsedBlock.data.name !== 'AskUserQuestion') continue;
    const parsedInput = AskUserQuestionInputSchema.safeParse(parsedBlock.data.input);
    if (!parsedInput.success) continue;
    return {
      kind: 'askUserQuestion',
      at,
      toolUseId: parsedBlock.data.id,
      resolved: false,
      questions: parsedInput.data.questions,
    };
  }
  return null;
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
 * Cross-line pass: parseChunk (unlike normalizeLine, which is single-line and
 * stateless) sees every line together, so it can match a pending
 * AskUserQuestion to a LATER tool_result — matched by exact line index, never
 * by "next line" adjacency. A real resumed-takeover answer (this story's own
 * write path) writes several session-housekeeping lines between the
 * tool_use and its tool_result, so adjacency would silently fail for exactly
 * the case this exists to serve.
 */
function resolveAskUserQuestions(
  withIndex: { event: TranscriptEvent; lineIndex: number }[],
  rawLines: string[],
): TranscriptEvent[] {
  const pendingIds = new Set(
    withIndex
      .filter((w): w is { event: Extract<TranscriptEvent, { kind: 'askUserQuestion' }>; lineIndex: number } => w.event.kind === 'askUserQuestion')
      .map((w) => w.event.toolUseId),
  );
  if (pendingIds.size === 0) return withIndex.map((w) => w.event);

  const resolutions = new Map<string, string>(); // toolUseId -> raw answer content
  // toolUseId -> the resolving tool_result line's OWN timestamp — distinct
  // from the askUserQuestion event's `at`, which stays the original ask-time
  // (findings review, story-8 Task 7 fix round: services.ts's observeAnswer()
  // uses this event's `at` as the PromptRecord's observedAt, so the
  // resolution instant — not the ask instant — is the one that belongs there).
  const resolvedAt = new Map<string, string>();
  const consumedLineIndices = new Set<number>();

  rawLines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'user') return;
    const content = parsed.data.message.content;
    if (!Array.isArray(content)) return;
    // Mirror transcript-meta.ts's scanTranscriptMeta: scan every block in the
    // content array for a matching tool_result, regardless of how many other
    // blocks are present or where in the array it sits — a real answer's
    // content array is not guaranteed to be single-element.
    for (const block of content) {
      const resultParsed = ToolResultBlock.safeParse(block);
      if (!resultParsed.success || !pendingIds.has(resultParsed.data.tool_use_id)) continue;
      resolutions.set(resultParsed.data.tool_use_id, typeof resultParsed.data.content === 'string' ? resultParsed.data.content : '');
      if (parsed.data.timestamp) resolvedAt.set(resultParsed.data.tool_use_id, parsed.data.timestamp);
      consumedLineIndices.add(i);
    }
  });

  if (resolutions.size === 0) return withIndex.map((w) => w.event);

  const out: TranscriptEvent[] = [];
  for (const { event, lineIndex } of withIndex) {
    if (consumedLineIndices.has(lineIndex)) continue; // drop the now-redundant blank answer bubble
    if (event.kind === 'askUserQuestion' && resolutions.has(event.toolUseId)) {
      const rawAnswer = resolutions.get(event.toolUseId)!;
      const selectedLabels = rawAnswer.split(',').map((s) => s.trim()).filter(Boolean);
      // `at` becomes the resolution instant when the resolving line carries
      // its own timestamp; falls back to the original ask-time rather than
      // ever going blank.
      out.push({ ...event, resolved: true, selectedLabels, at: resolvedAt.get(event.toolUseId) ?? event.at });
      continue;
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
