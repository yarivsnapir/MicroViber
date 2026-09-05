// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { SessionSummary, TranscriptEvent } from '../src/lib/types.js';

const mockApi = { listSessions: vi.fn(), getTranscript: vi.fn(), sendPrompt: vi.fn(), postAnswer: vi.fn(), takeover: vi.fn(), handback: vi.fn(), openStream: vi.fn() };
vi.mock('../src/lib/api.js', () => ({ createApi: () => mockApi }));
vi.mock('../src/lib/auth.js', () => ({ captureTokenFromUrl: () => 'test-token' }));
const { App } = await import('../src/App.js');

const owned: SessionSummary = { id: 's1', title: 'T', folder: 'p', cwd: '/p', host: 'vscode', writable: true, state: 'awaiting-input', lastActivityAt: null, lastPrompt: null, lastPromptAt: null, mode: 'owned', takenOver: true, devServerPorts: [] };
const pending: TranscriptEvent = { kind: 'askUserQuestion', at: '2026-09-03T00:00:00Z', toolUseId: 't1', resolved: false, questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };

describe('App — answering a pending AskUserQuestion (spec §7)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true });
    vi.clearAllMocks();
    mockApi.listSessions.mockResolvedValue([owned]);
    mockApi.getTranscript.mockResolvedValue({ events: [pending], nextCursor: null });
  });
  afterEach(cleanup);

  it('picking an option then Send answers calls postAnswer with the toolUseId, selections, and a fresh key; the card shows the queued state', async () => {
    mockApi.postAnswer.mockResolvedValue({ id: 'k', sessionId: 's1', text: 'x', state: 'queued', sentAt: 0 });
    render(<App />);
    fireEvent.click(await screen.findByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(mockApi.postAnswer).toHaveBeenCalledTimes(1));
    const [id, toolUseId, selections, key] = mockApi.postAnswer.mock.calls[0] as [string, string, string[][], string];
    expect([id, toolUseId, selections]).toEqual(['s1', 't1', [['No']]]);
    expect(key).toMatch(/[0-9a-f-]{36}/);
    await screen.findByText(/waiting for the session to finish/i);
    // the composer still shows no status for a text prompt
    expect(screen.getByPlaceholderText(/message this session/i)).toBeInTheDocument();
  });

  it('a failed answer offers Retry, and Retry re-posts the same selections under a NEW key', async () => {
    mockApi.postAnswer.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: 'k2', sessionId: 's1', text: 'x', state: 'queued', sentAt: 0 });
    render(<App />);
    fireEvent.click(await screen.findByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockApi.postAnswer).toHaveBeenCalledTimes(2));
    const k1 = (mockApi.postAnswer.mock.calls[0] as string[])[3];
    const k2 = (mockApi.postAnswer.mock.calls[1] as string[])[3];
    expect(k1).not.toBe(k2);
    expect((mockApi.postAnswer.mock.calls[1] as unknown[])[2]).toEqual([['No']]);
  });
});
