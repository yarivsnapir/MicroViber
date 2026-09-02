// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionPicker } from '../src/components/SessionPicker.js';
import type { SessionSummary } from '../src/lib/types.js';

afterEach(cleanup);

function s(over: Partial<SessionSummary>): SessionSummary {
  return { id: 'a', title: 'A', folder: 'studio', cwd: '/proj/studio', host: 'terminal', writable: true, state: 'idle', lastActivityAt: null, lastPrompt: null, lastPromptAt: '2026-01-01T00:00:02Z', mode: 'readonly', takenOver: false, devServerPorts: [], ...over };
}

describe('SessionPicker as a dropdown (spec §4)', () => {
  it('renders nothing when closed', () => {
    render(<SessionPicker open={false} onOpenChange={() => {}} sessions={[s({})]} onPick={() => {}} />);
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('shows the 10 most recent sessions across folders when open (Recent, default view)', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => s({ id: `s${i}`, title: `T${i}`, lastPromptAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
    render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
    expect(screen.getByText('T11')).toBeInTheDocument(); // newest
    expect(screen.queryByText('T1')).not.toBeInTheDocument(); // 11th newest, beyond the cap of 10
    expect(screen.queryByText('T0')).not.toBeInTheDocument(); // oldest, beyond the cap of 10
  });

  it('shows the folder name inline per row', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'audio-producer' })]} onPick={() => {}} />);
    expect(screen.getByText(/audio-producer/)).toBeInTheDocument();
  });

  it('calls onPick when a session row is tapped', () => {
    const onPick = vi.fn();
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ id: 'a', title: 'A' })]} onPick={onPick} />);
    fireEvent.click(screen.getByText('A'));
    expect(onPick).toHaveBeenCalledWith('a');
  });

  it('hides the "Browse by folder" link when only one folder exists', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'studio' }), s({ id: 'b', folder: 'studio' })]} onPick={() => {}} />);
    expect(screen.queryByText(/browse by folder/i)).not.toBeInTheDocument();
  });

  it('shows the "Browse by folder" link when multiple folders exist', () => {
    render(<SessionPicker open onOpenChange={() => {}} sessions={[s({ folder: 'studio' }), s({ id: 'b', folder: 'audio-producer' })]} onPick={() => {}} />);
    expect(screen.getByText(/browse by folder/i)).toBeInTheDocument();
  });

  it('tapping "Browse by folder" swaps to a folder-grouped list with counts and aggregated state dots', () => {
    const sessions = [
      s({ id: 'a', folder: 'studio', state: 'working' }),
      s({ id: 'b', folder: 'studio', state: 'idle' }),
      s({ id: 'c', folder: 'audio-producer', state: 'idle' }),
    ];
    render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
    fireEvent.click(screen.getByText(/browse by folder/i));
    expect(screen.getByText('studio')).toBeInTheDocument();
    expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
    expect(screen.getByText('audio-producer')).toBeInTheDocument();
    expect(screen.getByText(/1 session\b/)).toBeInTheDocument();
  });

  it('clicking the scrim (outside the panel) calls onOpenChange(false)', () => {
    const onOpenChange = vi.fn();
    render(<SessionPicker open onOpenChange={onOpenChange} sessions={[s({})]} onPick={() => {}} />);
    // Click the scrim itself, not a row or the panel body — the panel body
    // stops propagation (onClick={(e) => e.stopPropagation()}) so this must
    // land on the outer absolute inset-0 div to reach onOpenChange.
    fireEvent.click(screen.getByText('A').closest('.absolute.inset-0') as Element);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('drilling into a folder shows its sessions with a back row to Projects, then to Recent', () => {
    const sessions = [s({ id: 'a', folder: 'studio', title: 'Studio session' }), s({ id: 'c', folder: 'audio-producer', title: 'AP session' })];
    render(<SessionPicker open onOpenChange={() => {}} sessions={sessions} onPick={() => {}} />);
    fireEvent.click(screen.getByText(/browse by folder/i));
    fireEvent.click(screen.getByText('studio'));
    expect(screen.getByText('Studio session')).toBeInTheDocument();
    expect(screen.queryByText('AP session')).not.toBeInTheDocument();
    expect(screen.getByText(/‹ Projects/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/‹ Projects/));
    expect(screen.getByText('studio')).toBeInTheDocument(); // back at folder list
    fireEvent.click(screen.getByText(/‹ Recent/));
    expect(screen.getByText('Studio session')).toBeInTheDocument(); // back at Recent (only 2 sessions total, both shown)
  });
});
