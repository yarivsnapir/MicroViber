import { describe, it, expect } from 'vitest';
import {
  detectAskUserQuestion, isResolvingUserEntry, composeAnswerText, parseAnswerText, ANSWER_TEXT_MAX_CHARS,
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
  it('resolves on a matching tool_result and splits its labels', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes, No' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toEqual({ by: 'tool_result', selectedLabels: ['Yes', 'No'] });
  });
  it('a tool_result for a different id, with no text, does not resolve', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_OTHER', content: 'ok' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
  });
  it('normalises non-string, empty, and <tool_use_error> content to selectedLabels: undefined', () => {
    for (const content of [{ some: 'object' }, '', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>']) {
      const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] });
      expect(isResolvingUserEntry(e, 'toolu_1')).toEqual({ by: 'tool_result', selectedLabels: undefined });
    }
  });
});

describe('isResolvingUserEntry — clause (b) human turn', () => {
  it('resolves on a plain text turn', () => {
    expect(isResolvingUserEntry(textEntry('Yes'), 'toolu_1')).toEqual({ by: 'text', text: 'Yes' });
  });
  it('resolves on string content (the interruption marker shape)', () => {
    expect(isResolvingUserEntry(userEntry({ content: '[Request interrupted by user]' }), 'toolu_1')).toEqual({ by: 'text', text: '[Request interrupted by user]' });
  });
  it('does NOT resolve on the isMeta handshake turn', () => {
    expect(isResolvingUserEntry(textEntry('Continue from where you left off.', { isMeta: true }), 'toolu_1')).toBeNull();
  });
  it('isMeta: false is a human turn', () => {
    expect(isResolvingUserEntry(textEntry('hi', { isMeta: false }), 'toolu_1')?.by).toBe('text');
  });
  it('does NOT resolve on an entry carrying a known-synthetic origin (task-notification)', () => {
    const e = userEntry({ content: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
  });
  it('DOES resolve on an entry carrying origin.kind: "human" (F18 addendum FAIL — real human turns are NOT origin-less)', () => {
    expect(isResolvingUserEntry(textEntry('continue', { origin: { kind: 'human' } }), 'toolu_1')).toEqual({ by: 'text', text: 'continue' });
  });
  it('a tool_result-only entry has no human text and does not resolve via (b)', () => {
    const e = userEntry({ content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] });
    expect(isResolvingUserEntry(e, 'toolu_1')).toBeNull();
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
    expect(parseAnswerText([q1, q2], text)).toEqual(['Yes', 'Frontend, and docs', 'Backend']);
  });
  it('returns undefined for free text, a wrong heading, a missing line, or an unknown label', () => {
    expect(parseAnswerText([q1], 'just do it')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1, q2], 'Answering your questions:\n- Confirm: Yes')).toBeUndefined();
    expect(parseAnswerText([q1], 'Answering your question:\n- Confirm: Maybe')).toBeUndefined();
  });
  it('exports the 4000-char backstop', () => { expect(ANSWER_TEXT_MAX_CHARS).toBe(4000); });
});
