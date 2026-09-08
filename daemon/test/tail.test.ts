import { describe, it, expect } from 'vitest';
import { normalizeLine, parseChunk, type TranscriptEvent } from '../src/lib/claude-adapter/tail.js';

const userLine = (text: string, ts = '2026-08-23T11:00:00.000Z') =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });

describe('normalizeLine', () => {
  it('normalizes a plain user turn (not injected)', () => {
    const e = normalizeLine(userLine('run the tests'));
    expect(e).toEqual([{ kind: 'user', at: '2026-08-23T11:00:00.000Z', text: 'run the tests', injected: false }]);
  });

  it('does NOT unwrap a cross-session-message wrapper anymore — attach mode is gone, so it is just literal text', () => {
    const wrapped = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/29905.sock" from-name="my-project-f9" from-mode="bypass">\ncommit it and open the PR\n</cross-session-message>\n\nThis came from another Claude session.';
    const e = normalizeLine(userLine(wrapped))[0] as Extract<TranscriptEvent, { kind: 'user' }>;
    expect(e.kind).toBe('user');
    expect(e.text).toBe(wrapped);
    expect(e.injected).toBe(false);
  });

  it('normalizes an assistant text turn', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-08-23T11:00:05.000Z' });
    expect(normalizeLine(line)).toEqual([{ kind: 'assistant', at: '2026-08-23T11:00:05.000Z', text: 'done' }]);
  });

  it('collapses a tool_use to a one-line tool event with a summary', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }, timestamp: '2026-08-23T11:00:06.000Z' });
    const e = normalizeLine(line)[0] as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
    expect(e.summary).toContain('npm test');
  });

  it('returns an empty array for unrenderable / unknown lines', () => {
    expect(normalizeLine('{"type":"queue-operation"}')).toEqual([]);
    expect(normalizeLine('not json')).toEqual([]);
  });
});

describe('normalizeLine emits every block (story-1)', () => {
  it('keeps assistant prose that shares a message with a tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the config.' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'daemon/src/config.ts' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'assistant', text: 'Let me check the config.' });
    expect(events[1]).toMatchObject({ kind: 'tool', name: 'Read', id: 'toolu_a' });
  });

  it('keeps every tool call in a multi-tool message, not just the last', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: { pattern: 'TODO' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events.map((e) => e.kind)).toEqual(['tool', 'tool']);
    expect(events.map((e) => (e.kind === 'tool' ? e.name : ''))).toEqual(['Read', 'Grep']);
    expect(events.map((e) => (e.kind === 'tool' ? e.id : ''))).toEqual(['toolu_a', 'toolu_b']);
  });

  it('joins several text blocks with a blank line, not a single space', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First para.' }, { type: 'text', text: 'Second para.' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const events = normalizeLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'assistant', text: 'First para.\n\nSecond para.' });
  });

  it('returns an empty array for an unparseable or unrenderable line', () => {
    expect(normalizeLine('not json')).toEqual([]);
    expect(normalizeLine('')).toEqual([]);
    expect(normalizeLine('{"type":"queue-operation"}')).toEqual([]);
  });
});

describe('parseChunk (incremental, append-only)', () => {
  it('emits complete lines and holds a partial trailing line', () => {
    const a = parseChunk(userLine('one') + '\n' + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"tw');
    expect(a.events).toHaveLength(1);
    expect((a.events[0] as Extract<TranscriptEvent,{kind:'user'}>).text).toBe('one');
    // feed the remainder + rest of the second line
    const b = parseChunk(a.remainder + 'o"}]}}\n');
    expect(b.events).toHaveLength(1);
    expect((b.events[0] as Extract<TranscriptEvent,{kind:'user'}>).text).toBe('two');
    expect(b.remainder).toBe('');
  });

  it('does not throw on a partial trailing line', () => {
    expect(() => parseChunk('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x')).not.toThrow();
  });
});

const assistantToolUseLine = (id: string, name: string, input: unknown, ts = '2026-08-23T11:00:06.000Z') =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: ts });

const toolResultLine = (toolUseId: string, content: string, ts = '2026-08-23T11:00:10.000Z') =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }, timestamp: ts });

const askQuestionInput = { questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] };

describe('tool results become their own event (story-1)', () => {
  it('emits a toolResult instead of a blank user bubble', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok, 3 files changed' }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)).toEqual([
      { kind: 'toolResult', at: '2026-09-06T10:00:02.000Z', toolUseId: 'toolu_a', ok: true, text: 'ok, 3 files changed', truncated: false },
    ]);
  });

  it('marks is_error results as not ok', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'boom', is_error: true }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)[0]).toMatchObject({ kind: 'toolResult', ok: false, text: 'boom' });
  });

  it('flattens an array tool_result content to its text blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }],
      },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(line)[0]).toMatchObject({ kind: 'toolResult', text: 'line one\nline two' });
  });

  it('serialises a non-string, non-array tool_result content to JSON, and absent content to empty', () => {
    const objLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: { rows: 2 } }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(objLine)[0]).toMatchObject({ kind: 'toolResult', text: '{"rows":2}' });

    const bareLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    expect(normalizeLine(bareLine)[0]).toMatchObject({ kind: 'toolResult', text: '' });
  });

  it('truncates an oversized result and flags it', () => {
    const huge = 'x'.repeat(40_000);
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: huge }] },
      timestamp: '2026-09-06T10:00:02.000Z',
    });
    const ev = normalizeLine(line)[0];
    expect(ev).toMatchObject({ kind: 'toolResult', truncated: true });
    if (ev?.kind !== 'toolResult') throw new Error('expected toolResult');
    expect(ev.text.length).toBeLessThanOrEqual(32_001);
  });

  it('still drops the AskUserQuestion tool_result line entirely rather than surfacing it as a toolResult (AC15)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    expect(parseChunk(chunk).events.map((e) => e.kind)).toEqual(['askUserQuestion']);
  });
});

describe('thinking blocks carry their text (story-1)', () => {
  it('emits a thinking event with the reasoning text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'the config is probably stale' }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(normalizeLine(line)).toEqual([
      { kind: 'thinking', at: '2026-09-06T10:00:00.000Z', text: 'the config is probably stale' },
    ]);
  });

  it('keeps thinking, prose, and a tool call from one message, in source order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check the file first' },
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(normalizeLine(line).map((e) => e.kind)).toEqual(['assistant', 'thinking', 'tool']);
  });
});

describe('tool events carry their full input (story-1)', () => {
  it('keeps every input field, not just the summary key', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Edit', input: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } }],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    expect(ev).toMatchObject({ kind: 'tool', name: 'Edit', summary: 'a.ts', truncated: false });
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.input).toEqual({ file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  });

  it('caps each oversized string field individually and flags the event, keeping the object shape', () => {
    const huge = 'y'.repeat(40_000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Write', input: { file_path: 'a.ts', content: huge } }] },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.truncated).toBe(true);
    expect(String(ev.input.content).length).toBeLessThanOrEqual(32_001);
    // The shape survives: DiffView addresses fields by name (AC12).
    expect(ev.input.file_path).toBe('a.ts');
  });

  it('keeps non-string input fields untouched, so a MultiEdit edit array and a TodoWrite list still ship', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } }],
      },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    const ev = normalizeLine(line)[0];
    if (ev?.kind !== 'tool') throw new Error('expected tool');
    expect(ev.input.edits).toEqual([{ old_string: 'x', new_string: 'y' }]);
  });

  it('yields an empty input object when the tool input is not an object (AC13)', () => {
    for (const input of ['just a string', 42, null, ['an', 'array']]) {
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Weird', input }] },
        timestamp: '2026-09-06T10:00:00.000Z',
      });
      const ev = normalizeLine(line)[0];
      if (ev?.kind !== 'tool') throw new Error('expected tool');
      expect(ev.input).toEqual({});
      expect(ev.truncated).toBe(false);
    }
  });
});

describe('normalizeLine AskUserQuestion', () => {
  it('emits an unresolved askUserQuestion event for a bare AskUserQuestion tool_use (single-line, no lookahead)', () => {
    const events = normalizeLine(assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput));
    // EXACTLY one event: the detection keeps its whole-content short-circuit,
    // because resolveAskUserQuestions depends on one such event per line
    // (story-1 AC14).
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.kind).toBe('askUserQuestion');
    expect(e.toolUseId).toBe('toolu_1');
    expect(e.resolved).toBe(false);
    expect(e.questions[0]?.question).toBe('Proceed?');
  });

  it('a non-AskUserQuestion tool_use is unaffected — still collapses to the generic tool kind', () => {
    const e = normalizeLine(assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' }))[0] as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
    expect(e.id).toBe('toolu_2');
  });

  it('multiSelect survives parseChunk onto the askUserQuestion event (spec: PWA branches on it for checkbox vs radio)', () => {
    const input = { questions: [{ question: 'Which?', header: 'Scope', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] };
    const { events } = parseChunk(assistantToolUseLine('toolu_1', 'AskUserQuestion', input) + '\n');
    const e = events.find((ev) => ev.kind === 'askUserQuestion') as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e?.questions[0]?.multiSelect).toBe(true);
  });
});

describe('parseChunk AskUserQuestion resolution (cross-line)', () => {
  it('marks a pending AskUserQuestion resolved when its matching tool_result appears later, and drops the blank answer bubble', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(1); // the blank tool_result-only user bubble is dropped
    const e = events[0] as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.resolved).toBe(true);
    expect(e.selectedLabels).toEqual([['Yes']]);
  });

  it('resolves correctly even with housekeeping lines between the tool_use and its tool_result (the real resumed-takeover-answer shape)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Some session' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual([['Yes']]);
  });

  it('a resolved askUserQuestion\'s `at` becomes the tool_result\'s own timestamp (resolution instant), not the original ask-time (code review finding, story-8 Task 7 fix round — services.ts uses this `at` as PromptRecord.observedAt)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput, '2026-08-23T11:00:06.000Z'),
      toolResultLine('toolu_1', 'Yes', '2026-08-23T11:05:00.000Z'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.at).toBe('2026-08-23T11:05:00.000Z');
  });

  it('falls back to the original ask-time when the resolving tool_result line has no timestamp of its own, rather than going blank', () => {
    const noTsResultLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' }] },
    });
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput, '2026-08-23T11:00:06.000Z'),
      noTsResultLine,
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.at).toBe('2026-08-23T11:00:06.000Z');
  });

  it('stays unresolved with no matching tool_result yet', () => {
    const chunk = assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput) + '\n';
    const { events } = parseChunk(chunk);
    const e = events[0] as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.resolved).toBe(false);
    expect(e.selectedLabels).toBeUndefined();
  });

  it('an ordinary tool_result now becomes a toolResult event instead of a blank user bubble (story-1 AC6 — was asserted broken here)', () => {
    const chunk = [
      assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' }),
      toolResultLine('toolu_2', 'file1\nfile2'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events.map((e) => e.kind)).toEqual(['tool', 'toolResult']);
    expect(events[1]).toMatchObject({ kind: 'toolResult', toolUseId: 'toolu_2', ok: true, text: 'file1\nfile2' });
  });

  it('resolves even when the tool_result content array bundles multiple blocks (mirrors transcript-meta.ts scanning every block, not just a single-element array)', () => {
    const multiBlockResultLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_9', content: 'unrelated result' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Yes' },
        ],
      },
      timestamp: '2026-08-23T11:00:10.000Z',
    });
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      multiBlockResultLine,
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual([['Yes']]);
  });

  it('a tool_result with non-string content resolves with selectedLabels undefined (one "no labels" shape, spec §4.1)', () => {
    const objectContentResultLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: { some: 'object' } }] },
      timestamp: '2026-08-23T11:00:10.000Z',
    });
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      objectContentResultLine,
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toBeUndefined();
  });

  it('resolves two simultaneous pending AskUserQuestions in one chunk independently', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      assistantToolUseLine('toolu_2', 'AskUserQuestion', askQuestionInput),
      toolResultLine('toolu_2', 'No'),
      toolResultLine('toolu_1', 'Yes'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const askEvents = events.filter((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(askEvents).toHaveLength(2);
    const e1 = askEvents.find((ev) => ev.toolUseId === 'toolu_1');
    const e2 = askEvents.find((ev) => ev.toolUseId === 'toolu_2');
    expect(e1?.resolved).toBe(true);
    expect(e1?.selectedLabels).toEqual([['Yes']]);
    expect(e2?.resolved).toBe(true);
    expect(e2?.selectedLabels).toEqual([['No']]);
  });

  it('ONE tool_use carrying TWO questions, answered by a tool_result STUB, splits positionally (story-3 AC2 at the wire)', () => {
    // The sibling test above is two tool_use ids with one question each, so it
    // never reaches splitStubAcrossQuestions' positional branch. This one does:
    // a single stub string covering both questions, which share a Yes/No option
    // set — the exact case a flat selectedLabels would cross-highlight.
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', { questions: [yn('First'), yn('Second')] }),
      toolResultLine('toolu_1', 'Yes, No'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('tool_result');
    expect(e?.selectedLabels).toEqual([['Yes'], ['No']]);
  });

  it('a two-question call resolved by the REAL pair-format stub splits per question at the wire (story-3 AC7)', () => {
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const stub = 'Your questions have been answered: "First?"="Yes", "Second?"="No". You can now continue with these answers in mind.';
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', { questions: [yn('First'), yn('Second')] }),
      toolResultLine('toolu_1', stub),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    const e = events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('tool_result');
    expect(e?.selectedLabels).toEqual([['Yes'], ['No']]);
  });
});

describe('parseChunk AskUserQuestion resolution — rule (b), human text turn (spec §4.1)', () => {
  const metaLine = (text: string, ts = '2026-08-23T11:00:08.000Z') =>
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const notificationLine = (ts = '2026-08-23T11:00:08.000Z') =>
    JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>x</task-notification>' }, timestamp: ts });
  const humanOriginLine = (text: string, ts = '2026-08-23T11:00:20.000Z') =>
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const find = (events: TranscriptEvent[]) => events.find((ev): ev is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => ev.kind === 'askUserQuestion');

  it('a later plain text turn resolves the question by text, KEEPS the user bubble, and highlights labels parsed from the composed format', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      userLine('Answering your question:\n- Confirm: No', '2026-08-23T11:00:20.000Z'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(2); // the human turn stays visible
    const e = find(events);
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('text');
    expect(e?.selectedLabels).toEqual([['No']]);
    expect(e?.at).toBe('2026-08-23T11:00:20.000Z');
    expect(events[1]).toMatchObject({ kind: 'user', text: 'Answering your question:\n- Confirm: No' });
  });

  it('free text resolves with no labels', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), userLine('go with the first one')].join('\n') + '\n');
    const e = find(events);
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('text');
    expect(e?.selectedLabels).toBeUndefined();
  });

  it('a human-typed turn with origin.kind: "human" resolves the question (F18 addendum FAIL — origin is present on real human turns)', () => {
    const chunk = [assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), humanOriginLine('Answering your question:\n- Confirm: Yes')].join('\n') + '\n';
    const e = find(parseChunk(chunk).events);
    expect(e?.resolved).toBe(true);
    expect(e?.resolvedBy).toBe('text');
    expect(e?.selectedLabels).toEqual([['Yes']]);
  });

  it('the isMeta handshake turn and its "No response requested." reply do NOT resolve the question', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      metaLine('Continue from where you left off.'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }], stop_reason: 'end_turn' }, timestamp: '2026-08-23T11:00:09.000Z' }),
    ].join('\n') + '\n';
    const e = find(parseChunk(chunk).events);
    expect(e?.resolved).toBe(false);
  });

  it('the isMeta handshake turn does not render as a user event at all (story askuserquestion-answer-mechanism-2)', () => {
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput),
      metaLine('Continue from where you left off.'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events.some((e) => e.kind === 'user')).toBe(false);
  });

  it('a task-notification entry does NOT resolve the question', () => {
    const e = find(parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), notificationLine()].join('\n') + '\n').events);
    expect(e?.resolved).toBe(false);
  });

  it('the tool_result clause still wins and still drops its blank bubble, now tagged resolvedBy tool_result', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), toolResultLine('toolu_1', 'Yes')].join('\n') + '\n');
    expect(events).toHaveLength(1);
    expect(find(events)?.resolvedBy).toBe('tool_result');
  });

  it('a <tool_use_error> tool_result resolves without labels (F18 corollary)', () => {
    const { events } = parseChunk([assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput), toolResultLine('toolu_1', '<tool_use_error>Error: No such tool available: AskUserQuestion.</tool_use_error>')].join('\n') + '\n');
    expect(find(events)?.selectedLabels).toBeUndefined();
  });

  it('two questions sharing an option set keep their answers apart end-to-end (story-3 AC5, the regression)', () => {
    const yn = (header: string) => ({
      question: `${header}?`, header, multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    const twoQuestions = { questions: [yn('First'), yn('Second')] };
    const chunk = [
      assistantToolUseLine('toolu_1', 'AskUserQuestion', twoQuestions),
      userLine('Answering your questions:\n- First: Yes\n- Second: No', '2026-08-23T11:00:20.000Z'),
    ].join('\n') + '\n';
    const e = find(parseChunk(chunk).events);
    expect(e?.resolved).toBe(true);
    expect(e?.selectedLabels).toEqual([['Yes'], ['No']]);
  });
});
