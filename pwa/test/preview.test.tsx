// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Preview, PREVIEW_SECTIONS } from '../src/preview.js';

afterEach(cleanup);

/**
 * The story-1 preview harness (`pwa/preview.html`) is what a human actually
 * looks at to sign this story off, so it is worth knowing it renders BEFORE
 * handing someone a URL. A dev server returning HTTP 200 only proves the file
 * was served, not that React mounted it.
 *
 * This is not testing product behaviour — the components have their own tests.
 * It tests that the fixture is well-formed and every section mounts, so the
 * page cannot be silently blank or half-rendered when someone opens it.
 */
describe('story-1 preview harness', () => {
  it('mounts every numbered section without throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Preview />)).not.toThrow();
    for (const s of PREVIEW_SECTIONS) {
      expect(screen.getByText(new RegExp(`^${s.n}\\. `))).toBeInTheDocument();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('covers all seven checklist sections, each with events', () => {
    expect(PREVIEW_SECTIONS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const s of PREVIEW_SECTIONS) {
      expect(s.events.length).toBeGreaterThan(0);
      expect(s.look.length).toBeGreaterThan(20);
    }
  });

  it('includes the cases that are awkward to produce by hand', () => {
    const all = PREVIEW_SECTIONS.flatMap((s) => s.events);

    // A failed tool result — so nothing has to be triggered on the laptop.
    expect(all.some((e) => e.kind === 'toolResult' && !e.ok)).toBe(true);
    // An oversized, truncated result.
    expect(all.some((e) => e.kind === 'toolResult' && e.truncated)).toBe(true);
    // An Edit whose diff is wider than a phone, for the scroll-containment check.
    expect(all.some((e) => e.kind === 'tool' && e.name === 'Edit' && String(e.input.old_string ?? '').length > 200)).toBe(true);
    // A one-line edit inside a large file, for the small-hunk check.
    expect(all.some((e) => e.kind === 'tool' && e.name === 'Edit' && String(e.input.old_string ?? '').split('\n').length >= 200)).toBe(true);
    // A Write, a MultiEdit's edits array, a TodoWrite's todos, and an empty input.
    expect(all.some((e) => e.kind === 'tool' && e.name === 'Write')).toBe(true);
    expect(all.some((e) => e.kind === 'tool' && Array.isArray(e.input.edits))).toBe(true);
    expect(all.some((e) => e.kind === 'tool' && Array.isArray(e.input.todos))).toBe(true);
    expect(all.some((e) => e.kind === 'tool' && Object.keys(e.input).length === 0)).toBe(true);
    // Thinking with real text, and an AskUserQuestion in both states.
    expect(all.some((e) => e.kind === 'thinking' && e.text.length > 20)).toBe(true);
    expect(all.some((e) => e.kind === 'askUserQuestion' && e.resolved)).toBe(true);
    expect(all.some((e) => e.kind === 'askUserQuestion' && !e.resolved)).toBe(true);
    // A turn with prose AND two tool calls — the shape story-1 exists to fix.
    expect(all.filter((e) => e.kind === 'tool').length).toBeGreaterThan(5);
  });

  it('a tool line in the rendered page still expands on tap', () => {
    render(<Preview />);
    // Section 5's TodoWrite is only meaningful once expanded.
    expect(screen.queryByText('todos:')).toBeNull();
    const todoBtn = screen.getAllByRole('button').find((b) => b.textContent?.includes('TodoWrite'));
    expect(todoBtn).toBeDefined();
    if (todoBtn) fireEvent.click(todoBtn);
    expect(screen.getByText('todos:')).toBeInTheDocument();
  });
});
