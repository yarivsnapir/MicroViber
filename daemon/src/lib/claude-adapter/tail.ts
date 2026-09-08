import { TranscriptLineSchema } from './schemas.js';
import { detectAskUserQuestion, isResolvingUserEntry, parseAnswerText } from './ask-user-question.js';

/** The normalized event stream the rest of MicroViber consumes (spec §5). */
export type TranscriptEvent =
  | { kind: 'user'; at: string; text: string; injected: boolean }
  | { kind: 'assistant'; at: string; text: string }
  | { kind: 'tool'; at: string; id: string; name: string; summary: string; input: Record<string, unknown>; truncated: boolean }
  | { kind: 'toolResult'; at: string; toolUseId: string; ok: boolean; text: string; truncated: boolean }
  | { kind: 'thinking'; at: string; text: string }
  | {
      kind: 'askUserQuestion';
      at: string;
      toolUseId: string;
      resolved: boolean;
      /** Present iff resolved. 'tool_result' = the laptop's answer stub; 'text' = a later human turn (spec §4.1). */
      resolvedBy?: 'tool_result' | 'text';
      /** One entry per question, in question order (story-3). Absent = "can't tell" for the whole call; never a partially-filled array. */
      selectedLabels?: string[][];
      questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean | undefined }[];
    };


/**
 * Per-string-field ceiling for tool inputs, and the whole-string ceiling for a
 * tool result. One `Read` of a large file would otherwise balloon a single
 * /transcript response: the existing 500-event cap bounds event COUNT, not
 * payload SIZE (story-1 AC12).
 *
 * **This cap is not sufficient on its own**, and is not cost-only:
 * `TOOL_INPUT_MAX_CHARS` (total across fields), `TOOL_INPUT_MAX_DEPTH` and
 * `TOOL_INPUT_MAX_NODES` below bound the shapes a per-field length cap cannot
 * see — see the measurements recorded there (architecture-spec.md §6).
 *
 * Still unbounded above this layer: the `/transcript` RESPONSE, which
 * `TRANSCRIPT_MAX_EVENTS = 500` bounds by count only. Tracked as its own
 * story — see docs/features/microviber-track-c/stories/story-9.md.
 */
const TOOL_PAYLOAD_MAX_CHARS = 32_000;

function capText(s: string): { text: string; truncated: boolean } {
  return s.length > TOOL_PAYLOAD_MAX_CHARS
    ? { text: `${s.slice(0, TOOL_PAYLOAD_MAX_CHARS)}…`, truncated: true }
    : { text: s, truncated: false };
}

/**
 * Total characters of string content one tool event may carry, across all
 * fields at every depth. The per-field cap above is not sufficient on its own:
 * a tool input may hold any number of fields, and 200 fields at the per-field
 * cap measured at 6.4 MB in a single event before this budget existed
 * (security review, story-1).
 *
 * 2 × TOOL_PAYLOAD_MAX_CHARS plus 8 000 of headroom. The largest *legitimate*
 * input the story supports is an `Edit` whose `old_string` and `new_string`
 * are both at the per-field cap — but those never travel alone (`file_path`,
 * `replace_all`), and at exactly 64 000 the sibling `file_path` spent enough
 * of the budget to clip `new_string` by 4 characters and raise
 * `truncated: true` on an input that lost nothing worth flagging. A budget
 * with no headroom for the fields that always accompany the capped ones
 * reports truncation as noise; measured, then widened.
 */
const TOOL_INPUT_MAX_CHARS = 72_000;

/** Depth beyond which a nested tool input is pruned rather than walked. */
const TOOL_INPUT_MAX_DEPTH = 4;

/** Node ceiling, so a wide-but-shallow input cannot cost unbounded work. */
const TOOL_INPUT_MAX_NODES = 5_000;

interface CapBudget { chars: number; nodes: number; truncated: boolean }

/**
 * Cap string content at EVERY depth, while keeping the object's shape.
 *
 * Shape matters because DiffView (PWA) addresses `old_string`/`new_string` by
 * name, and the key/value list renders a `MultiEdit`'s `edits` array and a
 * `TodoWrite`'s todos (story-1 AC12/AC23).
 *
 * Depth matters because the first version of this only walked the TOP level
 * and copied everything else by reference. A real `MultiEdit` carries all of
 * its content nested inside `edits[]` and has no top-level `old_string` at
 * all, so the shape the renderer was built for was the exact shape that
 * escaped the cap: one `MultiEdit` holding a 200 KB pair measured at a
 * 400 KB event reporting `truncated: false` — no ceiling, and no truncation
 * notice on screen either (found independently by both reviews, story-1).
 *
 * Bounded by WORK, not only by size, per architecture-spec.md §6: a per-field
 * length cap only fails closed on inputs whose shape someone predicted, so
 * the depth and node budgets fail closed on the ones nobody did. Exhausting
 * any budget degrades to a pruned value plus `truncated: true` — never to a
 * silently-partial value that reads as complete.
 *
 * Measured at these constants, driving the real `parseChunk` (`npx tsx`, dev
 * laptop). §6 asks for the largest legitimate input AND the ceiling cost at
 * the budget; both are here, and the legitimate rows are the ones that must
 * stay `truncated: false`:
 *
 *   LEGITIMATE
 *     Edit, two 32 000-char fields + file_path   1.0 ms   62.6 KB   false
 *     Write, 32 000-char content                 0.6 ms   31.3 KB   false
 *     TodoWrite, 20 todos                        0.1 ms    0.8 KB   false
 *   AT / PAST THE BUDGETS
 *     200 top-level fields x 40 000  (chars)     8.9 ms   72.4 KB   true
 *     MultiEdit, 50 nested pairs x 40 000        2.5 ms   72.1 KB   true
 *     10 000 nested nodes            (nodes)     3.5 ms   70.5 KB   true
 *     nesting past depth 4           (depth)     0.1 ms    0.0 KB   true
 *     the reported bug: 1 nested 200 KB pair     0.6 ms   62.6 KB   true
 *                                    (was 400 KB, truncated: false)
 *
 * Ceiling is ~72 KB of serialized `input` per tool event, ~9 ms. Note the
 * node-budget row exceeds TOOL_INPUT_MAX_CHARS: structural nodes and numbers
 * are charged against `nodes`, not `chars`, so TOOL_INPUT_MAX_NODES is what
 * bounds a wide input made of non-strings.
 */
function capInput(input: unknown): { input: Record<string, unknown>; truncated: boolean } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { input: {}, truncated: false };
  const budget: CapBudget = { chars: TOOL_INPUT_MAX_CHARS, nodes: TOOL_INPUT_MAX_NODES, truncated: false };
  const out = capValue(input, 0, budget) as Record<string, unknown>;
  return { input: out, truncated: budget.truncated };
}

function capValue(v: unknown, depth: number, budget: CapBudget): unknown {
  if (budget.nodes-- <= 0) {
    budget.truncated = true;
    return null;
  }

  if (typeof v === 'string') {
    // Whichever bites first: this field's own cap, or what is left of the
    // event's total. Once the total is spent, `limit` is 0 and every further
    // string collapses to the ellipsis — pruned, and flagged.
    const limit = Math.min(TOOL_PAYLOAD_MAX_CHARS, Math.max(0, budget.chars));
    if (v.length > limit) {
      budget.chars -= limit;
      budget.truncated = true;
      return `${v.slice(0, limit)}…`;
    }
    budget.chars -= v.length;
    return v;
  }

  if (Array.isArray(v)) {
    if (depth >= TOOL_INPUT_MAX_DEPTH) {
      budget.truncated = true;
      return [];
    }
    return v.map((x) => capValue(x, depth + 1, budget));
  }

  if (typeof v === 'object' && v !== null) {
    if (depth >= TOOL_INPUT_MAX_DEPTH) {
      budget.truncated = true;
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = capValue(x, depth + 1, budget);
    return out;
  }

  // number | boolean | null | undefined — bounded by their own serialization.
  return v;
}

/** Flatten a tool_result's `content` (string, block array, or arbitrary JSON) to displayable text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b !== 'object' || b === null) continue;
      const block = b as { type?: string; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  if (content === null || content === undefined) return '';
  try {
    // JSON.stringify is `string | undefined` (a bare `undefined` input, a
    // symbol, ...), so the ?? '' is what keeps this function's return `string`.
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

/** Normalize one raw .jsonl line into zero or more TranscriptEvents, in source order. */
export function normalizeLine(line: string): TranscriptEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const parsed = TranscriptLineSchema.safeParse(raw);
  if (!parsed.success) return [];
  const e = parsed.data;
  if (e.type !== 'user' && e.type !== 'assistant') return [];

  const at = e.timestamp ?? '';

  if (e.type === 'user') {
    // The synthetic "Continue from where you left off." resume handshake
    // (architecture-spec.md F17/F18) is not something the user typed —
    // rendering it as an ordinary turn would misleadingly look like laptop
    // input (story askuserquestion-answer-mechanism-2, deferred item 2).
    if (e.isMeta === true) return [];
    return userEvents(e.message.content, at);
  }

  // assistant: an AskUserQuestion tool_use gets its own event kind (spec §6,
  // AC12/13) — detection is shared with transcript-meta.ts via
  // ask-user-question.ts, so the two can never drift. It keeps its
  // whole-content short-circuit and its SINGLE-event shape:
  // resolveAskUserQuestions below depends on exactly one askUserQuestion
  // event per line (story-1 AC14).
  const detected = detectAskUserQuestion(e.message.content);
  if (detected) {
    return [{ kind: 'askUserQuestion', at, toolUseId: detected.toolUseId, resolved: false, questions: detected.questions }];
  }

  return assistantEvents(e.message.content, at);
}

function assistantEvents(content: unknown, at: string): TranscriptEvent[] {
  if (typeof content === 'string') return content ? [{ kind: 'assistant', at, text: content }] : [];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  const rest: TranscriptEvent[] = [];

  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      // Every tool_use gets its own event: the old walker reassigned a single
      // `tool` slot per iteration, so a multi-tool message kept only the LAST
      // call, and it preferred the tool over the prose, discarding text that
      // shared the message (story-1 AC1/AC2).
      // summarizeToolInput deliberately reads the UNCAPPED original: it
      // truncates to 120 chars of its own, and it still drives the collapsed
      // one-liner unchanged (AC11).
      const capped = capInput(block.input);
      rest.push({
        kind: 'tool',
        at,
        id: block.id ?? '',
        name: block.name,
        summary: summarizeToolInput(block.input),
        input: capped.input,
        truncated: capped.truncated,
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      // Thinking matched no branch before story-1, so a thinking-only line
      // normalized to an EMPTY assistant event and rendered on the phone as a
      // bare gutter bullet with nothing beside it (AC9).
      rest.push({ kind: 'thinking', at, text: block.thinking });
    }
  }

  const out: TranscriptEvent[] = [];
  // Blank line, not a space: several text blocks are separate paragraphs, and
  // joining them with ' ' collapsed real paragraph breaks in the rendered
  // markdown (AC3).
  const text = texts.join('\n\n');
  if (text) out.push({ kind: 'assistant', at, text });
  return [...out, ...rest];
}

function userEvents(content: unknown, at: string): TranscriptEvent[] {
  if (typeof content === 'string') return content ? [{ kind: 'user', at, text: content, injected: false }] : [];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  const results: TranscriptEvent[] = [];

  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      // The walker recognised no tool_result at all before story-1, so every
      // ordinary tool result reached the phone as an EMPTY user bubble — a
      // grey bordered box with nothing in it (AC5/AC6).
      const capped = capText(toolResultText(block.content));
      results.push({
        kind: 'toolResult',
        at,
        toolUseId: block.tool_use_id,
        // Claude Code marks a failed tool with is_error; anything else is a
        // success, so the PWA never has to string-sniff the body (AC7).
        ok: block.is_error !== true,
        text: capped.text,
        truncated: capped.truncated,
      });
    }
  }

  const out: TranscriptEvent[] = [];
  const text = texts.join('\n\n');
  // A user line with ONLY tool_result blocks emits NO user event. That blank
  // bubble was the empty grey box on the phone (AC6).
  if (text) out.push({ kind: 'user', at, text, injected: false });
  return [...out, ...results];
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

  const resolutions = new Map<string, { resolvedBy: 'tool_result' | 'text'; selectedLabels: string[][] | undefined; at: string | undefined }>();
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
      const r = isResolvingUserEntry(parsed.data, { toolUseId: p.event.toolUseId, questions: p.event.questions });
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

  // Flatten while preserving each event's SOURCE LINE INDEX, so
  // resolveAskUserQuestions can still drop a consumed line's whole output
  // together — every event from one line shares that line's index.
  const withIndex: { event: TranscriptEvent; lineIndex: number }[] = [];
  lines.forEach((line, i) => {
    for (const ev of normalizeLine(line)) withIndex.push({ event: ev, lineIndex: i });
  });

  return { events: resolveAskUserQuestions(withIndex, lines), remainder };
}
