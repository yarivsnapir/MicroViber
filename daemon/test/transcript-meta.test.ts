import { describe, it, expect } from 'vitest';
import { scanTranscriptMeta } from '../src/lib/claude-adapter/transcript-meta.js';

function userLine(text: string, timestamp = '2026-08-25T10:00:00Z'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp });
}

function toolResultLine(timestamp = '2026-08-25T10:00:10Z'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp });
}

// An async Agent dispatch's tool_result is a launch acknowledgement, not the
// agent's actual output — real completion arrives later as a synthetic
// <task-notification> user entry tagged with origin.kind.
function asyncDispatchLine(timestamp = '2026-08-25T10:00:10Z'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'Async agent launched successfully.' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
    timestamp,
  });
}
function taskNotificationLine(timestamp = '2026-08-25T10:04:00Z'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' },
    origin: { kind: 'task-notification' },
    timestamp,
  });
}

function assistantLine(stop: string | null, content: unknown[], timestamp = '2026-08-25T10:00:05Z'): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop }, timestamp });
}
const toolUse = { type: 'tool_use', name: 'Bash', input: {} };
const text = (t: string) => ({ type: 'text', text: t });

describe('scanTranscriptMeta', () => {
  it('prefers the newest ai-title over any prompt text', () => {
    const jsonl = [userLine('first prompt'), JSON.stringify({ type: 'ai-title', aiTitle: 'Real title' })].join('\n');
    expect(scanTranscriptMeta(jsonl).title).toBe('Real title');
  });

  it('falls back to the last real prompt when there is no ai-title', () => {
    const jsonl = [userLine('do the thing')].join('\n');
    const meta = scanTranscriptMeta(jsonl);
    expect(meta.title).toBeNull();
    expect(meta.lastPrompt).toBe('do the thing');
  });

  it('does not let the CLI\'s own interruption marker become the fallback title', () => {
    const jsonl = [userLine('a real prompt'), userLine('[Request interrupted by user]')].join('\n');
    const meta = scanTranscriptMeta(jsonl);
    expect(meta.title).toBeNull();
    // The marker is discarded, so the last genuine prompt is still surfaced.
    expect(meta.lastPrompt).toBe('a real prompt');
  });

  it('does not let a bare interruption bump lastPromptAt either, so it can\'t jump a session to the top of the list showing a stale subtitle', () => {
    const jsonl = [
      userLine('a real prompt', '2026-08-25T10:00:00Z'),
      userLine('[Request interrupted by user]', '2026-08-25T10:05:00Z'),
    ].join('\n');
    const meta = scanTranscriptMeta(jsonl);
    expect(meta.lastPrompt).toBe('a real prompt');
    expect(meta.lastPromptAt).toBe('2026-08-25T10:00:00Z');
  });

  it('a manually-set custom-title wins over the auto-generated ai-title', () => {
    const jsonl = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Auto title' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'My title' }),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).title).toBe('My title');
  });

  it('a custom-title survives a later ai-title regeneration', () => {
    const jsonl = [
      JSON.stringify({ type: 'custom-title', customTitle: 'My title' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Auto title, regenerated later' }),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).title).toBe('My title');
  });
});

// A turn is "open" while the CLI is still mid-turn (tool running, model
// streaming next step) — distinguished from a turn parked waiting for the
// user, whose last assistant entry carries stop_reason 'end_turn'.
describe('scanTranscriptMeta turnOpen', () => {
  it('trailing assistant tool_use (stop_reason tool_use) => open: a tool is in flight', () => {
    const jsonl = [userLine('go'), assistantLine('tool_use', [toolUse])].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(true);
  });

  it('trailing tool_result user entry => open: the model is composing its next step', () => {
    const jsonl = [userLine('go'), assistantLine('tool_use', [toolUse]), toolResultLine()].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(true);
  });

  it('trailing real user prompt => open: the turn just started', () => {
    const jsonl = [userLine('go')].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(true);
  });

  it('trailing assistant end_turn => closed: parked waiting for the user', () => {
    const jsonl = [userLine('go'), assistantLine('end_turn', [text('done')])].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(false);
  });

  it('trailing interruption marker => closed: the user stopped the turn', () => {
    const jsonl = [userLine('go'), assistantLine('tool_use', [toolUse]), userLine('[Request interrupted by user]')].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(false);
  });

  it('metadata entries after an end_turn do not reopen the turn', () => {
    const jsonl = [
      userLine('go'),
      assistantLine('end_turn', [text('done')]),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'go' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'T' }),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).turnOpen).toBe(false);
  });

  it('empty transcript => closed', () => {
    expect(scanTranscriptMeta('').turnOpen).toBe(false);
  });
});

// Reproduces the false-idle bug: dispatching a background Agent parks the
// turn (turnOpen: false) seconds after launch, well before the job itself
// finishes minutes later. hasOutstandingBackgroundTask is the signal that
// lets deriveState tell that apart from genuinely waiting on the user.
describe('scanTranscriptMeta hasOutstandingBackgroundTask', () => {
  it('no async dispatch seen => false', () => {
    const jsonl = [userLine('go'), assistantLine('end_turn', [text('done')])].join('\n');
    expect(scanTranscriptMeta(jsonl).hasOutstandingBackgroundTask).toBe(false);
  });

  it('an async dispatch with no notification yet => true, even after the turn parks', () => {
    const jsonl = [
      userLine('go'),
      assistantLine('tool_use', [toolUse]),
      asyncDispatchLine(),
      assistantLine('end_turn', [text('Fix wave is running.')]),
    ].join('\n');
    const meta = scanTranscriptMeta(jsonl);
    expect(meta.turnOpen).toBe(false);
    expect(meta.hasOutstandingBackgroundTask).toBe(true);
  });

  it('a matching task-notification clears the outstanding flag', () => {
    const jsonl = [
      userLine('go'),
      assistantLine('tool_use', [toolUse]),
      asyncDispatchLine(),
      assistantLine('end_turn', [text('Fix wave is running.')]),
      taskNotificationLine(),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).hasOutstandingBackgroundTask).toBe(false);
  });

  it('two dispatches, one notification => still outstanding', () => {
    const jsonl = [
      asyncDispatchLine('2026-08-25T10:00:05Z'),
      asyncDispatchLine('2026-08-25T10:00:10Z'),
      taskNotificationLine('2026-08-25T10:04:00Z'),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).hasOutstandingBackgroundTask).toBe(true);
  });

  it('a notification with nothing outstanding does not go negative', () => {
    const jsonl = [taskNotificationLine(), asyncDispatchLine('2026-08-25T10:05:00Z')].join('\n');
    // one real dispatch after the stray notification => outstanding
    expect(scanTranscriptMeta(jsonl).hasOutstandingBackgroundTask).toBe(true);
  });
});
