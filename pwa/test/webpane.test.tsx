// @vitest-environment jsdom
// pwa/test/webpane.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { WebPane, navigateWebPane } from '../src/components/WebPane.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(() => { cleanup(); localStorage.clear(); });

const session: SessionSummary = {
  id: 's1', title: 'studio', folder: 'studio', cwd: '/proj/studio', host: 'terminal',
  writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: null,
  mode: 'readonly', takenOver: false, devServerPorts: [{ folder: 'studio', port: 9005 }],
};

function fakeApi(overrides: Partial<{ mintWebpaneToken: () => Promise<void> }> = {}) {
  return { mintWebpaneToken: vi.fn().mockResolvedValue(undefined), ...overrides } as never;
}

describe('WebPane (spec §3)', () => {
  it('shows the empty state when no dev server is resolved and nothing selected', () => {
    render(<WebPane api={fakeApi()} sessions={[{ ...session, devServerPorts: [] }]} activeSessionCwd="/proj/studio" />);
    expect(screen.getByText(/nothing configured|no dev server/i)).toBeTruthy();
  });

  it('lists resolved dev servers in the dropdown, deduped by folder across sessions', async () => {
    render(<WebPane api={fakeApi()} sessions={[session, { ...session, id: 's2' }]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button')); // the CaretButton
    await waitFor(() => expect(screen.getByText(/studio/)).toBeTruthy());
    expect(screen.getAllByText(/localhost:9005/)).toHaveLength(1); // deduped by folder, not one row per session
  });

  it('lists every dev server a single workspace-root session resolves, not just one (story-3 manual-test finding)', async () => {
    const workspaceRootSession: SessionSummary = {
      ...session, id: 's3', folder: 'Harness-2', cwd: '/Users/x/Harness-2',
      devServerPorts: [
        { folder: 'studio', port: 9005 },
        { folder: 'audio-producer', port: 9008 },
        { folder: 'scenario-creator', port: 9009 },
      ],
    };
    render(<WebPane api={fakeApi()} sessions={[workspaceRootSession]} activeSessionCwd="/Users/x/Harness-2" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('studio')).toBeTruthy());
    expect(screen.getByText('audio-producer')).toBeTruthy();
    expect(screen.getByText('scenario-creator')).toBeTruthy();
    expect(screen.getByText(/localhost:9005/)).toBeTruthy();
    expect(screen.getByText(/localhost:9008/)).toBeTruthy();
    expect(screen.getByText(/localhost:9009/)).toBeTruthy();
  });

  it('mints a token before navigating to a dev server, then shows an iframe on the separate content origin with the devserver sandbox set', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    const iframe = await screen.findByTitle('web-pane-content');
    // allow-same-origin is safe here BECAUSE the src is a separate origin
    // (the content origin) — isolation moved from opaque-origin sandboxing to
    // origin separation in this story's second-origin redesign (T15).
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
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
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
  });

  it('re-mints through go() when restoring the last-selected target from localStorage on mount, instead of rendering it directly', async () => {
    localStorage.setItem('mv_webpane_last', JSON.stringify({ kind: 'devserver', port: 9005, path: '/' }));
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9005 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
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

  it('shows an editable path input for the current dev server, seeded with its current path', async () => {
    render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await screen.findByTitle('web-pane-content');
    const input = screen.getByLabelText('path') as HTMLInputElement;
    expect(input.value).toBe('/');
  });

  it('navigating the path within the current dev server does not re-mint (the cookie is scoped by port, not path)', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await screen.findByTitle('web-pane-content');
    expect(mint).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText('path');
    fireEvent.change(input, { target: { value: '/scenarios/42' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/scenarios/42');
    expect(mint).toHaveBeenCalledTimes(1); // still just the one mint from selecting the server
  });

  it('normalizes a path typed without a leading slash', async () => {
    render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => screen.getByText(/localhost:9005/));
    fireEvent.click(screen.getByText(/localhost:9005/));
    await screen.findByTitle('web-pane-content');

    const input = screen.getByLabelText('path');
    fireEvent.change(input, { target: { value: 'scenarios/42' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/scenarios/42');
  });

  it('re-mints the token periodically while a target stays open, so the daemon-side 5-minute Max-Age never lapses under the live iframe (post-story-3 bug report)', async () => {
    // Without this keepalive, the mv_webpane cookie expired 5 minutes after
    // selection; the framed app's next document load (dev-client full reload,
    // mobile tab restore) then got the daemon's raw 401 JSON as its document —
    // the blank pane with Chrome's "Pretty-print" bar.
    vi.useFakeTimers();
    try {
      const mint = vi.fn().mockResolvedValue(undefined);
      render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mint).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
      expect(mint).toHaveBeenCalledTimes(2);
      expect(mint).toHaveBeenLastCalledWith({ kind: 'devserver', port: 9005 });

      // Keeps renewing for as long as the pane stays open.
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
      expect(mint).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the keepalive on unmount', async () => {
    vi.useFakeTimers();
    try {
      const mint = vi.fn().mockResolvedValue(undefined);
      const { unmount } = render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mint).toHaveBeenCalledTimes(1);
      unmount();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(mint).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers a navigateWebPane call made while no WebPane is mounted and applies it on the next mount', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    navigateWebPane({ kind: 'devserver', port: 9008, path: '/' });
    render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
    await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'devserver', port: 9008 }));
    const iframe = await screen.findByTitle('web-pane-content');
    expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
  });

  // story microviber-track-b-4 manual-test finding: tapping a transcript
  // link into the pane left no way to return to whatever was open before.
  describe('back navigation (story microviber-track-b-4 manual-test finding)', () => {
    it('shows no Back button until a second target has been visited', async () => {
      render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => screen.getByText(/localhost:9005/));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await screen.findByTitle('web-pane-content');
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('a link tap into the pane while a dev server is open can be backed out of, restoring the dev server', async () => {
      const mint = vi.fn().mockResolvedValue(undefined);
      render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => screen.getByText(/localhost:9005/));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await screen.findByTitle('web-pane-content');

      // Simulates a transcript link tap (markdown.tsx -> navigateWebPane) while this dev server is already open.
      navigateWebPane({ kind: 'localfile', path: '/proj/studio/docs/spec.md' });
      await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'localfile', path: '/proj/studio/docs/spec.md' }));
      let iframe = await screen.findByTitle('web-pane-content');
      expect(iframe.getAttribute('src')).toBe('/api/webpane/localfile?path=%2Fproj%2Fstudio%2Fdocs%2Fspec.md');

      const back = screen.getByRole('button', { name: 'Back' });
      fireEvent.click(back);
      await waitFor(() => expect(mint).toHaveBeenLastCalledWith({ kind: 'devserver', port: 9005 }));
      iframe = await screen.findByTitle('web-pane-content');
      expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
      // Back to the start of this pane's history — nothing left to undo.
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('does not push a "back" step onto the stack, so Back cannot bounce forward onto the same target', async () => {
      const mint = vi.fn().mockResolvedValue(undefined);
      render(<WebPane api={fakeApi({ mintWebpaneToken: mint })} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => screen.getByText(/localhost:9005/));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await screen.findByTitle('web-pane-content');

      navigateWebPane({ kind: 'localfile', path: '/proj/studio/docs/spec.md' });
      await waitFor(() => expect(mint).toHaveBeenCalledWith({ kind: 'localfile', path: '/proj/studio/docs/spec.md' }));
      await screen.findByTitle('web-pane-content');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() => expect(mint).toHaveBeenLastCalledWith({ kind: 'devserver', port: 9005 }));
      await screen.findByTitle('web-pane-content');
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('editing the path within a dev server is also undoable via Back', async () => {
      render(<WebPane api={fakeApi()} sessions={[session]} activeSessionCwd="/proj/studio" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => screen.getByText(/localhost:9005/));
      fireEvent.click(screen.getByText(/localhost:9005/));
      await screen.findByTitle('web-pane-content');

      const input = screen.getByLabelText('path');
      fireEvent.change(input, { target: { value: '/scenarios/42' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      let iframe = await screen.findByTitle('web-pane-content');
      expect(iframe.getAttribute('src')).toBe('https://localhost:8443/scenarios/42');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      iframe = await screen.findByTitle('web-pane-content');
      expect(iframe.getAttribute('src')).toBe('https://localhost:8443/');
    });
  });
});
