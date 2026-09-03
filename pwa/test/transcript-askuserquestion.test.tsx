// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';

afterEach(cleanup);

describe('Transcript AskUserQuestion rendering (spec §6)', () => {
  it('renders a pending question expanded, never collapsed to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders a resolved question read-only with the selected option highlighted', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    const yes = screen.getByText('Yes');
    expect(yes.className).toMatch(/amber|selected/);
  });

  it('a non-AskUserQuestion tool call is unaffected — still collapses to one line', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'tool', at: '2026-01-01T00:00:00Z', name: 'Bash', summary: 'ran a command' },
    ]} />);
    // The tool row's summary is a plain trailing text node (" · " + summary,
    // not its own element — see Transcript.tsx's 'tool' case, unmodified by
    // this task), so getByText's exact-string form never matches it; a regex
    // matches the same node without depending on the leading separator.
    expect(screen.getByText(/ran a command/)).toBeInTheDocument();
  });

  it('a resolved question renders its options as inert (non-interactive) even if onAnswerQuestion is provided', () => {
    const onAnswerQuestion = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" onAnswerQuestion={onAnswerQuestion} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: true, selectedLabels: ['Yes'], questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });

  it('a pending question renders clickable options when onAnswerQuestion is provided, and tapping one calls it with toolUseId + label', () => {
    const onAnswerQuestion = vi.fn();
    render(<Transcript sessionId="s1" sessionCwd="/proj" onAnswerQuestion={onAnswerQuestion} events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onAnswerQuestion).toHaveBeenCalledWith('t1', 'No');
  });

  it('a pending question renders inert options when onAnswerQuestion is absent', () => {
    render(<Transcript sessionId="s1" sessionCwd="/proj" events={[
      { kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    ]} />);
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });
});
