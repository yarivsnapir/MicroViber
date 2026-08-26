import { describe, it, expect } from 'vitest';
import { promptDisplay } from '../src/lib/prompt-display.js';

describe('promptDisplay (spec §7)', () => {
  it('queued shows the waiting note, no resend, never a false success', () => {
    expect(promptDisplay('queued')).toMatchObject({ tone: 'pending', showResend: false });
  });
  it('expired and failed keep the text and offer resend, with distinct copy', () => {
    expect(promptDisplay('expired')).toMatchObject({ showResend: true, keepText: true, message: 'Never picked up' });
    expect(promptDisplay('failed')).toMatchObject({ showResend: true, keepText: true, message: "Couldn't reach the session" });
  });
  it('accepted is clean/good', () => {
    expect(promptDisplay('accepted').tone).toBe('good');
  });
});
