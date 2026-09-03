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
    takenOver: false, devServerPorts: [],
    ...overrides,
  };
}

describe('composer gate (spec AC 1, 6)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
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

  it('awaiting-input: take-over button is enabled and tapping it calls the takeover api fn (same branch as idle)', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'awaiting-input', mode: 'readonly' })]);
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

  it('handback failure: api.handback rejects → alert shown, composer stays in owned mode (review fix)', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'idle', mode: 'owned' })]);
    mockApi.handback.mockRejectedValue(new Error('network down'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<App />);
    await screen.findByPlaceholderText(/message this session/i);

    const handbackBtn = await screen.findByRole('button', { name: /hand back/i });
    fireEvent.click(handbackBtn);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('network down'));
    // The daemon never released the session, so the composer correctly
    // stays live/owned — no state was ever optimistically changed.
    expect(screen.getByPlaceholderText(/message this session/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /hand back/i })).toBeTruthy();
    alertSpy.mockRestore();
  });

  it('handback success + refresh failure: no "could not hand back" alert (review fix — separate failure domains)', async () => {
    let refreshShouldFail = false;
    mockApi.listSessions.mockImplementation(() => refreshShouldFail
      ? Promise.reject(new Error('network down'))
      : Promise.resolve([makeSession({ state: 'idle', mode: 'owned' })]));
    mockApi.handback.mockResolvedValue({ id: 's1', mode: 'readonly' });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<App />);
    await screen.findByPlaceholderText(/message this session/i);
    const callsBeforeHandback = mockApi.listSessions.mock.calls.length;

    // Only start failing refresh() once the initial mount has succeeded, so
    // the failure is isolated to the post-handback refresh under test.
    refreshShouldFail = true;
    const handbackBtn = await screen.findByRole('button', { name: /hand back/i });
    fireEvent.click(handbackBtn);

    await waitFor(() => expect(mockApi.handback).toHaveBeenCalledWith('s1'));
    // The handback-triggered refresh() attempt (and fails) — wait for it.
    await waitFor(() => expect(mockApi.listSessions.mock.calls.length).toBeGreaterThan(callsBeforeHandback));
    // Recovery is silent: the daemon already released ownership, so a mere
    // refresh hiccup must not be reported as "could not hand back" — the
    // next 4s poll corrects the stale local state instead.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('taken-over + pending question: tapping an option submits it through send() (spec §6, AC15 PASS branch)', async () => {
    mockApi.listSessions.mockResolvedValue([makeSession({ state: 'awaiting-input', mode: 'owned' })]);
    mockApi.getTranscript.mockResolvedValue({
      events: [{ kind: 'askUserQuestion', at: '2026-01-01T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] }],
      nextCursor: null,
    });
    mockApi.sendPrompt.mockResolvedValue({ id: 'p1', sessionId: 's1', text: 'No', state: 'accepted', sentAt: 0 });
    render(<App />);
    const btn = await screen.findByRole('button', { name: 'No' });
    fireEvent.click(btn);
    await waitFor(() => expect(mockApi.sendPrompt).toHaveBeenCalledWith('s1', 'No', expect.any(String)));
  });

  it('bonus — same fix applied to takeoverSession: takeover success + refresh failure shows no "could not take over" alert', async () => {
    let refreshShouldFail = false;
    mockApi.listSessions.mockImplementation(() => refreshShouldFail
      ? Promise.reject(new Error('network down'))
      : Promise.resolve([makeSession({ state: 'idle', mode: 'readonly' })]));
    mockApi.takeover.mockResolvedValue({ id: 's1', mode: 'owned' });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<App />);
    const btn = await screen.findByRole('button', { name: /take over/i });
    const callsBeforeTakeover = mockApi.listSessions.mock.calls.length;

    refreshShouldFail = true;
    fireEvent.click(btn);

    await waitFor(() => expect(mockApi.takeover).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(mockApi.listSessions.mock.calls.length).toBeGreaterThan(callsBeforeTakeover));
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
