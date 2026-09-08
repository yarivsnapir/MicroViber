export interface DiffLine {
  type: 'ctx' | 'del' | 'add';
  text: string;
}

const CONTEXT_LINES = 3;

/**
 * Single-hunk line diff by common-prefix / common-suffix trim. Deliberately
 * NOT a full LCS: Edit and Write produce one contiguous change, and this
 * avoids adding a diff dependency to the phone's bundle (story-1 AC24).
 *
 * Context is capped at CONTEXT_LINES either side, so a one-line edit inside a
 * large file renders as a small hunk rather than the whole file (AC21).
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  const leadFrom = Math.max(0, prefix - CONTEXT_LINES);
  // `?? ''` rather than `!` — noUncheckedIndexedAccess is on, and an assertion
  // here would be a lie the compiler cannot check.
  for (let i = leadFrom; i < prefix; i++) out.push({ type: 'ctx', text: a[i] ?? '' });
  for (let i = prefix; i < a.length - suffix; i++) out.push({ type: 'del', text: a[i] ?? '' });
  for (let i = prefix; i < b.length - suffix; i++) out.push({ type: 'add', text: b[i] ?? '' });

  const tailStart = a.length - suffix;
  const tailEnd = Math.min(a.length, tailStart + CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i++) out.push({ type: 'ctx', text: a[i] ?? '' });

  return out;
}
