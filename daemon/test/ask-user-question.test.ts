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
  it('resolves on a matching tool_result and attributes its labels to the one question', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] });
    expect(isResolvingUserEntry(e, pending1)).toEqual({ by: 'tool_result', selectedLabels: [['Yes']] });
  });
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

  it('an empty label run after the prefix is undefined — a header line with no answer is not an answer', () => {
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: ')).toBeUndefined();
  });

  it('no questions at all is undefined, never a defined-but-empty [] — the card reads "defined" as "one entry per question" (task-5 review finding)', () => {
    // Unreachable via AskUserQuestionInputSchema (.min(1)); pinned because
    // splitStubAcrossQuestions guards the same case and the two must agree.
    expect(parseAnswerText([], 'Answering your questions:')).toBeUndefined();
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
