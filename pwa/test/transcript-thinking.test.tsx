// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Thinking } from '../src/components/transcript/Thinking.js';

afterEach(cleanup);

const e = { kind: 'thinking' as const, at: '', text: 'the config is probably stale' };

describe('Thinking', () => {
  it('shows a marker, not a wall of text, until tapped', () => {
    render(<Thinking e={e} />);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
    expect(screen.queryByText(/probably stale/)).toBeNull();
  });

  it('reveals the reasoning on tap, and hides it again', () => {
    render(<Thinking e={e} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/probably stale/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/probably stale/)).toBeNull();
  });
});
