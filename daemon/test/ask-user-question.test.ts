import { describe, it, expect } from 'vitest';
import {
  detectAskUserQuestion, isResolvingUserEntry, composeAnswerText, parseAnswerText, ANSWER_TEXT_MAX_CHARS, validateAnswer,
} from '../src/lib/claude-adapter/ask-user-question.js';
import { TranscriptLineSchema, type UserTranscriptLine, type AskUserQuestionInput } from '../src/lib/claude-adapter/schemas.js';

const q1: AskUserQuestionInput = { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false };
const q2: AskUserQuestionInput = { question: 'Which parts?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }, { label: 'Frontend, and docs', description: '' }], multiSelect: true };

function userEntry(extra: Record<string, unknown>): UserTranscriptLine {
  const parsed = TranscriptLineSchema.parse({ type: 'user', message: { role: 'user', ...extra }, timestamp: '2026-09-03T10:00:00Z', ...('isMeta' in extra ? { isMeta: extra.isMeta } : {}), ...('origin' in extra ? { origin: extra.origin } : {}) });
  if (parsed.type !== 'user') throw new Error('not a user line');
  return parsed;
}
const textEntry = (text: string, top: Record<string, unknown> = {}) => userEntry({ content: [{ type: 'text', text }], ...top });

describe('detectAskUserQuestion', () => {
  it('returns the id + questions for a well-formed AskUserQuestion tool_use', () => {
    const d = detectAskUserQuestion([{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [q1] } }]);
    expect(d?.toolUseId).toBe('toolu_1');
    expect(d?.questions[0]?.header).toBe('Confirm');
  });
  it('returns null for another tool, malformed input, or non-array content', () => {
    expect(detectAskUserQuestion([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])).toBeNull();
    expect(detectAskUserQuestion([{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { nope: 1 } }])).toBeNull();
    expect(detectAskUserQuestion('text')).toBeNull();
  });
});

describe('isResolvingUserEntry — clause (a) tool_result', () => {
  const pending1 = { toolUseId: 'toolu_1', questions: [q1] };
  it('a tool_result for a different id, with no text, does not resolve', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_OTHER', content: 'ok' }] });
    expect(isResolvingUserEntry(e, pending1)).toBeNull();
  });
  it('normalises non-string, empty, and <tool_use_error> content to selectedLabels: undefined', () => {
    for (const content of [{ some: 'object' }, '', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>']) {
      const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] });
      expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
    }
  });
  it('content that is not a run of this question\'s own labels is undefined, not junk tokens (story-3: the old blind split(",") emitted unmatchable strings)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'go with the first one' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('a single multiSelect question takes the whole run — no boundary to guess', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Frontend, Backend' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend', 'Backend']] });
  });
  it('two single-select questions split positionally, so shared labels stay apart (story-3 AC2)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });
  it('several questions where any is multiSelect is genuinely ambiguous — undefined, never a guess (story-3 AC2)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, Frontend, Backend' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1, q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('a run of two labels for a SINGLE-select question is undefined, not a two-pick answer (cardinality, §5.2)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('leftover text after every question has taken its label is undefined (the walk must consume the stub exactly)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No, Yes' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });
  it('the positional walk matches longest-label-first too, so a label containing ", " is not split across two questions (story-3 AC2)', () => {
    const scope: AskUserQuestionInput = {
      question: 'Which parts?', header: 'Scope',
      options: [{ label: 'Frontend', description: '' }, { label: 'Frontend, and docs', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Frontend, and docs, No' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [scope, q1] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend, and docs'], ['No']] });
  });
  it('pins the greedy walk\'s DEFINED, DETERMINISTIC choice on a stub with two equally valid parses — this asserts which parse we commit to, NOT that it is the correct one', () => {
    // Known ambiguity: Q1's 'A, B' and Q2's 'B, C' both prefix-split "A, B, C", so
    // [['A'], ['B, C']] is just as valid an attribution as the one asserted here. The
    // longest-first walk has no backtracking and takes the first parse it finds; when
    // labels are this pathological the highlighted option can be the wrong one
    // (display-only — see matchLabelRun's doc comment). Pinning it keeps the choice
    // deterministic and makes any future change to the walk visible.
    const qa: AskUserQuestionInput = {
      question: 'First?', header: 'A-side',
      options: [{ label: 'A', description: '' }, { label: 'A, B', description: '' }],
      multiSelect: false,
    };
    const qb: AskUserQuestionInput = {
      question: 'Second?', header: 'B-side',
      options: [{ label: 'B, C', description: '' }, { label: 'C', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'A, B, C' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [qa, qb] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['A, B'], ['C']] });
  });
  it('an exhausted stub never "answers" a later question that happens to offer an empty label (schemas.ts allows label: "")', () => {
    const extra: AskUserQuestionInput = {
      question: 'Anything else?', header: 'Extra',
      options: [{ label: '', description: '' }, { label: 'Later', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1, extra] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  const REAL_TAIL = '. You can now continue with these answers in mind.';
  const realStub = (pairs: [string, string][]) =>
    `Your questions have been answered: ${pairs.map(([q, l]) => `"${q}"="${l}"`).join(', ')}${REAL_TAIL}`;

  it('parses the laptop\'s REAL pair-format stub for one question (AC7 — 195 of 349 observed stubs)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('parses the REAL pair-format stub for two questions that share an option set (AC7 — the whole point)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const qs = [yn('First'), yn('Second')];
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['First?', 'Yes'], ['Second?', 'No']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: qs }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });

  it('a multiSelect question\'s pair value is a ", "-joined run of its own labels', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which parts?', 'Frontend, Backend']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend', 'Backend']] });
  });

  it('a free-text ("Other") value matches no option label, so the WHOLE call is undefined (AC7 + AC3 all-or-nothing)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'actually, let me think about it']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a pair stub missing one of the pending questions is undefined, not a partial answer', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['First?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('order does not matter — anchoring is per question, not positional', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Second?', 'No'], ['First?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No']] });
  });

  it('the bare-label run still works — it is the fallback, not replaced (the 9 of 308 that matched)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('a question whose own question text is empty is undefined — an empty anchor would match anywhere', () => {
    const blank: AskUserQuestionInput = { question: '', header: 'Blank', options: [{ label: 'Yes', description: '' }], multiSelect: false };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [blank] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a pair value that itself contains a `"` is attributed to that label — the close is the candidate that parses, not the first quote', () => {
    const q: AskUserQuestionInput = {
      question: 'Proceed?', header: 'Confirm',
      options: [{ label: 'Say "hi"', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Say "hi"']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Say "hi"']] });
  });

  it('a pair value containing `"` whose truncation is ALSO a shorter label of the same question is attributed to the FULL label — the delimiter check rules the truncation out, so this is now correct rather than merely a safe degrade', () => {
    const q: AskUserQuestionInput = {
      question: 'Proceed?', header: 'Confirm',
      options: [{ label: 'Yes', description: '' }, { label: 'Yes"maybe', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes"maybe']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes"maybe']] });
  });

  it('a question text that itself contains `"` still anchors — the anchor is a literal, so quotes inside it are just characters', () => {
    const q: AskUserQuestionInput = {
      question: 'Use "strict" mode?', header: 'Confirm',
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Use "strict" mode?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('a free-text value that merely BEGINS with a valid label followed by a quote is undefined, never that label (round-1 review: the highest-volume wrong attribution — the person typed the opposite)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes" — actually no']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('PINS the residual: a free-text value whose leading run is a label followed by `"` AND a value delimiter still parses as that label — narrowed, not closed, and asserted as BEHAVIOUR not correctness', () => {
    // `Yes". Actually no` puts a real label, a quote, and then the `.` that ends
    // a pair value in exactly the order the format uses, so the candidate scan
    // cannot tell it from a genuine `"Yes".` pair. Display-only, like
    // matchLabelRun's greedy residual: nothing is written back from a parsed
    // stub, so the cost is a dimmed card highlighting the wrong chip.
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes". Actually no']]) }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });

  it('two pending questions with IDENTICAL question text is undefined, not the first pair\'s answer reported twice (round-1 review: indexOf takes the first occurrence, and the schema has no cross-question uniqueness refine)', () => {
    const same = (header: string): AskUserQuestionInput => ({
      question: 'Proceed?', header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes'], ['Proceed?', 'No']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [same('First'), same('Second')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('two DISTINCT question texts where one question\'s anchor also occurs INSIDE the other\'s pair is undefined, not a confidently WRONG answer (round-3 review: distinctness is not enough — the anchor must occur exactly ONCE)', () => {
    // Both texts are distinct AND schema-valid (TrustedText rejects control
    // characters only), so neither the empty-text nor the not-distinct
    // precondition catches this. Q_A's anchor `"A"="` occurs three times in the
    // stub; the first occurrence belongs to Q_B's pair, so `indexOf` read Q_B's
    // value and reported Q_A as `No` while Q_A's OWN pair says `Yes` — the same
    // family as the round-1 and round-2 mis-attributions, but confident-wrong
    // rather than a degrade, which is why occurring more than once now rejects.
    const yn = (question: string, header: string): AskUserQuestionInput => ({
      question, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['A"="No", "A', 'Yes'], ['A', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('A', 'A-side'), yn('A"="No", "A', 'B-side')] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a pair value that repeats one of its own labels is undefined — matchLabelRun rejects a duplicate run, which validateAnswer (§5.2) would have rejected on the way out (round-3 review)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which parts?', 'Frontend, Frontend']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a pair value that ends in a dangling ", " is undefined, never the run without it — a trailing separator is never a legitimate value (round-4 review)', () => {
    // composeAnswerText puts ", " BETWEEN labels only and validateAnswer (§5.2)
    // never emits a run that ends in one, so `A, B, ` is not a run of this
    // question's labels at all — reporting [['A', 'B']] for it is a confident
    // WRONG attribution, not a degrade.
    //
    // The third option is what makes this bite: maxValueLength here is 15, so
    // the dangling value sits INSIDE the candidate scan. On the reviewer's
    // two-option question the same value is 2 chars past the bound, which is
    // the same defect seen from the other side — the bound, documented as
    // cost-only, was deciding the result (undefined bounded, [['A','B']]
    // unbounded: the one family of disagreement in a 1 647 072-pair sweep).
    const ab: AskUserQuestionInput = {
      question: 'Which?', header: 'Many',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'Everything', description: '' }],
      multiSelect: true,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which?', 'A, B, ']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [ab] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
    // The same run WITHOUT the dangling separator is a legitimate value and is
    // still attributed — this rejects a trailing separator, not the labels.
    const ok = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which?', 'A, B']]) }] });
    expect(isResolvingUserEntry(ok, { toolUseId: 'toolu_1', questions: [ab] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['A', 'B']] });
  });

  it('a pair value that IS a label ending in ", " still matches — the dangling-separator rejection tests the joiner, not the run\'s last two characters', () => {
    // The guard lives in takeLabel's separator clause, so the exact-match clause
    // still accepts a label that itself ends in ", " (schemas.ts types a label
    // as TrustedText, so this is schema-valid). A blanket `text.endsWith(', ')`
    // rejection in matchLabelRun would have broken this — that is why the fix
    // is where it is.
    const trailing: AskUserQuestionInput = {
      question: 'Which?', header: 'Many',
      options: [{ label: 'A, ', description: '' }, { label: 'B', description: '' }],
      multiSelect: false,
    };
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which?', 'A, ']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [trailing] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['A, ']] });
  });

  it('the over-long dangling-separator run no longer parses, so a candidate PAST the scan bound can no longer hide a second candidate from the ambiguity check (round-4 review) — and the value in bound is still refused as ambiguous', () => {
    // Options `b".x` and `b`: maxValueLength is 7, so the pair's own closing
    // quote at offset 9 sat outside the scan. Before the round-4 fix the
    // out-of-bound slice `b".x, b, ` DID parse (dangling separator accepted),
    // so bounded read one candidate (`[['b']]`) while unbounded saw two and
    // refused — the bound was deciding the answer. It no longer parses, so
    // bounded and unbounded now agree.
    //
    // What they agree ON is the residual this module already pins below and in
    // spec §4.1: the value's leading `b` is a real label followed by `"` and
    // then the `.` that legitimately ends a pair value, exactly the
    // `Yes". Actually no` shape. Asserted as BEHAVIOUR, not correctness —
    // display-only, since nothing is written back from a parsed stub.
    const bq: AskUserQuestionInput = {
      question: 'Which?', header: 'Many',
      options: [{ label: 'b".x', description: '' }, { label: 'b', description: '' }],
      multiSelect: true,
    };
    const dangling = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which?', 'b".x, b, ']]) }] });
    expect(isResolvingUserEntry(dangling, { toolUseId: 'toolu_1', questions: [bq] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['b']] });
    // Control: without the trailing separator the whole value is a valid run
    // AND sits inside the bound, so two candidates qualify and the ambiguity
    // check does its job.
    const inBound = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which?', 'b".x, b']]) }] });
    expect(isResolvingUserEntry(inBound, { toolUseId: 'toolu_1', questions: [bq] }))
      .toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('an empty questions array is undefined, never a DEFINED but EMPTY [] — the three halves of §4.1 must agree (splitStubAcrossQuestions and parseAnswerText already guard it)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Proceed?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [] })).toEqual({ by: 'tool_result', selectedLabels: undefined });
  });

  it('a DELIMITER-dense stub returns promptly — the candidate scan is bounded by the question\'s own maximum value length (963 ms unbounded at this size on a schema-legal 50-option question, 0 ms bounded)', () => {
    const options = Array.from({ length: 50 }, (_, i) => ({ label: `label-${i}`, description: '' }));
    const q: AskUserQuestionInput = { question: 'Which?', header: 'Many', options, multiSelect: true };
    // The tail must be DELIMITER-dense (`".` repeated), not merely quote-dense:
    // closesValue rejects a bare run of quotes in O(1) before matchLabelRun is
    // ever reached, so a quote-only tail exercises closesValue and leaves the
    // bound untested. Every `"` here is followed by the `.` that legitimately
    // ends a pair value, so every one is a candidate the unbounded scan re-runs
    // matchLabelRun over, across a slice that grows with the tail.
    const stub = `Your questions have been answered: "Which?"="${options.map((o) => o.label).join(', ')}${'".'.repeat(8000)}`;
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: stub }] });
    const startedAt = Date.now();
    // The bound is a cost control, not a behaviour change: the label run before
    // the tail is a legitimate value, so it is attributed either way.
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q] }))
      .toEqual({ by: 'tool_result', selectedLabels: [options.map((o) => o.label)] });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('the three-question shape parses too (AC7 — the third of the top three observed shapes, 3 of 349)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['First?', 'Yes'], ['Second?', 'No'], ['Third?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [yn('First'), yn('Second'), yn('Third')] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Yes'], ['No'], ['Yes']] });
  });

  it('a multiSelect question ALONGSIDE another question parses under the pair format — the case the bare-label fallback has to refuse as ambiguous (AC7 closes AC2\'s gap, it does not merely restate it)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: realStub([['Which parts?', 'Frontend, Backend'], ['Proceed?', 'Yes']]) }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q2, q1] }))
      .toEqual({ by: 'tool_result', selectedLabels: [['Frontend', 'Backend'], ['Yes']] });
  });

  it('a pair value at the very end of the stub, with no trailing sentence at all, still closes (one of the 107 shapes)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Your questions have been answered: "Proceed?"="Yes"' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });
});

describe('isResolvingUserEntry — clause (b) human turn', () => {
  it('resolves on a plain text turn', () => {
    expect(isResolvingUserEntry(textEntry('Yes'), { toolUseId: 'toolu_1', questions: [q1] })).toEqual({ by: 'text', text: 'Yes' });
  });
  it('resolves on string content (the interruption marker shape)', () => {
    expect(isResolvingUserEntry(userEntry({ content: '[Request interrupted by user]' }), { toolUseId: 'toolu_1', questions: [q1] })).toEqual({ by: 'text', text: '[Request interrupted by user]' });
  });
  it('does NOT resolve on the isMeta handshake turn', () => {
    expect(isResolvingUserEntry(textEntry('Continue from where you left off.', { isMeta: true }), { toolUseId: 'toolu_1', questions: [q1] })).toBeNull();
  });
  it('isMeta: false is a human turn', () => {
    expect(isResolvingUserEntry(textEntry('hi', { isMeta: false }), { toolUseId: 'toolu_1', questions: [q1] })?.by).toBe('text');
  });
  it('does NOT resolve on an entry carrying a known-synthetic origin (task-notification)', () => {
    const e = userEntry({ content: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1] })).toBeNull();
  });
  it('DOES resolve on an entry carrying origin.kind: "human" (F18 addendum FAIL — real human turns are NOT origin-less)', () => {
    expect(isResolvingUserEntry(textEntry('continue', { origin: { kind: 'human' } }), { toolUseId: 'toolu_1', questions: [q1] })).toEqual({ by: 'text', text: 'continue' });
  });
  it('a tool_result-only entry has no human text and does not resolve via (b)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1] })).toBeNull();
  });
});

describe('composeAnswerText / parseAnswerText', () => {
  it('one question: singular heading, one line', () => {
    expect(composeAnswerText([q1], [['Yes']])).toBe('Answering your question:\n- Confirm: Yes');
  });
  it('several questions: plural heading, one line each, labels joined by ", "', () => {
    expect(composeAnswerText([q1, q2], [['No'], ['Frontend', 'Backend']])).toBe('Answering your questions:\n- Confirm: No\n- Scope: Frontend, Backend');
  });
  it('round-trips, including a label that itself contains ", "', () => {
    const text = composeAnswerText([q1, q2], [['Yes'], ['Frontend, and docs', 'Backend']]);
    expect(parseAnswerText([q1, q2], text)).toEqual([['Yes'], ['Frontend, and docs', 'Backend']]);
  });
  it('returns undefined for free text, a wrong heading, a missing line, or an unknown label', () => {
    expect(parseAnswerText([q1], 'just do it')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1, q2], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: Maybe')).toBeUndefined();
  });
  it('exports the 4000-char backstop', () => { expect(ANSWER_TEXT_MAX_CHARS).toBe(4000); });

  it('groups labels by question: one inner array per question, in question order (story-3 AC1)', () => {
    const text = composeAnswerText([q1, q2], [['No'], ['Backend']]);
    expect(parseAnswerText([q1, q2], text)).toEqual([['No'], ['Backend']]);
  });

  it('two questions sharing an option label keep their own answers apart (story-3, the regression this story exists for)', () => {
    const yn = (header: string): AskUserQuestionInput => ({
      question: `${header}?`, header,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
    });
    const qs = [yn('First'), yn('Second')];
    const text = composeAnswerText(qs, [['Yes'], ['No']]);
    expect(parseAnswerText(qs, text)).toEqual([['Yes'], ['No']]);
  });

  it('a single-select question offered two labels is undefined — the shared matcher enforces cardinality (§5.2)', () => {
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: Yes, No')).toBeUndefined();
  });

  it('a run that repeats a label is undefined, on this clause too — both §4.1 clauses go through the shared matcher, so neither can accept what validateAnswer (§5.2) rejects as a duplicate selection (round-3 review)', () => {
    expect(parseAnswerText([q2], 'Answering your question:\n- Scope: Frontend, Frontend')).toBeUndefined();
  });

  it('an empty label run after the prefix is undefined — a header line with no answer is not an answer', () => {
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: ')).toBeUndefined();
  });

  it('no questions at all is undefined, never a defined-but-empty [] — the card reads "defined" as "one entry per question" (task-5 review finding)', () => {
    // Unreachable via AskUserQuestionInputSchema (.min(1)); pinned because
    // splitStubAcrossQuestions guards the same case and the two must agree.
    expect(parseAnswerText([], 'Answering your questions:')).toBeUndefined();
  });

  it('a run that ends in a dangling ", " is undefined, on this clause too — takeLabel is shared, so neither §4.1 clause can accept a trailing separator (round-4 review)', () => {
    expect(parseAnswerText([q2], 'Answering your question:\n- Scope: Frontend, Backend, ')).toBeUndefined();
  });

  it('an empty option label is no longer SILENTLY DROPPED from a composed answer: `["A", ""]` read back as `[["A"]]`, one pick short — now undefined (round-4 review)', () => {
    // schemas.ts types a label as TrustedText with no .min(1), so an empty
    // option label is schema-valid AND validateAnswer accepts selecting it —
    // this is a real write-path answer, not a synthetic one. composeAnswerText
    // renders it as the dangling separator in `A, `, from which the empty pick
    // is unrecoverable; reporting `[['A']]` claimed a one-option answer to a
    // two-option selection, which is the wrong-attribution outcome this module
    // forbids. "Can't tell" is the only honest read of `A, `.
    const withBlank: AskUserQuestionInput = {
      question: 'Which parts?', header: 'Scope',
      options: [{ label: 'A', description: '' }, { label: '', description: '' }],
      multiSelect: true,
    };
    expect(validateAnswer({ toolUseId: 'toolu_1', questions: [withBlank] }, { toolUseId: 'toolu_1', selections: [['A', '']] }))
      .toEqual({ ok: true });
    const text = composeAnswerText([withBlank], [['A', '']]);
    expect(text).toBe('Answering your question:\n- Scope: A, ');
    expect(parseAnswerText([withBlank], text)).toBeUndefined();
  });

  it('a label that itself ENDS in ", " still round-trips, alone and mid-run — the rejection is of the joiner with nothing after it, not of a run\'s last two characters', () => {
    const trailing: AskUserQuestionInput = {
      question: 'Which parts?', header: 'Scope',
      options: [{ label: 'A, ', description: '' }, { label: 'B', description: '' }],
      multiSelect: true,
    };
    const alone = composeAnswerText([trailing], [['A, ']]);
    expect(alone).toBe('Answering your question:\n- Scope: A, ');
    expect(parseAnswerText([trailing], alone)).toEqual([['A, ']]);
    const midRun = composeAnswerText([trailing], [['A, ', 'B']]);
    expect(midRun).toBe('Answering your question:\n- Scope: A, , B');
    expect(parseAnswerText([trailing], midRun)).toEqual([['A, ', 'B']]);
  });
});

describe('isResolvingUserEntry — origin.kind: "auto-continuation" (review finding: F18 clause 1 names this SDK origin explicitly)', () => {
  it('does NOT resolve on an entry carrying origin.kind: "auto-continuation", even without isMeta', () => {
    const e = userEntry({ content: 'Continue from where you left off.', origin: { kind: 'auto-continuation' } });
    expect(isResolvingUserEntry(e, { toolUseId: 'toolu_1', questions: [q1] })).toBeNull();
  });
});

const pending = {
  toolUseId: 'toolu_1',
  questions: [
    { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false },
    { question: 'Which?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }], multiSelect: true },
  ],
};

describe('validateAnswer (spec §5.2)', () => {
  it('accepts a complete, in-options answer', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes'], ['Frontend', 'Backend']] })).toEqual({ ok: true });
  });
  it('rejects when nothing is pending', () => {
    expect(validateAnswer(null, { toolUseId: 'toolu_1', selections: [['Yes'], ['Frontend']] })).toEqual({ ok: false, message: 'question is no longer pending' });
  });
  it('rejects a toolUseId that is not the pending one', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_OLD', selections: [['Yes'], ['Frontend']] })).toEqual({ ok: false, message: 'question is no longer pending' });
  });
  it('rejects a selections length that does not cover every question, and an empty per-question list', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes']] })).toEqual({ ok: false, message: 'answer must cover every question' });
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes'], []] })).toEqual({ ok: false, message: 'answer must cover every question' });
  });
  it('rejects several labels for a single-select question', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes', 'No'], ['Frontend']] })).toEqual({ ok: false, message: 'question Confirm accepts one option' });
  });
  it('rejects a label that is not one of that question\'s options (exact match)', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['yes'], ['Frontend']] })).toEqual({ ok: false, message: 'unknown option for Confirm' });
  });
  it('rejects a duplicate selection within one question, even for multiSelect (review finding — a real UI can never produce this)', () => {
    expect(validateAnswer(pending, { toolUseId: 'toolu_1', selections: [['Yes'], ['Frontend', 'Frontend']] })).toEqual({ ok: false, message: 'question Scope lists a duplicate selection' });
  });
});
