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
  // The pair format is what Claude Code actually writes (AC7); the bare-label
  // run is kept as a fallback — it matched 9 of 308 observed single-question
  // stubs, and it is the shape architecture-spec F16's hand-written stub used.
  return labelsFromPairFormat(questions, trimmed) ?? splitStubAcrossQuestions(questions, trimmed);
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

/**
 * The laptop's own answer stub, in the format Claude Code actually writes —
 * measured over 1306 real transcripts (story-3 AC7, probe
 * `docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts`):
 *
 *   Your questions have been answered: "<question text>"="<label>", "<question text>"="<label>".
 *   You can now continue with these answers in mind.
 *
 * The format is ALREADY per-question, which is why AC2's "can it be split"
 * premise was wrong: it pairs each question with its own answer.
 *
 * Anchoring is on the literal `"<question text>"="` for each PENDING question,
 * never on splitting the stub by its quotes — question texts and labels may
 * both contain `"`, so a quote-splitting parser would mis-split. Consequences
 * of anchoring: surrounding prose is irrelevant (the leading and trailing
 * sentences vary), and the pairs may appear in any order.
 *
 * All-or-nothing, like every other path here: a question that is absent, or
 * whose value is a free-text "Other" answer rather than one of its own option
 * labels, makes the WHOLE call undefined rather than a partial attribution
 * (AC3's invariant — a defined result always has exactly `questions.length`
 * non-empty entries). Two whole-call preconditions serve the same invariant:
 * an EMPTY question text would make `anchor` match almost anywhere, and
 * question texts that are not all DISTINCT would make two questions anchor on
 * the same pair and report the first one's answer twice (`indexOf` finds the
 * first occurrence). `AskUserQuestionInputSchema` dedupes option labels WITHIN
 * a question but has no cross-question uniqueness refine, so both are
 * schema-reachable and both are rejected here.
 *
 * Finding the value's closing `"` is the delicate part, because getting it
 * wrong costs a WRONG highlight rather than the usual degrade. It is not the
 * first `"` after the anchor: `schemas.ts` types a label as `TrustedText(500)`
 * (control characters only are rejected), so a label may contain `"`, and
 * truncating at an inner quote can land exactly on a shorter label of the same
 * question. A candidate close is accepted only when it BOTH parses as a run of
 * this question's own labels AND sits where the format's own value ends
 * (`closesValue`), and only when exactly ONE candidate qualifies. That closes
 * the two cases the round-1 review reproduced: `"Yes"maybe"` now reads as
 * `Yes"maybe` instead of `Yes`, and the free-text `"Yes" — actually no` is
 * rejected outright instead of highlighting `Yes`.
 *
 * The residual, stated plainly rather than claimed away (this branch already
 * carries a commit for overclaiming exactly here): a free-text value whose
 * leading characters are a valid label run followed by `"` and then one of
 * those delimiters — `"Yes". Actually no` is the shape — still parses as that
 * label, and the card highlights an option the person did not pick. Much
 * narrower than before, but not provably empty; pinned by a test rather than
 * left to be rediscovered. Same trade as `matchLabelRun`'s greedy walk:
 * display-only, since nothing is ever written back from a parsed stub.
 */
function labelsFromPairFormat(questions: AskUserQuestionInput[], stub: string): string[][] | undefined {
  if (questions.length === 0) return undefined;
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return undefined;
  const out: string[][] = [];
  for (const q of questions) {
    if (q.question.length === 0) return undefined;
    const anchor = `"${q.question}"="`;
    const at = stub.indexOf(anchor);
    if (at === -1) return undefined;
    const from = at + anchor.length;
    const limit = from + maxValueLength(q);
    let picked: string[] | null = null;
    for (let c = stub.indexOf('"', from); c !== -1 && c <= limit; c = stub.indexOf('"', c + 1)) {
      if (!closesValue(stub, c)) continue;
      const hit = matchLabelRun(q, stub.slice(from, c));
      if (hit === null) continue;
      if (picked !== null) return undefined;
      picked = hit;
    }
    if (picked === null) return undefined;
    out.push(picked);
  }
  return out.length === questions.length ? out : undefined;
}

/**
 * Does the `"` at `close` sit where a pair value ends? One of: the next pair
 * begins (`, "`), the sentence ends (`.`), or the stub does. This is what stops
 * a free-text value that merely STARTS with a valid label from being read as
 * that label — the highest-volume wrong attribution the round-1 review found,
 * since §4.1 records free-text "Other" answers as the bulk of the non-matching
 * shapes. It is a delimiter check, not a prose check, so the 107 observed
 * leading and trailing sentences stay irrelevant; a shape that ends a value
 * some other way degrades to undefined, which is the accepted direction.
 */
function closesValue(stub: string, close: number): boolean {
  const after = close + 1;
  return after === stub.length || stub[after] === '.' || stub.startsWith(', "', after);
}

/**
 * The longest a pair value can legitimately be for `q`: all of its option
 * labels plus the `", "` that would join them. Bounds
 * `labelsFromPairFormat`'s candidate scan, which is otherwise O(quotes x value
 * length) — a schema-legal 50-option multiSelect question with a quote-dense
 * 8 KB stub took 862 ms unbounded, and `tail.ts` runs this for every
 * AskUserQuestion occurrence during a cold rescan, so that is a real cost and
 * not a theoretical one. A natural bound rather than a magic number: a quote
 * further out than this cannot be closing a value `matchLabelRun` would accept.
 */
function maxValueLength(q: AskUserQuestionInput): number {
  const labels = q.options.reduce((n, o) => n + o.label.length, 0);
  return labels + Math.max(0, 2 * (q.options.length - 1));
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
 * it. Every rejection degrades to an unhighlighted card, never to a junk
 * highlight. That is weaker than "a wrong attribution is impossible": where a
 * stub admits more than one valid parse across a question boundary, this
 * greedy walk commits to the first one it finds and that choice can be the
 * wrong one — see `matchLabelRun` below for the case and its bounds.
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
 * Two consequences, both deliberately accepted rather than searched around:
 *
 *  - WITHIN one question (here): if it offers both `"A"` and `"A, B"`, the
 *    longer is tried first, so a run that would only parse by choosing the
 *    shorter one is reported as no match. Saying "can't tell" is the safe
 *    answer; every "can't tell" degrades to an unhighlighted card.
 *  - ACROSS questions (`splitStubAcrossQuestions`'s positional walk): a stub
 *    can admit more than one valid parse, and this walk commits to the first
 *    without ever checking whether a second exists — so the attribution can
 *    be complete and still WRONG, which the unhighlighted-card degrade does
 *    not cover. Worked case: Q1 offering `['A', 'A, B']` and Q2 offering
 *    `['B, C', 'C']` parse the stub `"A, B, C"` as `[['A, B'], ['C']]`,
 *    though `[['A'], ['B, C']]` is equally valid, and the wrong option then
 *    highlights. It takes model-authored option labels that contain `", "`
 *    AND prefix-split against a later question's labels, and it is
 *    display-only: nothing is written back from a parsed stub, so the cost is
 *    a dimmed card highlighting the wrong chip. Pinned (as behaviour, not as
 *    correctness) by the known-ambiguity test in
 *    `daemon/test/ask-user-question.test.ts`. Backtracking or an ambiguity
 *    search would close it and is not worth the complexity for that residual.
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
