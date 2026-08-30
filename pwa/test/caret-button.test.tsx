// @vitest-environment jsdom
// pwa/test/caret-button.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CaretButton } from '../src/components/CaretButton.js';

afterEach(cleanup);

describe('CaretButton (spec §4/§3 — one shared dropdown-trigger style)', () => {
  it('calls onClick when tapped', () => {
    const onClick = vi.fn();
    render(<CaretButton open={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('reflects open state visually via a distinct class/attribute', () => {
    const { rerender } = render(<CaretButton open={false} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.className).not.toMatch(/bg-amber-400/);
    rerender(<CaretButton open onClick={() => {}} />);
    expect(screen.getByRole('button').className).toMatch(/bg-amber-400/);
  });
});
