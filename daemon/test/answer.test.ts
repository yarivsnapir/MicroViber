import { describe, it, expect } from 'vitest';
import { canonicalAnswerBody } from '../src/domain/answer.js';

describe('canonicalAnswerBody', () => {
  it('is a stable JSON of toolUseId + selections in submitted order', () => {
    expect(canonicalAnswerBody({ toolUseId: 't', selections: [['A'], ['B', 'C']] })).toBe('{"toolUseId":"t","selections":[["A"],["B","C"]]}');
  });
});
