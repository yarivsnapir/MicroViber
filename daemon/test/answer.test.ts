import { describe, it, expect } from 'vitest';
import { canonicalAnswerBody, validateAnswer } from '../src/domain/answer.js';

const pending = {
  toolUseId: 'toolu_1',
  questions: [
    { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false },
    { question: 'Which?', header: 'Scope', options: [{ label: 'Frontend', description: '' }, { label: 'Backend', description: '' }], multiSelect: true },
  ],
};

describe('canonicalAnswerBody', () => {
  it('is a stable JSON of toolUseId + selections in submitted order', () => {
    expect(canonicalAnswerBody({ toolUseId: 't', selections: [['A'], ['B', 'C']] })).toBe('{"toolUseId":"t","selections":[["A"],["B","C"]]}');
  });
});

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
});
