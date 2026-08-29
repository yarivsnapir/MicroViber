// @vitest-environment jsdom
// pwa/test/pane-switch.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PaneSwitch } from '../src/components/states.js';

afterEach(cleanup);

describe('PaneSwitch (spec AC1 — Web tab is a real, tappable tab, not a placeholder)', () => {
  it('renders both tabs as real buttons, with no "coming soon" placeholder text', () => {
    render(<PaneSwitch pane="claude" onChange={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('calls onChange("web") when the Web tab is tapped', () => {
    const onChange = vi.fn();
    render(<PaneSwitch pane="claude" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /web/i }));
    expect(onChange).toHaveBeenCalledWith('web');
  });

  it('calls onChange("claude") when the Claude tab is tapped', () => {
    const onChange = vi.fn();
    render(<PaneSwitch pane="web" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('styles the active pane distinctly from the inactive one', () => {
    const { rerender } = render(<PaneSwitch pane="claude" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /claude/i }).className).toMatch(/text-amber-400/);
    expect(screen.getByRole('button', { name: /web/i }).className).toMatch(/text-zinc-300/);

    rerender(<PaneSwitch pane="web" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /web/i }).className).toMatch(/text-amber-400/);
    expect(screen.getByRole('button', { name: /claude/i }).className).toMatch(/text-zinc-300/);
  });
});
