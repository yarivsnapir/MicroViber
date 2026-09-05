// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);

describe('Transcript AskUserQuestion rendering (spec §6)', () => {
  it('renders a pending question expanded, never collapsed to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer={false} answerInFlight={null} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders a resolved question read-only with the selected option highlighted', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer={false} answerInFlight={null} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    const yes = screen.getByText('Yes');
    expect(yes.className).toMatch(/amber|selected/);
  });

  it('a non-AskUserQuestion tool call is unaffected — still collapses to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer={false} answerInFlight={null} events={[
      { kind: 'tool', at: '2026-01-01T00:00:00Z', name: 'Bash', summary: 'ran a command' },
    ]} />);
    // The tool row's summary is a plain trailing text node (" · " + summary,
    // not its own element — see Transcript.tsx's 'tool' case, unmodified by
    // this task), so getByText's exact-string form never matches it; a regex
    // matches the same node without depending on the leading separator.
    expect(screen.getByText(/ran a command/)).toBeInTheDocument();
  });

  it('a resolved question renders its options as inert (non-interactive) even when canAnswer + onAnswer are provided', () => {
    const onAnswer = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={onAnswer} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.queryByRole('radio', { name: 'No' })).toBeNull();
  });

  it('delegates to AskUserQuestionCard: canAnswer + onAnswer make a pending question interactive and Send answers submits', () => {
    const onAnswer = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={onAnswer} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
  });

  it('a pending question renders inert options when canAnswer is false', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer={false} answerInFlight={null} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.queryByRole('radio', { name: 'No' })).toBeNull();
  });

  // Final-review fix (story askuserquestion-answer-mechanism-2): rows are
  // keyed on `q:${toolUseId}` for askUserQuestion events, not the array
  // index, because the daemon's transcript is a bounded tail window — an
  // older event can drop out from under a still-in-progress card, shifting
  // every later index down by one. A single askUserQuestion row shifting
  // position is NOT a discriminating test here: `key={i}` and `key={q:...}`
  // agree whenever only one askUserQuestion element exists, and disagree
  // with a neighboring non-askUserQuestion row only because the element
  // TYPE also changes at that slot (which forces a remount under either
  // scheme). The real bug needs two askUserQuestion rows sharing the same
  // array slot across renders: with `key={i}`, the surviving DOM/state
  // instance at index 0 is whichever one WAS at index 0 before (t1's,
  // untouched) — React updates it in place with t2's props but keeps t1's
  // stale internal `picks` state, silently discarding t2's real selection.
  // Keyed on toolUseId, React matches instances by identity across the
  // reorder/removal and t2's own state (with its pick) survives correctly.
  it('keeps in-progress picks when an older event drops out of the array (keyed on toolUseId, not index — final-review fix)', () => {
    const q1: TranscriptEvent = { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false,
      questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };
    const q2: TranscriptEvent = { kind: 'askUserQuestion', at: '2026-01-01T00:01:00Z', toolUseId: 't2', resolved: false,
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };
    const { rerender } = render(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={vi.fn()} events={[q1, q2]} />);
    // Pick "No" on the SECOND question (q2, currently at array index 1).
    fireEvent.click(screen.getAllByRole('radio', { name: 'No' })[1] as HTMLElement);
    // q1 ages out of the daemon's tail window; q2 shifts from index 1 -> 0.
    rerender(<Transcript sessionId="s1" sessionCwd="/proj" canAnswer answerInFlight={null} onAnswer={vi.fn()} events={[q2]} />);
    expect(screen.getByRole('radio', { name: 'No' })).toBeChecked();
  });
});
