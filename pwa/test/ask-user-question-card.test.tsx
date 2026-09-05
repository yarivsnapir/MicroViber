// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AskUserQuestionCard } from '../src/components/AskUserQuestionCard.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);
type Ask = Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
const one: Ask = {
  kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1', resolved: false,
  questions: [{ question: 'Proceed?', header: 'Confirm', options: [
    { label: 'Yes', description: 'Continue with the plan as written' },
    { label: 'No', description: 'Stop and let me revise it' },
  ] }],
};
const two: Ask = { ...one, questions: [...one.questions, {
  question: 'Which parts?', header: 'Scope', multiSelect: true,
  options: [{ label: 'Frontend', description: 'UI code only' }, { label: 'Backend', description: 'Server code only' }],
}] };

describe('AskUserQuestionCard (spec §7.1, amended 2026-09-04: radio/checkbox, not chips)', () => {
  it('not taken over: options are inert, no Send button', () => {
    render(<AskUserQuestionCard e={one} canAnswer={false} inFlight={null} />);
    expect(screen.queryByRole('radio', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('uses radio inputs for single-select questions and checkboxes for multiSelect questions (AC3)', () => {
    render(<AskUserQuestionCard e={two} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'No' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Frontend' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Backend' })).toBeInTheDocument();
  });

  it("shows each option's label AND its description text (AC3)", () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Continue with the plan as written')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('Stop and let me revise it')).toBeInTheDocument();
  });

  it('taken over: options are selectable, Send answers is disabled until every question has a pick, then submits selections in question order', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={two} canAnswer inFlight={null} onAnswer={onAnswer} />);
    const send = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Frontend' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Backend' })); // multiSelect: both stay checked
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No'], ['Frontend', 'Backend']]);
  });

  it('single-select: picking a second radio unchecks the first', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
    expect(screen.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'No' })).toBeChecked();
  });

  it('shows the free-text hint while answerable', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.getByText('or type a reply below')).toBeInTheDocument();
  });

  it('in flight: options lock (read-only), status text shows, Send is gone', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'queued', selections: [['No']] }} onAnswer={() => {}} />);
    expect(screen.queryByRole('radio', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText(/waiting for the session to finish/i)).toBeInTheDocument();
  });

  it('failed: keeps the selections highlighted and offers Retry, which re-submits the same selections', () => {
    const onAnswer = vi.fn();
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'failed', selections: [['No']] }} onAnswer={onAnswer} />);
    expect(screen.getByText('No').className).toMatch(/amber/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', [['No']]);
  });

  it('an in-flight answer for a DIFFERENT question does not lock this card', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 'other', status: 'queued', selections: [['x']] }} onAnswer={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
  });

  it('resolved with labels: dimmed, selected highlighted, nothing interactive even when answerable', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text', selectedLabels: ['Yes'] }} canAnswer inFlight={null} onAnswer={() => {}} />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Yes').className).toMatch(/amber/);
  });

  it('resolved without labels: neutral "no longer pending" caption', () => {
    render(<AskUserQuestionCard e={{ ...one, resolved: true, resolvedBy: 'text' }} canAnswer inFlight={null} />);
    expect(screen.getByText('no longer pending')).toBeInTheDocument();
    expect(screen.queryByText('or type a reply below')).toBeNull();
  });

  it('a daemon INVALID_INPUT rejection shows its own message with no Retry (not a generic failure)', () => {
    render(<AskUserQuestionCard e={one} canAnswer inFlight={{ toolUseId: 't1', status: 'failed', selections: [['No']], rejection: 'question is no longer pending' }} onAnswer={() => {}} />);
    expect(screen.getByText('question is no longer pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
