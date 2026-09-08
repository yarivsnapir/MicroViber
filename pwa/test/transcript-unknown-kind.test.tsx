// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

afterEach(cleanup);

const base = { sessionId: 's1', sessionCwd: '/proj', canAnswer: false, answerInFlight: null };

/**
 * Story-1 AC16. This is a REGRESSION GUARD, not a red-to-green test — see the
 * note in story-1-plan.md Task 1. The story's rationale ("React would throw
 * 'Nothing was returned from render', blanking the entire transcript") held
 * through React 17; React 18 made returning undefined legal, and this repo is
 * on React 19.2.8, where an unrecognised kind already renders as nothing with
 * no throw and no console warning.
 *
 * The tests below therefore pin the CONTRACT rather than fix a live crash:
 * an event kind this bundle does not know must render as nothing at all, and
 * must not disturb its neighbours. That contract is what the version-skew
 * scenario in the story actually depends on — an installed PWA with a service
 * worker can run a cached older bundle against a newer daemon — and it stops a
 * future refactor (or a React downgrade) from turning an unknown kind into a
 * blank transcript.
 */
describe('Transcript tolerates an event kind it does not know (story-1 AC16 — version skew)', () => {
  // The cast IS the point: the union deliberately cannot express this at
  // compile time, which is why the runtime needs an explicit arm.
  const future = { kind: 'somethingTheDaemonAddedLater', at: '' } as unknown as TranscriptEvent;

  it('renders the events it understands and skips the one it does not, without throwing', () => {
    expect(() =>
      render(<Transcript {...base} events={[
        { kind: 'assistant', at: '', text: 'before' },
        future,
        { kind: 'assistant', at: '', text: 'after' },
      ]} />),
    ).not.toThrow();
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });

  it('emits no row at all for the unknown kind — not an empty one', () => {
    const { container } = render(<Transcript {...base} events={[
      { kind: 'assistant', at: '', text: 'before' },
      future,
      { kind: 'assistant', at: '', text: 'after' },
    ]} />);
    const scroller = container.firstElementChild;
    expect(scroller).not.toBeNull();
    // Two assistant rows for three events: the unknown one contributes nothing.
    expect(scroller?.childElementCount).toBe(2);
  });

  it('survives being the only event, and logs nothing to the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Transcript {...base} events={[future]} />)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
