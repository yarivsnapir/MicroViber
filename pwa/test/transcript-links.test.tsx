// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SafeMarkdown } from '../src/lib/markdown.js';
import { Transcript } from '../src/components/Transcript.js';
import type { TranscriptEvent } from '../src/lib/types.js';

// Mocked so the "threads sessionCwd" test below can assert exactly what
// navigateWebPane was called with — proving Transcript passed the real
// sessionCwd through to classifyLink, not just that the anchor lacks
// target=_blank (which classifyLink never sets based on sessionCwd anyway,
// so that alone can't distinguish a real cwd from SafeMarkdown's default '').
vi.mock('../src/components/WebPane.js', () => ({ navigateWebPane: vi.fn() }));
import { navigateWebPane } from '../src/components/WebPane.js';

afterEach(cleanup);

describe('SafeMarkdown link routing (story microviber-track-b-4, spec §5)', () => {
  it('external links render as target=_blank anchors, untouched', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[pr](https://github.com/x/y/pull/1)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'pr' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
  });

  it('a local link is intercepted (no default navigation) and routed to the Web pane', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[spec](docs/spec.md)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'spec' });
    expect(a.getAttribute('target')).toBeNull(); // not opened in a new external tab
    const notPrevented = fireEvent.click(a);
    expect(notPrevented).toBe(false); // preventDefault() was called, per @testing-library/react's fireEvent return
  });

  it('a devserver link is intercepted the same way', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[app](http://localhost:9005/scenarios/42)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'app' });
    expect(a.getAttribute('target')).toBeNull();
    const notPrevented = fireEvent.click(a);
    expect(notPrevented).toBe(false);
  });
});

describe('Transcript threads sessionCwd into SafeMarkdown (story microviber-track-b-4)', () => {
  it('a relative link in an assistant message resolves against the real session cwd, not the default', () => {
    const events: TranscriptEvent[] = [{ kind: 'assistant', at: '2026-01-01T00:00:00Z', text: '[spec](docs/spec.md)' }];
    render(<Transcript events={events} sessionId="s1" sessionCwd="/proj/studio" />);
    const a = screen.getByRole('link', { name: 'spec' });
    fireEvent.click(a);
    expect(navigateWebPane).toHaveBeenCalledWith({ kind: 'localfile', path: '/proj/studio/docs/spec.md' });
  });
});
