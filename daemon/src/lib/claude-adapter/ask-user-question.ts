import { ToolUseBlock, ToolResultBlock, AskUserQuestionInputSchema, type AskUserQuestionInput, type UserTranscriptLine } from './schemas.js';

/**
 * Everything MicroViber knows about AskUserQuestion in one place (spec
 * askuserquestion-answer-mechanism §4.2): detection of the tool_use, the
 * two-clause resolution rule, and the daemon-composed answer format with its
 * parser. tail.ts (per-occurrence events) and transcript-meta.ts (the rolling
 * pendingQuestion slot) both call these — never re-implement the rule.
 */
export interface DetectedQuestion { toolUseId: string; questions: AskUserQuestionInput[] }

/** First well-formed AskUserQuestion tool_use in an assistant message's content, else null. Never throws. */
export function detectAskUserQuestion(assistantContent: unknown): DetectedQuestion | null {
  if (!Array.isArray(assistantContent)) return null;
  for (const block of assistantContent) {
    const parsedBlock = ToolUseBlock.safeParse(block);
    if (!parsedBlock.success || parsedBlock.data.name !== 'AskUserQuestion') continue;
    const parsedInput = AskUserQuestionInputSchema.safeParse(parsedBlock.data.input);
    if (!parsedInput.success) continue;
    return { toolUseId: parsedBlock.data.id, questions: parsedInput.data.questions };
  }
  return null;
}

/** A submitted answer, in the shape validated by `schemas/api.ts`'s `AnswerBody` — kept local (no cross-import) so this module stays fully self-contained. */
export interface SubmittedAnswer { toolUseId: string; selections: string[][] }

/**
 * Spec §5.2 checks, in order. Pure — no I/O. Kept in this module (not
 * domain/answer.ts) because it inspects `AskUserQuestionInput`'s own fields
 * (label, description, multiSelect) — the adapter quarantine (§6) is where
 * Claude Code's own vocabulary gets reasoned about, not domain/services
 * (review finding, askuserquestion-answer-mechanism-1). Labels are
 * model-authored transcript content about to be echoed back into the
 * session; exact matching against the pending question's own options is
 * what keeps this from being an arbitrary-text write path (T11 note).
 */
export function validateAnswer(pending: DetectedQuestion | null, a: SubmittedAnswer): { ok: true } | { ok: false; message: string } {
  if (!pending || pending.toolUseId !== a.toolUseId) return { ok: false, message: 'question is no longer pending' };
  if (a.selections.length !== pending.questions.length) return { ok: false, message: 'answer must cover every question' };
  for (const [i, q] of pending.questions.entries()) {
    const picked = a.selections[i] ?? [];
    if (picked.length === 0) return { ok: false, message: 'answer must cover every question' };
    if (new Set(picked).size !== picked.length) return { ok: false, message: `question ${q.header} lists a duplicate selection` };
    if (picked.length > 1 && q.multiSelect !== true) return { ok: false, message: `question ${q.header} accepts one option` };
    const allowed = new Set(q.options.map((o) => o.label));
    if (picked.some((label) => !allowed.has(label))) return { ok: false, message: `unknown option for ${q.header}` };
  }
  return { ok: true };
}

export type Resolution =
  | { by: 'tool_result'; selectedLabels: string[] | undefined }
  | { by: 'text'; text: string };

/**
 * Known synthetic `origin.kind` values that Claude Code itself injects —
 * never a person typing. `architecture-spec.md` F18's addendum spike FAILed
 * the original "no origin field on a human turn" hypothesis: a real,
 * laptop-typed turn carries `origin: {kind: "human"}`. So this is a denylist
 * of synthetic kinds, not an allowlist of human ones — extend it if a new
 * synthetic `origin.kind` is observed. `auto-continuation` is F18 clause
 * (1)'s own name for the resume handshake's SDK-documented origin — the
 * `isMeta: true` check below already excludes that turn, but a build that
 * ever emits `auto-continuation` without `isMeta` must not fall through to
 * being treated as a person answering (review finding, askuserquestion-
 * answer-mechanism-1).
 */
const SYNTHETIC_ORIGIN_KINDS = new Set(['task-notification', 'auto-continuation']);

/**
 * Spec §4.1. A later user entry resolves a pending question when EITHER
 *  (a) it carries a tool_result whose tool_use_id matches (the laptop's own
 *      answer stub), or
 *  (b) it is a human turn: has text, is not `isMeta` (the resume handshake,
 *      F17/F18), and its `origin.kind` (if any) is not one of the known
 *      synthetic kinds (F18 addendum — `origin.kind: 'human'` IS a person).
 */
export function isResolvingUserEntry(entry: UserTranscriptLine, toolUseId: string): Resolution | null {
  const content = entry.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const r = ToolResultBlock.safeParse(block);
      if (r.success && r.data.tool_use_id === toolUseId) {
        return { by: 'tool_result', selectedLabels: labelsFromToolResult(r.data.content) };
      }
    }
  }
  if (entry.isMeta === true) return null;
  if (entry.origin?.kind !== undefined && SYNTHETIC_ORIGIN_KINDS.has(entry.origin.kind)) return null;
  const text = humanText(content);
  return text === null ? null : { by: 'text', text };
}

/** One "no labels" shape for the card: undefined for non-string, empty, or CLI-error content. */
function labelsFromToolResult(content: unknown): string[] | undefined {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<tool_use_error>')) return undefined;
  const labels = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : undefined;
}

function humanText(content: unknown): string | null {
  if (typeof content === 'string') return content.length ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join(' ') : null;
}

/** Backstop only — a validated answer never approaches this (spec §5.3). */
export const ANSWER_TEXT_MAX_CHARS = 4000;

const HEADING_ONE = 'Answering your question:';
const HEADING_MANY = 'Answering your questions:';

/** Spec §5.3 — the ONE place that decides the wording of a phone answer. */
export function composeAnswerText(questions: AskUserQuestionInput[], selections: string[][]): string {
  const heading = questions.length === 1 ? HEADING_ONE : HEADING_MANY;
  const lines = questions.map((q, i) => `- ${q.header}: ${(selections[i] ?? []).join(', ')}`);
  return [heading, ...lines].join('\n');
}

/**
 * Inverse of composeAnswerText. Exact-shape only: returns the flat list of
 * matched labels, or undefined for anything else (free text, partial match,
 * unknown label). Labels are matched longest-first so a label containing
 * ", " is not split. Deliberately no heuristics (spec §5.3 accepted degrade).
 */
export function parseAnswerText(questions: AskUserQuestionInput[], text: string): string[] | undefined {
  const lines = text.split('\n');
  const heading = lines[0];
  if (heading !== (questions.length === 1 ? HEADING_ONE : HEADING_MANY)) return undefined;
  if (lines.length !== questions.length + 1) return undefined;
  const out: string[] = [];
  for (const [i, q] of questions.entries()) {
    const line = lines[i + 1] ?? '';
    const prefix = `- ${q.header}: `;
    if (!line.startsWith(prefix)) return undefined;
    let rest = line.slice(prefix.length);
    const labels = q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
    let pickedAny = false;
    while (rest.length > 0) {
      const hit = labels.find((l) => rest === l || rest.startsWith(`${l}, `));
      if (hit === undefined) return undefined;
      out.push(hit);
      pickedAny = true;
      rest = rest.slice(hit.length);
      if (rest.startsWith(', ')) rest = rest.slice(2);
    }
    if (!pickedAny) return undefined;
  }
  return out;
}
