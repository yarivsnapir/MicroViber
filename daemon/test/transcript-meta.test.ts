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

const askUserQuestionInput = {
  questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }], multiSelect: false }],
};

function askUserQuestionToolUse(id: string) {
  return { type: 'tool_use', id, name: 'AskUserQuestion', input: askUserQuestionInput };
}

function toolResultForId(toolUseId: string, timestamp = '2026-08-25T10:00:10Z'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Yes' }] },
    timestamp,
  });
}

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

// A pending AskUserQuestion is a structural signal (story microviber-track-b-8,
// spec.md §6) that later overrides deriveState's timing heuristics entirely —
// distinguished from an ordinary tool_use because its stop_reason is also
// 'tool_use', so nothing else in the transcript tells the two apart.
describe('scanTranscriptMeta pendingQuestion', () => {
  it('detects a pending AskUserQuestion (tool_use with no matching tool_result yet)', () => {
    const jsonl = [userLine('go'), assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')])].join('\n');
    const meta = scanTranscriptMeta(jsonl);
    expect(meta.pendingQuestion).not.toBeNull();
    expect(meta.pendingQuestion?.toolUseId).toBe('toolu_1');
    expect(meta.pendingQuestion?.questions[0]?.question).toBe('Proceed?');
  });

  it('clears pendingQuestion once a matching tool_result arrives', () => {
    const jsonl = [
      userLine('go'),
      assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]),
      toolResultForId('toolu_1'),
    ].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });

  it('ignores a tool_use for any tool other than AskUserQuestion', () => {
    const jsonl = [userLine('go'), assistantLine('tool_use', [toolUse])].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });

  it('clears pendingQuestion on a later human text turn (rule b)', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('Answering your question:\n- Confirm: Yes', '2026-08-25T10:00:20Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });
  it('clears pendingQuestion on the interruption marker', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('[Request interrupted by user]', '2026-08-25T10:00:20Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });
  it('clears pendingQuestion on a human turn carrying origin.kind: "human" (F18 addendum FAIL)', () => {
    const humanOriginLine = JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'Answering your question:\n- Confirm: Yes' }] }, timestamp: '2026-08-25T10:00:20Z' });
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), humanOriginLine].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion).toBeNull();
  });
  it('does NOT clear pendingQuestion on the isMeta handshake turn', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] }, timestamp: '2026-08-25T10:00:11Z' });
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), meta, assistantLine('end_turn', [text('No response requested.')], '2026-08-25T10:00:12Z')].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion?.toolUseId).toBe('toolu_1');
  });
  it('does NOT clear pendingQuestion on a task-notification entry', () => {
    const jsonl = [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), taskNotificationLine()].join('\n');
    expect(scanTranscriptMeta(jsonl).pendingQuestion?.toolUseId).toBe('toolu_1');
  });
  it('agrees with tail.ts on a shared fixture set: pendingQuestion === null exactly when tail reports resolved', async () => {
    const { parseChunk } = await import('../src/lib/claude-adapter/tail.js');
    const fixtures = [
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')])],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), toolResultForId('toolu_1')],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), userLine('free text', '2026-08-25T10:00:20Z')],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } })],
      [assistantLine('tool_use', [askUserQuestionToolUse('toolu_1')]), taskNotificationLine()],
    ];
    for (const lines of fixtures) {
      const jsonl = lines.join('\n') + '\n';
      const tailResolved = parseChunk(jsonl).events.some((e) => e.kind === 'askUserQuestion' && e.resolved);
      expect(scanTranscriptMeta(jsonl).pendingQuestion === null).toBe(tailResolved);
    }
  });
});
