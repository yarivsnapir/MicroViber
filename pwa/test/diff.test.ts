import { describe, it, expect } from 'vitest';
import { lineDiff } from '../src/lib/diff.js';

describe('lineDiff', () => {
  it('marks a changed middle line and keeps the surrounding context', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('handles a pure addition', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('handles a pure deletion', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('reports no change as all context', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'ctx', text: 'b' },
    ]);
  });

  it('renders a whole-file write as all additions', () => {
    // An empty oldText splits to [''] — one REAL empty line the prefix/suffix
    // trim cannot match, so it is honestly reported as a deletion rather than
    // special-cased away. DiffView draws it as a bare `- ` row, which is the
    // truth for a file that had no prior content.
    expect(lineDiff('', 'a\nb')).toEqual([
      { type: 'del', text: '' },
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('caps runaway context so a one-line edit in a big file stays a small hunk (AC21)', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const edited = big.replace('line 100', 'line 100 changed');
    const out = lineDiff(big, edited);
    expect(out.length).toBeLessThan(20);
    expect(out.some((l) => l.type === 'add' && l.text === 'line 100 changed')).toBe(true);
    expect(out.filter((l) => l.type === 'ctx').length).toBeLessThanOrEqual(6);
  });
});
