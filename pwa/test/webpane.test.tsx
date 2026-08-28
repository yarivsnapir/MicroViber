// @vitest-environment jsdom
// pwa/test/webpane.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { WebPane, navigateWebPane } from '../src/components/WebPane.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(() => { cleanup(); localStorage.clear(); });

const session: SessionSummary = {
  id: 's1', title: 'studio', folder: 'studio', cwd: '/proj/studio', host: 'terminal',
  writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: null,
  mode: 'readonly', takenOver: false, devServerPort: 9005,
};

function fakeApi(overrides: Partial<{ mintWebpaneToken: () => Promise<void> }> = {}) {
  return { mintWebpaneToken: vi.fn().mockResolvedValue(undefined), ...overrides } as never;
}

describe('WebPane (spec §3)', () => {
  it('shows the empty state when no dev server is resolved and nothing selected', () => {
    render(<WebPane api={fakeApi()} sessions={[{ ...session, devServerPort: null }]} activeSessionCwd="/proj/studio" />);
    expect(screen.getByText(/nothing configured|no dev server/i)).toBeTruthy();
  });

  it('lists resolved dev servers in the dropdown, deduped by folder', async () => {
    render(<WebPane api={fakeApi()} sessions={[session, { ...session, id: 's2' }]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button')); // the CaretButton
    await waitFor(() => expect(screen.getByText(/studio/)).toBeTruthy());
    expect(screen.getAllByText(/localhost:9005/)).toHaveLength(1); // deduped by folder, not one row per session
  });

  it('mints a token before navigating to a dev server, then shows an iframe with sandbox and no allow-same-origin', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('src')).toBe('/api/webpane/devserver/9005/');
  });

  it('surfaces an error and closes the dropdown without crashing when mint rejects, leaving current unset', async () => {
    const mint = vi.fn().mockRejectedValue(new Error('port no longer allowed'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('port no longer allowed'));
    // dropdown closed itself even on failure
    expect(screen.queryByText(/Dev servers/)).toBeNull();
    // no target was committed — no iframe ever appears for a failed mint
    expect(screen.queryByTitle('web-pane-content')).toBeNull();
    alertSpy.mockRestore();
  });

  it('remembers the last-selected server across remounts (localStorage-backed)', async () => {
    const { unmount } = render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await screen.findByTitle('web-pane-content');
    unmount();
    render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('/api/webpane/devserver/9005/');
  });

  it('re-mints through go() when restoring the last-selected target from localStorage on mount, instead of rendering it directly', async () => {
    localStorage.setItem('mv_webpane_last', JSON.stringify({ kind: 'devserver', port: 9005, path: '/' }));
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('/api/webpane/devserver/9005/');
  });

  it('surfaces an alert and shows no iframe when the localStorage-restored mint rejects (e.g. an expired mv_webpane session)', async () => {
    localStorage.setItem('mv_webpane_last', JSON.stringify({ kind: 'devserver', port: 9005, path: '/' }));
    const mint = vi.fn().mockRejectedValue(new Error('session expired'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('session expired'));
    expect(screen.queryByTitle('web-pane-content')).toBeNull();
    alertSpy.mockRestore();
  });

  it('buffers a navigateWebPane call made while no WebPane is mounted and applies it on the next mount', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    navigateWebPane({ kind: 'devserver', port: 9008, path: '/' });
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9008 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('/api/webpane/devserver/9008/');
  });
});
