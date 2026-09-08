// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToolResult } from '../src/components/transcript/ToolResult.js';
import { ToolCall } from '../src/components/transcript/ToolCall.js';
import { Transcript } from '../src/components/Transcript.js';

afterEach(cleanup);

const ok = { kind: 'toolResult' as const, at: '', toolUseId: 'toolu_a', ok: true, text: 'all 42 tests passed', truncated: false };

describe('ToolResult', () => {
  it('collapses to a one-line preview and expands on tap', () => {
    render(<ToolResult e={{ ...ok, text: 'first line\nsecond line' }} />);
    expect(screen.queryByText(/second line/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/second line/)).toBeInTheDocument();
  });

  it('collapses again on a second tap (manual checklist: expands to full output, then collapses)', () => {
    render(<ToolResult e={{ ...ok, text: 'first line\nsecond line' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/second line/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/second line/)).toBeNull();
  });

  it('tints a failed result', () => {
    const { container } = render(<ToolResult e={{ ...ok, ok: false, text: 'boom' }} />);
    expect(container.innerHTML).toContain('red');
  });

  it('marks a truncated result when expanded', () => {
    render(<ToolResult e={{ ...ok, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('shows a placeholder rather than an empty row for an empty result', () => {
    render(<ToolResult e={{ ...ok, text: '' }} />);
    expect(screen.getByRole('button').textContent).toMatch(/empty result/i);
  });
});

const toolEvent = {
  kind: 'tool' as const, at: '', id: 'toolu_a', name: 'Bash',
  summary: 'npm test', input: { command: 'npm test', description: 'run the suite' }, truncated: false,
};

describe('ToolCall', () => {
  it('collapses to the tool name and summary', () => {
    render(<ToolCall e={toolEvent} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText(/run the suite/)).toBeNull();
  });

  it('expands on tap to reveal every input field', () => {
    render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/run the suite/)).toBeInTheDocument();
    // getAllBy*, not getBy*: 'npm test' is BOTH the collapsed summary (which
    // stays visible in the button while expanded) and the value of the
    // `command` input field, so a single-node query matches two nodes and
    // throws. The count is the real assertion — the field is present in
    // ADDITION to the summary line.
    expect(screen.getByText('command:')).toBeInTheDocument();
    expect(screen.getAllByText(/npm test/).length).toBeGreaterThan(1);
  });

  it('flags a truncated payload when expanded', () => {
    render(<ToolCall e={{ ...toolEvent, truncated: true }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('keeps a non-string field visible, so a MultiEdit edit array survives (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/old_string/)).toBeInTheDocument();
  });

  it("shows a Read's offset and limit, which the old summary-only event dropped (AC11)", () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Read', summary: 'daemon/src/config.ts', input: { file_path: 'daemon/src/config.ts', offset: 120, limit: 40 } }} />);
    // Collapsed, the summary is all you get — that was the whole event before story-1.
    expect(screen.queryByText(/offset/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('offset:')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('limit:')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('says so rather than rendering an empty box when there is no input', () => {
    render(<ToolCall e={{ ...toolEvent, input: {} }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/no input/i)).toBeInTheDocument();
  });
});

describe('ToolCall diff branch', () => {
  it('renders a red/green diff for an Edit when expanded (AC20)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', summary: 'a.ts', input: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const a = 2;/)).toBeInTheDocument();
  });

  it('renders a Write as an all-addition diff (AC20)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Write', summary: 'a.ts', input: { file_path: 'a.ts', content: 'line one\nline two' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/\+ line one/)).toBeInTheDocument();
    expect(screen.getByText(/\+ line two/)).toBeInTheDocument();
  });

  it('gives the diff its own horizontal scroll container, so a long line never scrolls the transcript (AC22)', () => {
    const { container } = render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { old_string: 'a'.repeat(400), new_string: 'b'.repeat(400) } }} />);
    fireEvent.click(screen.getByRole('button'));
    const pre = container.querySelector('pre.overflow-x-auto');
    expect(pre).not.toBeNull();
  });

  it('still lists every other input field beside the diff (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/file_path/)).toBeInTheDocument();
  });

  it('keeps the diffed fields themselves in the key/value list, so a capped edit stays diagnosable (AC23)', () => {
    render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('old_string:')).toBeInTheDocument();
    expect(screen.getByText('new_string:')).toBeInTheDocument();
  });

  it('tints removals red, additions green and context muted (manual checklist)', () => {
    const { container } = render(<ToolCall e={{ ...toolEvent, name: 'Edit', input: { old_string: 'ctx\nold line\ntail', new_string: 'ctx\nnew line\ntail' } }} />);
    fireEvent.click(screen.getByRole('button'));
    const rows = Array.from(container.querySelectorAll('pre.overflow-x-auto > div'));
    const cls = (needle: string) => rows.find((r) => r.textContent?.includes(needle))?.className ?? '';
    expect(cls('old line')).toContain('red');
    expect(cls('new line')).toContain('emerald');
    // Context is muted, and explicitly neither of the two change tints.
    expect(cls('ctx')).toContain('zinc');
    expect(cls('ctx')).not.toContain('red');
    expect(cls('ctx')).not.toContain('emerald');
  });

  it('renders no diff for a tool whose input has no edit strings', () => {
    const { container } = render(<ToolCall e={toolEvent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('pre.overflow-x-auto')).toBeNull();
  });
});

/**
 * Dispatcher-level order, which the per-component tests above cannot see.
 * Before story-1 the normalizer discarded prose that shared a message with a
 * tool call and kept only the LAST of several calls, so this shape could not
 * reach the renderer at all (AC1/AC2).
 */
describe('Transcript renders a widened turn in source order', () => {
  it('puts the explanation above its tool line, then the result below it', () => {
    const { container } = render(
      <Transcript sessionId="s1" sessionCwd="/proj" canAnswer={false} answerInFlight={null} events={[
        { kind: 'assistant', at: '', text: 'Let me check the config.' },
        { kind: 'tool', at: '', id: 'toolu_a', name: 'Read', summary: 'a.ts', input: { file_path: 'a.ts' }, truncated: false },
        { kind: 'toolResult', at: '', toolUseId: 'toolu_a', ok: true, text: 'export const a = 1;', truncated: false },
        { kind: 'tool', at: '', id: 'toolu_b', name: 'Grep', summary: 'TODO', input: { pattern: 'TODO' }, truncated: false },
      ]} />,
    );
    const text = container.textContent ?? '';
    const at = (needle: string) => text.indexOf(needle);
    expect(at('Let me check the config.')).toBeGreaterThanOrEqual(0);
    expect(at('Let me check the config.')).toBeLessThan(at('Read'));
    expect(at('Read')).toBeLessThan(at('export const a = 1;'));
    // Both tool calls survive — the old walker kept only the last.
    expect(at('Grep')).toBeGreaterThan(at('Read'));
  });
});
