// @vitest-environment jsdom
// pwa/test/title-bar.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { TitleBar } from '../src/components/TitleBar.js';

afterEach(cleanup);

describe('TitleBar (spec §4)', () => {
  beforeEach(() => { Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true }); });

  it('shows the wordmark always', () => {
    render(<TitleBar />);
    expect(screen.getByText('MICROVIBER')).toBeTruthy();
  });

  it('shows no install button before beforeinstallprompt fires', () => {
    render(<TitleBar />);
    expect(screen.queryByText(/install/i)).toBeNull();
  });

  it('shows the install button after beforeinstallprompt fires, and calls .prompt() on tap', () => {
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn().mockResolvedValue({ outcome: 'accepted' }) });
    fireEvent(window, evt);
    const btn = screen.getByText(/install/i);
    fireEvent.click(btn);
    expect((evt as unknown as { prompt: () => void }).prompt).toHaveBeenCalled();
  });

  it('shows no install button when already running standalone', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn().mockResolvedValue({ outcome: 'accepted' }) });
    fireEvent(window, evt);
    expect(screen.queryByText(/install/i)).toBeNull();
  });

  it('hides the install button after .prompt() resolves — the event is one-shot and must not be reusable', async () => {
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn().mockResolvedValue({ outcome: 'dismissed' }) });
    fireEvent(window, evt);
    const btn = screen.getByText(/install/i);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText(/install/i)).toBeNull());
  });

  it('hides the install button immediately when appinstalled fires, without requiring a reload', () => {
    render(<TitleBar />);
    const evt = Object.assign(new Event('beforeinstallprompt'), { preventDefault: vi.fn(), prompt: vi.fn().mockResolvedValue({ outcome: 'accepted' }) });
    fireEvent(window, evt);
    expect(screen.getByText(/install/i)).toBeTruthy();
    fireEvent(window, new Event('appinstalled'));
    expect(screen.queryByText(/install/i)).toBeNull();
  });
});
