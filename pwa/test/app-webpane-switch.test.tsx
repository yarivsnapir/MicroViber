// @vitest-environment jsdom
// pwa/test/app-webpane-switch.test.tsx
//
// Final whole-branch review, Finding 1 (CRITICAL), story microviber-track-b-4:
// tapping a local transcript link routed the target into WebPane's module-
// level buffer, but nothing ever flipped App.tsx's private `pane` state to
// 'web' — so the tap looked like a no-op. This proves the full path end to
// end: link tap -> setPane('web') -> WebPane mounts -> consumes the buffered
// target -> mints a token for it. Follows app-header.test.tsx's mocking
// pattern (mocked fetch covering /api/sessions and /transcript, plus this
// story's /api/webpane-token).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';
import type { SessionSummary, TranscriptEvent } from '../src/lib/types.js';

const session: SessionSummary = {
  id: 's1', title: 'Session Alpha', folder: 'studio', cwd: '/proj/studio', host: 'terminal',
  writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: null,
  mode: 'readonly', takenOver: false, devServerPorts: [],
};

const events: TranscriptEvent[] = [
  { kind: 'assistant', at: '2026-01-01T00:00:00Z', text: '[spec](docs/spec.md)' },
];

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as unknown as Response;
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
  localStorage.setItem('microviber.token', 't'.repeat(40));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/webpane-token')) return okJson(undefined);
    if (url.includes('/transcript')) return okJson({ events, nextCursor: null });
    if (url.includes('/api/sessions')) return okJson([session]);
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('App — tapping a local transcript link switches to the Web pane', () => {
  it('flips pane to web and mints a token for the tapped target', async () => {
    render(<App />);
    // Claude pane (default): session header visible, link rendered.
    await screen.findByText('Session Alpha');
    const link = await screen.findByRole('link', { name: 'spec' });

    fireEvent.click(link);

    // The Claude-pane-only session header (app-header.test.tsx's own
    // detection for "we're on the Web pane now") must disappear — proving
    // setPane('web') actually fired, not just that navigateWebPane buffered
    // a target no one ever displays.
    await waitFor(() => expect(screen.queryByText('Session Alpha')).toBeNull());

    // And the buffered target was actually consumed: WebPane mounted and
    // minted a token for it via POST /api/webpane-token.
    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => String(c[0]).includes('/api/webpane-token'))).toBe(true);
    });
  });
});
