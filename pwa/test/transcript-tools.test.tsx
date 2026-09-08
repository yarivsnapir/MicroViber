// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToolResult } from '../src/components/transcript/ToolResult.js';
import { ToolCall } from '../src/components/transcript/ToolCall.js';

afterEach(cleanup);

const ok = { kind: 'toolResult' as const, at: '', toolUseId: 'toolu_a', ok: true, text: 'all 42 tests passed', truncated: false };

describe('ToolResult', () => {
  it('collapses to a one-line preview and expands on tap', () => {
    render(<ToolResult e={{ ...ok, text: 'first line\nsecond line' }} />);
    expect(screen.queryByText(/second line/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/second line/)).toBeInTheDocument();
  });

  it('tints a failed result', () => {
    const { container } = render(<ToolResult e={{ ...ok, ok: false, text: 'boom' }} />);
    expect(container.innerHTML).toContain('red');
  });

  it('marks a truncated result when expanded', () => {
    render(<ToolResult e={{ ...ok, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('shows a placeholder rather than an empty row for an empty result', () => {
    render(<ToolResult e={{ ...ok, text: '' }} />);
    expect(screen.getByRole('button').textContent).toMatch(/empty result/i);
  });
});

const toolEvent = {
  kind: 'tool' as const, at: '', id: 'toolu_a', name: 'Bash',
  summary: 'npm test', input: { command: 'npm test', description: 'run the suite' }, truncated: false,
};

describe('ToolCall', () => {
  it('collapses to the tool name and summary', () => {
    render(<ToolCall e={toolEvent} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText(/run the suite/)).toBeNull();
  });

  it('expands on tap to reveal every input field', () => {
    render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/run the suite/)).toBeInTheDocument();
    // getAllBy*, not getBy*: 'npm test' is BOTH the collapsed summary (which
    // stays visible in the button while expanded) and the value of the
    // `command` input field, so a single-node query matches two nodes and
    // throws. The count is the real assertion — the field is present in
    // ADDITION to the summary line.
    expect(screen.getByText('command:')).toBeInTheDocument();
    expect(screen.getAllByText(/npm test/).length).toBeGreaterThan(1);
  });

  it('flags a truncated payload when expanded', () => {
    render(<ToolCall e={{ ...toolEvent, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('keeps a non-string field visible, so a MultiEdit edit array survives (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/old_string/)).toBeInTheDocument();
  });

  it('says so rather than rendering an empty box when there is no input', () => {
    render(<ToolCall e={{ ...toolEvent, input: {} }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/no input/i)).toBeInTheDocument();
  });
});
