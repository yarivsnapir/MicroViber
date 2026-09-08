// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToolResult } from '../src/components/transcript/ToolResult.js';

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
