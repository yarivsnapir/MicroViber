// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { SessionSummary } from '../src/lib/types.js';

const mockApi = {
  listSessions: vi.fn(),
  getTranscript: vi.fn(),
  sendPrompt: vi.fn(),
  takeover: vi.fn(),
  handback: vi.fn(),
  openStream: vi.fn(),
};

vi.mock('../src/lib/api.js', () => ({
  createApi: () => mockApi,
}));

vi.mock('../src/lib/auth.js', () => ({
  captureTokenFromUrl: () => 'test-token',
}));

// Imported after the mocks above so App picks up the mocked modules.
const { App } = await import('../src/App.js');

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's1', title: 'Fix the bug', folder: '~/proj', cwd: '/home/x/proj',
    host: 'vscode', writable: true, state: 'idle',
    lastActivityAt: null, lastPrompt: null, lastPromptAt: null, mode: 'readonly',
    ...overrides,
  };
}

describe('composer gate (spec AC 1, 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getTranscript.mockResolvedValue({ events: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('working: composer is not offered, no take-over button, "still working" message shown', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'working', mode: 'readonly' })]);
    render(<App />);
    await screen.findByText(/still working/i);
    expect(screen.queryByRole('button', { name: /take over/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/message this session/i)).toBeNull();
  });

  it('idle: take-over button is enabled and tapping it calls the takeover api fn', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'idle', mode: 'readonly' })]);
    mockApi.takeover.mockResolvedValue({ id: 's1', mode: 'owned' });
    render(<App />);
    const btn = await screen.findByRole('button', { name: /take over/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(mockApi.takeover).toHaveBeenCalledWith('s1'));
  });

  it('stale: shows the disabled "session has ended" message, no composer', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'stale', mode: 'readonly' })]);
    render(<App />);
    await screen.findByText(/session has ended/i);
    expect(screen.queryByPlaceholderText(/message this session/i)).toBeNull();
  });

  it('taken-over: live composer AND a visible Hand back control; tapping it calls api.handback then refreshes', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'idle', mode: 'owned' })]);
    mockApi.handback.mockResolvedValue({ id: 's1', mode: 'readonly' });
    render(<App />);
    await screen.findByPlaceholderText(/message this session/i);
    // App's refresh() identity changes once `selected` settles, so the
    // mount effect can legitimately call listSessions more than once before
    // things stabilize — snapshot the count rather than assuming exactly 1.
    const callsBeforeHandback = mockApi.listSessions.mock.calls.length;

    const handbackBtn = await screen.findByRole('button', { name: /hand back/i });
    fireEvent.click(handbackBtn);

    await waitFor(() => expect(mockApi.handback).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(mockApi.listSessions.mock.calls.length).toBeGreaterThan(callsBeforeHandback));
  });
});
