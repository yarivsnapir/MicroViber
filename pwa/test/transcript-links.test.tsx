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

afterEach(() => { cleanup(); vi.mocked(navigateWebPane).mockClear(); });

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

  // Final whole-branch review, Finding 3 (IMPORTANT): an empty/stripped href
  // (a literal `[text]()`, or a javascript:/data: URL stripped by
  // urlTransform to '') used to fall through classifyLink's bare-path
  // fallback and resolve to a bogus `{ kind: 'localfile', path: sessionCwd + '/' }`
  // — a directory. It must now render inert instead: no interception, no
  // navigateWebPane call, and default (no-op) click behavior.
  it('a literal empty markdown link renders inert — no interception, no navigateWebPane call', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[dead]()'}</SafeMarkdown>);
    // An href="" anchor doesn't get an implicit ARIA "link" role, so query by
    // text instead of role here (unlike the other cases in this file, which
    // all have a non-empty href).
    const a = screen.getByText('dead').closest('a')!;
    expect(a.getAttribute('onclick')).toBeNull();
    fireEvent.click(a);
    expect(navigateWebPane).not.toHaveBeenCalled();
  });

  // Final whole-branch review, Finding 4 (IMPORTANT): mailto: survives
  // react-markdown's default urlTransform unchanged, then used to fall into
  // classifyLink's bare-path branch and get misclassified as localfile —
  // silently killing the mail-app handoff. It must render as a plain,
  // unintercepted anchor with its original href intact.
  it('a mailto: link renders as a plain anchor with its href intact, no interception', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[email](mailto:a@b.com)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'email' });
    expect(a.getAttribute('href')).toBe('mailto:a@b.com');
    expect(a.getAttribute('target')).toBeNull();
    // What this test verifies is that OUR classify/intercept logic doesn't
    // run for a mailto: link — not whether jsdom can actually hand off to a
    // mail client, which it can't and logs noisily if left to try. A plain
    // native listener heads off jsdom's own (unimplemented) navigation
    // attempt; it runs alongside, not instead of, any handler this
    // component would have attached, so it doesn't affect the assertion.
    a.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(a);
    expect(navigateWebPane).not.toHaveBeenCalled();
  });

  // Final whole-branch review, Finding 4 (IMPORTANT): an in-page #fragment
  // link also survives urlTransform unchanged and was likewise misclassified
  // as localfile, popping a bogus "file not found" alert instead of letting
  // the browser jump to the anchor.
  it('a #fragment link renders as a plain anchor, untouched, no interception', () => {
    render(<SafeMarkdown sessionCwd="/proj">{'[jump](#section)'}</SafeMarkdown>);
    const a = screen.getByRole('link', { name: 'jump' });
    expect(a.getAttribute('href')).toBe('#section');
    fireEvent.click(a);
    expect(navigateWebPane).not.toHaveBeenCalled();
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
