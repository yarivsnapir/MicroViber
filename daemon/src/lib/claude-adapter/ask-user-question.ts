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
 *
 * "Cannot attribute" now includes "cannot afford to find out": this call gets
 * one `TAKE_LABEL_STEP_BUDGET`, and exhausting it lands in the same undefined.
 * The card cannot tell the two apart, which is the point — it distinguishes
 * "resolved" from "resolved with labels", nothing finer.
 */
function labelsFromToolResult(questions: AskUserQuestionInput[], content: unknown): string[][] | undefined {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<tool_use_error>')) return undefined;
  const budget = newStepBudget();
  // The pair format is what Claude Code actually writes (AC7); the bare-label
  // run is kept as a fallback — it matched 9 of 308 observed single-question
  // stubs, and it is the shape architecture-spec F16's hand-written stub used.
  const parsed = labelsFromPairFormat(questions, trimmed, budget) ?? splitStubAcrossQuestions(questions, trimmed, budget);
  // The budget's whole-call invariant, stated in ONE place: if any step was
  // REFUSED anywhere under this call, the call cannot tell, so it says so.
  // Every path above already returns undefined on its own when that happens
  // (see `labelsFromPairFormat`'s own check); this is the backstop that keeps
  // the invariant true of the call rather than of each path's current shape.
  return budget.exhausted ? undefined : parsed;
}

/**
 * The hard cost ceiling on ONE parse of ONE transcript entry, counted in
 * `takeLabel` steps across every question, every candidate close, and both
 * §4.1 walks. Exhausting it returns `undefined` — the module's existing
 * "can't tell" degrade — never a partial or an unchecked attribution.
 *
 * WHY A BUDGET AND NOT ANOTHER LENGTH BOUND. `maxValueLength` bounds the scan
 * WINDOW; it says nothing about the work done inside the window, and the
 * window's size is set by MODEL-AUTHORED option-label lengths (the schema
 * permits 50 x `TrustedText(500)` per question, so a 25 098-char window is
 * schema-legal). Measured on the shipped code before this budget existed, all
 * shapes fully schema-legal and every input INSIDE that window:
 *
 *  - 49 x 500-char labels plus ONE short delimiter-dense label (`".`), value
 *    24 598 B: **51 102 ms**. The amplifier is that the walk may REPEAT a
 *    label — the duplicate check that rejects the run only runs after the
 *    walk finishes — so a 4-char unit repeated ~6 000 times walks ~6 000 deep,
 *    once per candidate close, ~6 000 of them;
 *  - 50 x 500-char labels sharing a 490-char prefix, select-all value:
 *    **9 288 ms**;
 *  - a GENUINE select-all stub, nothing crafted but model-authored dense
 *    labels (50 x 500 chars, each selected once, `", "`-joined exactly as the
 *    CLI writes it): **999 ms**;
 *  - the bare-label fallback below, which `maxValueLength` does not bound at
 *    all: 600 KB, **404 ms**, linear and uncapped in the content length.
 *
 * `services.ts`'s transcript route, `discovery.ts`'s session list, the 5 s
 * notify loop and the answer write path all re-parse the transcript from
 * scratch, synchronously, in a single-threaded process — so one such
 * occurrence in a live transcript stalls every route, the WS hub and prompt
 * delivery for that long, on repeat.
 *
 * SIZE — every figure below measured, not reasoned. The largest LEGITIMATE
 * answer the schema admits is 4 questions x 50 options x 500-char labels with
 * every option selected — the pin in `daemon/test/ask-user-question.test.ts`
 * builds that at **100 547 bytes**, recomputed from its own construction, and
 * the exact count moves with the question texts. Parsing it takes **200 steps**,
 * 50 per question, one per selected label, because each question's true close
 * is then the only candidate that qualifies. The densest a `TrustedText(500)`
 * label can be is 249 `".` pairs, and a one-option-per-question answer at that
 * density (4 x 50 x 500) spends **2 470 steps** — 2 486 when the label's unique
 * part sits at its END rather than its start, which is the same alignment
 * effect the ceiling cost below turns on. Instrumented under the whole
 * 534-test daemon suite (a copy of this module counting steps per parse): 58 of
 * the 64 recorded parses spend 5 steps or fewer, the largest that is not a
 * deliberate cost pin is that 200-step maximal answer, and only the three
 * adversarial pins in `daemon/test/ask-user-question.test.ts` reach the budget.
 *
 * The budget is 8 000: 40x the maximal legitimate answer's 200 steps, 3.2x that
 * 2 470-step densest single-pick answer. DO NOT LOWER IT on the 40x figure
 * alone — a round-5 review proposed ~2 000 on exactly that reasoning, and that
 * reasoning omits the second measurement: 2 000 would still be 10x the maximal
 * select-all, but it would WRONGLY REJECT the 2 470-step single-pick answer,
 * which is every bit as schema-legal and as legitimate as the other. 8 000 was
 * never the wrong number; what was wrong is the cost once recorded for it,
 * which measured one shape and was read as the ceiling (below).
 *
 * What 8 000 CUTS OFF, so the degrade is not a surprise: on the maximal
 * select-all above, one `".` pair per label already needs 5 300 steps (still
 * inside the budget) and two need 10 400 (outside it — that answer degrades to
 * `undefined`). The full measured curve, 4 x 50 x 500 select-all by `".` pairs
 * per label: 0 -> 200 steps/2 ms, 1 -> 5 300/14 ms, 2 -> 10 400/29 ms,
 * 5 -> 25 700/93 ms, 10 -> 51 200/132 ms, 50 -> 255 200/681 ms,
 * 249 -> 1 249 700/3 270 ms. Re-measured since, against the test file's own
 * `denseLabel`: the step counts reproduce exactly except at 249 pairs, where
 * label truncation makes it 1 254 800, and every ms above is 1.0-1.5x what the
 * re-run measures, so none of them understates.
 *
 * And what the ceiling COSTS. 8 000 steps is a fixed step count at a very
 * unfixed price, so quote it only as "measured at X on shape Y": the 34 ms once
 * recorded here was a fair measurement of ONE shape (re-measured at 31.5 ms)
 * and understated the worst shape found by ~16x. Both shapes spend exactly
 * 8 000 steps; two things differ, both measured with an instrumented copy of
 * this module that counts steps, candidate closes and bytes sliced:
 *
 *  - HOW MANY CANDIDATES the budget buys. Where the value IS a run of the
 *    question's own labels — as in the recorded shape, the shared-prefix
 *    select-all — each candidate close consumes several steps before failing,
 *    so the budget dies after **1 870 candidates and 3.5 MB sliced**. Where the
 *    value matches NO label, each candidate costs exactly one step, so the same
 *    8 000 buys **8 002 candidates and 64.0 MB**. (Reconstructing the recorded
 *    shape needs its shared prefix to be `".`-DENSE to land on 31.5 ms; with a
 *    quote-free shared prefix that select-all is 2.4 ms and attributes all 50.)
 *  - WHAT ONE STEP COSTS. `takeLabel`'s longest-first `find` stops at the first
 *    label that matches and otherwise compares all 50 — and a label whose
 *    leading characters match the scanned text is compared ~500 characters deep
 *    before it fails, one that differs at character 1 is not. At the SAME 8 002
 *    candidates and 64.0 MB: **143.6 ms** for labels sharing a quote-free
 *    490-char prefix, **559.7 ms** for `".`-dense labels that align.
 *
 * So the ceiling itself, every figure measured on this machine, each input
 * schema-legal and inside the scan window:
 *
 *  - one question, 50 aligned `".`-dense 500-char labels, value `".` x 12 549
 *    (exactly the 25 098 bound): **545 ms**, `undefined`. Give that value a
 *    quote-free middle, so every slice is 12 KB+ rather than averaging half the
 *    window, and it is **619 ms** — the worst found. The same shape at 4
 *    questions is **598 ms**: the same order, not 4x, which is the budget being
 *    shared across questions rather than granted per question.
 *  - reaching that value needs a `tool_result` stub that is NOT a run of the
 *    question's own labels, i.e. write access to `~/.claude/projects/*.jsonl`.
 *    That is T12, which the threat model puts explicitly out of scope — such a
 *    process can already read the key files.
 *  - through T11 alone (model-authored labels, a real CLI pair stub,
 *    legitimate picks) the worst found is 4 questions x 50 aligned dense
 *    labels: one pick each costs **133 ms and is still correctly attributed**
 *    (2 486 steps); two picks each costs **253 ms** and degrades to
 *    `undefined`.
 *
 * Residual, stated rather than claimed away: this bounds ONE parse of ONE
 * entry, so a transcript carrying N such occurrences costs N x that per scan,
 * and every route re-scans from scratch. Measured on the 133 ms T11 shape:
 * N=5 -> 0.64 s, N=10 -> 1.3 s, N=50 -> 6.8 s — so past ~37 occurrences one
 * scan outlasts the 5 s notify interval and the loop overlaps itself, while
 * below ~5 it is invisible. N=50 of the 545 ms T12 shape is **33.6 s**.
 *
 * A budget is the honest shape here: unlike a length bound it does not rest on
 * an argument about what can parse, so it fails closed on inputs nobody
 * predicted rather than only on inputs whose length someone predicted.
 */
const TAKE_LABEL_STEP_BUDGET = 8_000;

/**
 * `left` is what remains; `exhausted` is set ONLY when a step was actually
 * REFUSED, so it never fires on a parse that happened to spend its last step
 * succeeding.
 */
interface StepBudget { left: number; exhausted: boolean }

function newStepBudget(): StepBudget {
  return { left: TAKE_LABEL_STEP_BUDGET, exhausted: false };
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
function splitStubAcrossQuestions(questions: AskUserQuestionInput[], stub: string, budget: StepBudget): string[][] | undefined {
  const [only] = questions;
  if (only === undefined) return undefined;
  if (questions.length === 1) {
    // `stub` here is the WHOLE tool_result content — `maxValueLength` bounds
    // the pair format's candidate scan and does not reach this path at all, so
    // the budget is the only thing standing between a 600 KB stub and a walk
    // proportional to it.
    const picked = matchLabelRun(only, stub, budget);
    return picked === null ? undefined : [picked];
  }
  if (questions.some(allowsMultiple)) return undefined;
  const out: string[][] = [];
  let rest = stub;
  for (const q of questions) {
    const step = takeLabel(q, rest, budget);
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
 * non-empty entries). THREE whole-call preconditions serve the same invariant,
 * and all three are schema-reachable — `AskUserQuestionInputSchema` dedupes
 * option labels WITHIN a question but has no cross-question uniqueness refine,
 * and `TrustedText` rejects only control characters:
 *
 *  - an EMPTY question text would make `anchor` match almost anywhere;
 *  - question texts that are not all DISTINCT would make two questions anchor
 *    on the same pair and report the first one's answer twice (`indexOf` finds
 *    the first occurrence);
 *  - a question whose anchor occurs MORE THAN ONCE in the stub, which
 *    distinctness alone does not rule out: question texts `A` and
 *    `A"="No", "A` are distinct and both schema-valid, yet `"A"="` occurs three
 *    times in their own real-format stub, so `indexOf` read the OTHER
 *    question's pair and reported `A` as `No` while `A`'s own pair said `Yes`
 *    (round-3 review). That is confidently WRONG rather than a degrade, so
 *    ambiguity of the anchor itself is rejected the same way ambiguity of the
 *    value's close is. Every real pair occurs exactly once, so this costs
 *    nothing on the observed shapes.
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
function labelsFromPairFormat(questions: AskUserQuestionInput[], stub: string, budget: StepBudget): string[][] | undefined {
  if (questions.length === 0) return undefined;
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return undefined;
  const out: string[][] = [];
  for (const q of questions) {
    if (q.question.length === 0) return undefined;
    const anchor = `"${q.question}"="`;
    const at = stub.indexOf(anchor);
    if (at === -1) return undefined;
    if (stub.indexOf(anchor, at + 1) !== -1) return undefined;
    const from = at + anchor.length;
    const limit = from + maxValueLength(q);
    let picked: string[] | null = null;
    for (let c = stub.indexOf('"', from); c !== -1 && c <= limit; c = stub.indexOf('"', c + 1)) {
      if (!closesValue(stub, c)) continue;
      const hit = matchLabelRun(q, stub.slice(from, c), budget);
      // A refused step means the rest of this scan never happened, so the
      // "exactly ONE candidate" check below is BLINDED — `picked` may hold a
      // hit whose rival was simply never evaluated. That is the same failure
      // the round-4 review found the scan bound causing, and it gets the same
      // answer: degrade the whole call rather than report a pick the ambiguity
      // check did not actually clear. (Bailing here is also what keeps the
      // remaining candidates from each costing a slice of the window.)
      if (budget.exhausted) return undefined;
      if (hit === null) continue;
      if (picked !== null) return undefined;
      picked = hit;
    }
    if (picked === null) return undefined;
    out.push(picked);
  }
  // One entry per question, or an early return above — never a partial result.
  return out;
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
 * `labelsFromPairFormat`'s candidate scan, which is otherwise O(candidates x
 * value length). The expensive shape is DELIMITER-dense, not merely
 * quote-dense — `closesValue` throws out a bare run of quotes in O(1) before
 * `matchLabelRun` is reached, but a `".`-repeating tail makes every quote a
 * candidate whose slice grows with the tail. Measured on a 50-option
 * multiSelect question with 8-CHAR labels (so a 498-char bound), unbounded vs
 * bounded: 8.5 KB stub 509 ms vs 1 ms, 16.5 KB 963 ms vs 0 ms, 40.5 KB 2446 ms
 * vs 1 ms. `tail.ts` runs this for every AskUserQuestion occurrence during a
 * cold rescan, so that is a real cost and not a theoretical one. A natural
 * bound rather than a magic number: a quote further out than this cannot be
 * closing a value `matchLabelRun` would accept, so the bound changes cost
 * only, never the result — as scoped below: that holds of the bound alone, not
 * of the bound together with the step budget.
 *
 * WHAT THIS BOUND DOES NOT DO, since the sentence above was for two rounds
 * read as more than it says: it bounds the scan WINDOW, and the window's size
 * is set by MODEL-AUTHORED label lengths — those 8-char labels give 498, while
 * the same 50-option shape at the schema's own `TrustedText(500)` gives 25 098,
 * 50x larger. The work done INSIDE the window is super-linear in it and is
 * bounded separately, by `TAKE_LABEL_STEP_BUDGET`; on the measurements there,
 * a fully in-window stub still cost 51 102 ms with this bound in place. So the
 * two are complementary and neither substitutes for the other: this bound is
 * length-shaped and result-neutral ONLY WHILE THE BUDGET IS NOT EXHAUSTED,
 * while the budget is work-shaped and result-CHANGING by design (it degrades to
 * `undefined`). They INTERACT, because removing the bound admits more
 * candidates and each candidate costs steps: with options `A` and `B` (a 4-char
 * window), the stub `"Q?"="A, B"` followed by 5 000 `".` pairs of prose tail —
 * 10 069 B in all — measures `[['A', 'B']]` with this bound and `undefined`
 * without it, the budget having been spent on the tail's candidates. So the
 * neutrality the next paragraph proves is neutrality of the BOUND ALONE, which
 * is also all its sweep could see: that sweep ran against the pre-budget
 * parser.
 *
 * That result-neutrality rests on TWO properties of `matchLabelRun`, and holds
 * only while it keeps both: an accepted run repeats no label, and it never
 * ends in a dangling `", "`. Together they make an accepted run exactly
 * `k <= options.length` DISTINCT labels with a label at EACH END joined by
 * `", "` — length `sum(picked) + 2 * (k - 1)`, at most this bound — so no
 * candidate close sitting past the bound can parse, and skipping those can
 * neither change the value picked nor hide a second qualifying candidate from
 * the "exactly ONE candidate" check above.
 *
 * Both properties were added under review AFTER this claim was first written,
 * and each time the claim was falsified by measuring rather than by re-reading
 * the argument, so the claim is now stated as a measurement:
 *
 *  - duplicates (round 3): `"Which?"="Yes, Yes, No"` on a Yes/No multiSelect
 *    question was `undefined` bounded but `[['Yes', 'Yes', 'No']]` unbounded;
 *  - a dangling separator (round 4): `"Q"="A, B, "` on a two-option
 *    multiSelect question was `undefined` bounded but `[['A', 'B']]`
 *    unbounded — and with options `b".x` and `b`, `"Q"="b".x, b, "` was
 *    `[['b']]` bounded and `undefined` unbounded, the bound alone deciding
 *    which, because the over-long second candidate never reached the
 *    "exactly ONE candidate" check.
 *
 * The measurement: 1 647 072 (config, value) pairs — 42 question configs x
 * every value up to five characters over the alphabet `A B b " , <space> .`,
 * each read both as a bare run and inside a real pair stub — bounded vs
 * unbounded. 26 disagreements before the round-4 fix, ALL of them the dangling
 * separator; zero after. The sweep is a throwaway harness (too slow for the
 * suite); the two named divergences above are pinned as tests. If either
 * property is relaxed, this paragraph stops holding and that sweep is how to
 * find out.
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

/**
 * What joins two labels of one question's run, on the write path
 * (`composeAnswerText`) and the read path (`takeLabel`) alike — stated once so
 * the two cannot drift.
 */
const SEPARATOR = ', ';

/** Spec §5.3 — the ONE place that decides the wording of a phone answer. */
export function composeAnswerText(questions: AskUserQuestionInput[], selections: string[][]): string {
  const heading = questions.length === 1 ? HEADING_ONE : HEADING_MANY;
  const lines = questions.map((q, i) => `- ${q.header}: ${(selections[i] ?? []).join(SEPARATOR)}`);
  return [heading, ...lines].join('\n');
}

/**
 * `q`'s option labels, longest first. Memoised PER QUESTION OBJECT, because
 * `takeLabel` is called once per step of every walk over every candidate close
 * and re-sorting 50 labels on each of those steps is pure waste (measured at
 * 188 ms of a 7.8 s repro — a real but secondary win next to the step budget).
 *
 * A `WeakMap` so a question object parsed for one transcript line does not
 * keep its label array alive after the line is gone. The memo assumes `q` is
 * not mutated after first use, which holds: every `AskUserQuestionInput` in
 * this module comes out of `AskUserQuestionInputSchema.parse` (or a test
 * literal) and nothing anywhere writes to `q.options`. The returned array is
 * SHARED — read it, never sort or splice it.
 */
const longestFirstLabelsByQuestion = new WeakMap<AskUserQuestionInput, string[]>();

function longestFirstLabels(q: AskUserQuestionInput): string[] {
  const memo = longestFirstLabelsByQuestion.get(q);
  if (memo !== undefined) return memo;
  const labels = q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
  longestFirstLabelsByQuestion.set(q, labels);
  return labels;
}

/**
 * Consume ONE of `q`'s option labels from the front of `rest`, plus the `", "`
 * separator that follows it, and return what is left. Longest label first, so
 * a label that itself contains `", "` is never split at its own comma.
 * Returns null when `rest` is empty, does not begin with one of THIS
 * question's labels, or the call's `TAKE_LABEL_STEP_BUDGET` is spent — this is
 * where a step is counted, so it is also where the budget refuses one.
 *
 * The single place that knows the wire shape of a label run — the `SEPARATOR`
 * joiner and the longest-first tie-break. Both walks over a run go through
 * here (`matchLabelRun`, taking one question's whole run; the positional loop
 * in `splitStubAcrossQuestions`, taking one label per question), so a change
 * to that shape cannot reach one walk and miss the other (review finding,
 * askuserquestion-answer-mechanism-3 task 2).
 *
 * A DANGLING separator is refused: the joiner is only consumed when something
 * follows it, so `rest` of `"A, "` no longer matches the label `A`.
 *
 * That is a deliberate TRADE, not a case that cannot arise. It DOES arise:
 * `TrustedText` has no `.min(1)`, so an empty option label is schema-valid;
 * `validateAnswer` (§5.2) returns ok for `['A', '']` on a multiSelect question
 * offering one (two picks, so multiSelect is required, and `''` is one of its
 * own options); and `composeAnswerText` renders that selection as `A, `. A
 * composed answer CAN therefore end in the joiner. What the refusal buys, each
 * item measured or proved rather than argued (round-4 review):
 *
 *  - `maxValueLength`'s result-neutrality: an accepted run could be two chars
 *    longer than that bound, so the bound changed `labelsFromPairFormat`'s
 *    answer on 26 of 1 647 072 swept (config, value) pairs;
 *  - a BLINDED ambiguity check: with options `b".x` and `b`, the whole value
 *    `b".x, b, ` parsed as a run whose closing quote sat PAST the bound, so
 *    the "exactly ONE candidate" check never saw that second candidate and
 *    `labelsFromPairFormat` answered `[['b']]` where the unbounded scan
 *    refused. It no longer parses, so nothing qualifying hides outside the
 *    scan. (`[['b']]` is still what that value reads as — its leading `b` is a
 *    real label followed by `"` and a value delimiter, which is the residual
 *    `labelsFromPairFormat` documents and pins. The fix takes the bound out of
 *    that answer; it does not narrow the residual.)
 *  - no composed run read as the run WITHOUT its trailing joiner: `A, ` used
 *    to read back as `[['A']]`, one pick short of the `['A', '']` that
 *    composed it, and dropping a pick silently is the wrong-attribution
 *    outcome this module exists to avoid.
 *
 * What it costs is that pick's readability: `A, ` now yields `undefined`, the
 * known, accepted degrade recorded in spec §5.3. This parser does not try to
 * read a trailing joiner as "and then the empty label", and the reason is not
 * that the information is provably gone — it is that the reading is ambiguous
 * exactly where it would be needed: `['A', ''].join(', ')` and
 * `['A, '].join(', ')` are the SAME string `A, `, so on a question offering
 * both `''` and `A, ` the two §5.2-valid selections are indistinguishable in
 * composed text. The `", "`-joiner's own semantics decide the refusal, NOT the
 * bound; the exact-match clause is what keeps a label that itself ENDS in
 * `", "` matchable, which a blanket `endsWith(', ')` test on the whole run
 * would have broken.
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
function takeLabel(q: AskUserQuestionInput, rest: string, budget: StepBudget): { label: string; rest: string } | null {
  if (rest.length === 0) return null;
  // The ONE place a step is counted, so no walk can be added that escapes the
  // budget. `exhausted` is set only here, on a REFUSAL.
  if (budget.left <= 0) {
    budget.exhausted = true;
    return null;
  }
  budget.left -= 1;
  const label = longestFirstLabels(q).find(
    (l) => rest === l || (rest.startsWith(`${l}${SEPARATOR}`) && rest.length > l.length + SEPARATOR.length),
  );
  if (label === undefined) return null;
  const after = rest.slice(label.length);
  return { label, rest: after.startsWith(SEPARATOR) ? after.slice(SEPARATOR.length) : after };
}

/**
 * Match `text` as an exact `", "`-joined run of ONE question's own option
 * labels, longest label first so a label that itself contains `", "` is not
 * split. Returns the labels picked, or null when `text` is anything else
 * (free text, a partial match, an unknown label, or empty) — and equally when
 * the call's step budget runs out mid-walk, which every caller turns into the
 * same `undefined` degrade.
 *
 * Also enforces the question's own cardinality: a single-select question
 * must yield exactly one label. This is the whole-run matcher — §4.1 clause
 * (b) (via parseAnswerText) and clause (a)'s single-question stub both go
 * through it. Clause (a)'s MULTI-question stub cannot: it takes one label per
 * question positionally, so it walks `takeLabel` directly and gets its
 * cardinality for free (exactly one label each, and the branch bails outright
 * when any question is multiSelect). Every path also rejects a run that ends
 * in a dangling `", "` — in `takeLabel`, which both walks share (round-4
 * review) — and a run that repeats a label, which is what makes "no path
 * accepts a run `validateAnswer` (§5.2) would have rejected on the way out"
 * actually true: `validateAnswer` has always rejected a duplicate selection,
 * while this matcher accepted one until round-3 review, so `parseAnswerText`
 * on `- Scope: Frontend, Frontend` returned
 * `[['Frontend', 'Frontend']]`. The module header's "never
 * re-implement the rule" applies to reading answers as much as to writing
 * them, so the duplicate check lives here, next to the cardinality check, and
 * both §4.1 clauses inherit it.
 *
 * Greedy with no backtracking — the rule parseAnswerText has always used.
 * Two consequences, both deliberately accepted rather than searched around:
 *
 *  - WITHIN one question (here): if it offers both `"A"` and `"A, B"`, the
 *    longer is tried first. Where only the shorter one would parse, the run is
 *    reported as no match — "can't tell", which degrades to an unhighlighted
 *    card. Where BOTH parse, longest-first just wins, and then the attribution
 *    is complete and WRONG, which no degrade covers: a question offering
 *    `['A', 'B', 'A, B']` composes the selection `['A', 'B']` to `A, B` and
 *    reads it back as `[['A, B']]`. Measured, not theorised — a sweep of every
 *    §5.2-valid selection of 44 question configs (196 composed answers) hit it
 *    twice, both this shape (round-4 review, recorded here rather than
 *    fixed: closing it needs the same ambiguity search the case below
 *    declines, and it carries the same bound — display-only, since nothing is
 *    written back from a parsed stub).
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
function matchLabelRun(q: AskUserQuestionInput, text: string, budget: StepBudget): string[] | null {
  const picked: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const step = takeLabel(q, rest, budget);
    if (step === null) return null;
    picked.push(step.label);
    // Two rejections the checks below would reach ANYWAY, brought forward to
    // where the walk can still be abandoned. Both are verdict-identical, not
    // approximations:
    //
    //  - MORE picks than the question has options means some label was picked
    //    twice — every pick comes from `longestFirstLabels(q)`, so the picks
    //    are drawn from a set of at most `options.length` distinct values
    //    (`schemas.ts` refines option labels unique, and the pigeonhole holds
    //    even without that refine, e.g. for a hand-built question) — and the
    //    duplicate check below rejects a repeat. So `null` either way; the
    //    only difference is that the walk stops after ~`options.length` steps
    //    instead of running to the end of the text. That is the single biggest
    //    win of the three: it is what turns the 51 102 ms repeat-walk shape in
    //    `TAKE_LABEL_STEP_BUDGET` into a bounded parse.
    //  - the cardinality check, evaluated on each push rather than once at the
    //    end. `picked.length` only grows, so "it was ever > 1" and "it ended
    //    > 1" are the same condition; this is the same single statement of the
    //    rule (`allowsMultiple`) moved, not a second copy of it.
    if (picked.length > q.options.length) return null;
    if (picked.length > 1 && !allowsMultiple(q)) return null;
    rest = step.rest;
  }
  if (picked.length === 0) return null;
  if (new Set(picked).size !== picked.length) return null;
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
  const budget = newStepBudget();
  const out: string[][] = [];
  for (const [i, q] of questions.entries()) {
    const line = lines[i + 1] ?? '';
    const prefix = `- ${q.header}: `;
    if (!line.startsWith(prefix)) return undefined;
    // A refused step makes `matchLabelRun` return null, so exhaustion here is
    // already the all-or-nothing undefined below — there is no candidate scan
    // on this path for it to blind.
    const picked = matchLabelRun(q, line.slice(prefix.length), budget);
    if (picked === null) return undefined;
    out.push(picked);
  }
  return out;
}
