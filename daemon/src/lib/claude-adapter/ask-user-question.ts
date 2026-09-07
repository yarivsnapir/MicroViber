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
 * The ONE statement of a question's cardinality. `validateAnswer` (the write
 * path, §5.2) and `matchLabelRun` (the read path, §4.1/§5.3) both need it;
 * stating it twice is how the two drift, so they share this instead (review
 * finding, askuserquestion-answer-mechanism-3 task 1).
 */
function allowsMultiple(q: AskUserQuestionInput): boolean {
  return q.multiSelect === true;
}

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
    if (picked.length > 1 && !allowsMultiple(q)) return { ok: false, message: `question ${q.header} accepts one option` };
    const allowed = new Set(q.options.map((o) => o.label));
    if (picked.some((label) => !allowed.has(label))) return { ok: false, message: `unknown option for ${q.header}` };
  }
  return { ok: true };
}

export type Resolution =
  | { by: 'tool_result'; selectedLabels: string[][] | undefined }
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
export function isResolvingUserEntry(entry: UserTranscriptLine, pending: DetectedQuestion): Resolution | null {
  const content = entry.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const r = ToolResultBlock.safeParse(block);
      if (r.success && r.data.tool_use_id === pending.toolUseId) {
        return { by: 'tool_result', selectedLabels: labelsFromToolResult(pending.questions, r.data.content) };
      }
    }
  }
  if (entry.isMeta === true) return null;
  if (entry.origin?.kind !== undefined && SYNTHETIC_ORIGIN_KINDS.has(entry.origin.kind)) return null;
  const text = humanText(content);
  return text === null ? null : { by: 'text', text };
}

/**
 * One "no labels" shape for the card: undefined for non-string, empty, or
 * CLI-error content — and equally for any content this cannot attribute to a
 * specific question, which is a change from the original blind
 * `split(',')`. Matching against the questions' own options is what makes
 * per-question attribution possible at all, and it means a stub that is not
 * an answer can no longer masquerade as one (story-3 AC2).
 */
function labelsFromToolResult(questions: AskUserQuestionInput[], content: unknown): string[][] | undefined {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<tool_use_error>')) return undefined;
  return splitStubAcrossQuestions(questions, trimmed);
}

/**
 * The laptop's own answer stub is ONE string covering EVERY question, unlike
 * the composed text format (§5.3) which puts each question on its own line.
 * Attribution is therefore only possible where the boundary between two
 * questions' runs is knowable:
 *
 *  - one question — it takes the whole run, multiSelect or not;
 *  - several questions, all single-select — each takes exactly one label, in
 *    order, so position decides;
 *  - several questions where any is multiSelect — a multiSelect question
 *    could have consumed any number of the `", "`-joined labels, so the
 *    boundary is genuinely ambiguous. Return undefined rather than guess.
 *
 * The walk must also consume the stub exactly: leftover text at the end, or a
 * stub exhausted before the last question (`takeLabel` rejects an empty
 * `rest`), both mean this is not the shape we think it is. Every rejection
 * degrades to an unhighlighted card — the card can always tell "resolved"
 * from "resolved with labels".
 */
function splitStubAcrossQuestions(questions: AskUserQuestionInput[], stub: string): string[][] | undefined {
  const [only] = questions;
  if (only === undefined) return undefined;
  if (questions.length === 1) {
    const picked = matchLabelRun(only, stub);
    return picked === null ? undefined : [picked];
  }
  if (questions.some(allowsMultiple)) return undefined;
  const out: string[][] = [];
  let rest = stub;
  for (const q of questions) {
    const step = takeLabel(q, rest);
    if (step === null) return undefined;
    out.push([step.label]);
    rest = step.rest;
  }
  return rest.length === 0 ? out : undefined;
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

function longestFirstLabels(q: AskUserQuestionInput): string[] {
  return q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
}

/**
 * Consume ONE of `q`'s option labels from the front of `rest`, plus the `", "`
 * separator that follows it, and return what is left. Longest label first, so
 * a label that itself contains `", "` is never split at its own comma.
 * Returns null when `rest` is empty or does not begin with one of THIS
 * question's labels.
 *
 * The single place that knows the wire shape of a label run — the `", "`
 * joiner and the longest-first tie-break. Both walks over a run go through
 * here (`matchLabelRun`, taking one question's whole run; the positional loop
 * in `splitStubAcrossQuestions`, taking one label per question), so a change
 * to that shape cannot reach one walk and miss the other (review finding,
 * askuserquestion-answer-mechanism-3 task 2).
 *
 * The empty-`rest` guard is load-bearing, not defensive: `schemas.ts` types a
 * label as `TrustedText(500)` with no `.min(1)`, so `label: ''` is
 * schema-valid, and without the guard an exhausted stub would match such a
 * label and report a question as answered when the stub carried nothing for
 * it. A wrong attribution is the one outcome this module must never produce —
 * every rejection degrades to an unhighlighted card instead.
 */
function takeLabel(q: AskUserQuestionInput, rest: string): { label: string; rest: string } | null {
  if (rest.length === 0) return null;
  const label = longestFirstLabels(q).find((l) => rest === l || rest.startsWith(`${l}, `));
  if (label === undefined) return null;
  const after = rest.slice(label.length);
  return { label, rest: after.startsWith(', ') ? after.slice(2) : after };
}

/**
 * Match `text` as an exact `", "`-joined run of ONE question's own option
 * labels, longest label first so a label that itself contains `", "` is not
 * split. Returns the labels picked, or null when `text` is anything else
 * (free text, a partial match, an unknown label, or empty).
 *
 * Also enforces the question's own cardinality: a single-select question
 * must yield exactly one label. This is the whole-run matcher — §4.1 clause
 * (b) (via parseAnswerText) and clause (a)'s single-question stub both go
 * through it. Clause (a)'s MULTI-question stub cannot: it takes one label per
 * question positionally, so it walks `takeLabel` directly and gets its
 * cardinality for free (exactly one label each, and the branch bails outright
 * when any question is multiSelect). Every path still shares `takeLabel`, so
 * none can accept a run that `validateAnswer` (§5.2) would have rejected on
 * the way out — the module header's "never re-implement the rule" applies to
 * reading answers as much as to writing them.
 *
 * Greedy with no backtracking — the rule parseAnswerText has always used.
 * Consequence, deliberately accepted: if a question offers both `"A"` and
 * `"A, B"`, the longer is tried first, so a run that would only parse by
 * choosing the shorter one is reported as no match. Saying "can't tell" is
 * the safe answer here; every "can't tell" degrades to an unhighlighted
 * card, never to a wrong highlight.
 */
function matchLabelRun(q: AskUserQuestionInput, text: string): string[] | null {
  const picked: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const step = takeLabel(q, rest);
    if (step === null) return null;
    picked.push(step.label);
    rest = step.rest;
  }
  if (picked.length === 0) return null;
  if (picked.length > 1 && !allowsMultiple(q)) return null;
  return picked;
}

/**
 * Inverse of composeAnswerText. Exact-shape only: returns ONE ARRAY PER
 * QUESTION, in question order, or undefined for anything else (free text,
 * partial match, unknown label). All-or-nothing — a single unparseable line
 * makes the whole call undefined, so a defined result always has exactly
 * `questions.length` non-empty entries (spec §5.3 accepted degrade).
 *
 * The empty-`questions` guard keeps that invariant true at its one hole: with
 * no questions the plural heading matches, `lines.length` is 1, the loop never
 * runs, and a DEFINED but EMPTY `[]` would reach the card — "defined" is the
 * card's signal that there is a label for every question. `AskUserQuestionInputSchema`
 * makes it unreachable today (`questions` is `.min(1)`), but
 * `splitStubAcrossQuestions` already guards the same case, and the two halves of
 * §4.1 must not disagree about it (review finding, askuserquestion-answer-mechanism-3
 * task 5).
 */
export function parseAnswerText(questions: AskUserQuestionInput[], text: string): string[][] | undefined {
  if (questions.length === 0) return undefined;
  const lines = text.split('\n');
  const heading = lines[0];
  if (heading !== (questions.length === 1 ? HEADING_ONE : HEADING_MANY)) return undefined;
  if (lines.length !== questions.length + 1) return undefined;
  const out: string[][] = [];
  for (const [i, q] of questions.entries()) {
    const line = lines[i + 1] ?? '';
    const prefix = `- ${q.header}: `;
    if (!line.startsWith(prefix)) return undefined;
    const picked = matchLabelRun(q, line.slice(prefix.length));
    if (picked === null) return undefined;
    out.push(picked);
  }
  return out;
}
