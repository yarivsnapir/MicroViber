import { describe, it, expect } from 'vitest';
import { firstSentence } from '../src/lib/text.js';

describe('firstSentence', () => {
  it('cuts at the first sentence-ending punctuation', () => {
    expect(firstSentence('Fix the bug. Also update the docs.')).toBe('Fix the bug.');
  });

  it('cuts at the first newline when it comes before any punctuation', () => {
    expect(firstSentence('Fix the bug\nAlso update the docs.')).toBe('Fix the bug');
  });

  it('returns the whole text unchanged when short and unpunctuated', () => {
    expect(firstSentence('do the thing')).toBe('do the thing');
  });

  it('truncates with an ellipsis when the first sentence exceeds maxLen', () => {
    const long = 'a'.repeat(100) + '.';
    const result = firstSentence(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(firstSentence('   hello world   ')).toBe('hello world');
  });
});
