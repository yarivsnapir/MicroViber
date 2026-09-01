// @vitest-environment jsdom
// pwa/test/app-header.test.tsx
//
// Regression test (post-story-3 bug report, 2026-08-30): the session header —
// title + picker caret + folder/state line — belongs to the Claude pane only.
// Story 3 wired WebPane into the pane switch but left the header rendered
// unconditionally above it, so the Web pane showed the Claude session picker.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { App } from '../src/App.js';
import type { SessionSummary } from '../src/lib/types.js';

const session: SessionSummary = {
  id: 's1', title: 'Session Alpha', folder: 'studio', cwd: '/proj/studio', host: 'terminal',
  writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: null,
  mode: 'readonly', takenOver: false, devServerPorts: [],
};

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as unknown as Response;
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
  localStorage.setItem('microviber.token', 't'.repeat(40));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/transcript')) return okJson({ events: [], nextCursor: null });
    if (url.includes('/api/sessions')) return okJson([session]);
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('App — session header belongs to the Claude pane only', () => {
  it('shows the session header on the Claude pane, hides it on the Web pane, and restores it on switching back', async () => {
    render(<App />);
    // Claude pane (default): the session header is visible.
    await screen.findByText('Session Alpha');

    fireEvent.click(screen.getByRole('button', { name: /web/i }));
    // Web pane: no session header (no title, no folder/state line) — the
    // session picker lives in the Claude pane only.
    expect(screen.queryByText('Session Alpha')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    await screen.findByText('Session Alpha');
  });
});
