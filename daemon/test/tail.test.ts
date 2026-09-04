import { describe, it, expect } from 'vitest';
import { normalizeLine, parseChunk, type TranscriptEvent } from '../src/lib/claude-adapter/tail.js';

const userLine = (text: string, ts = '2026-08-23T11:00:00.000Z') =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });

describe('normalizeLine', () => {
  it('normalizes a plain user turn (not injected)', () => {
    const e = normalizeLine(userLine('run the tests'));
    expect(e).toEqual({ kind: 'user', at: '2026-08-23T11:00:00.000Z', text: 'run the tests', injected: false });
  });

  it('does NOT unwrap a cross-session-message wrapper anymore — attach mode is gone, so it is just literal text', () => {
    const wrapped = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/29905.sock" from-name="my-project-f9" from-mode="bypass">\ncommit it and open the PR\n</cross-session-message>\n\nThis came from another Claude session.';
    const e = normalizeLine(userLine(wrapped)) as Extract<TranscriptEvent, { kind: 'user' }>;
    expect(e.kind).toBe('user');
    expect(e.text).toBe(wrapped);
    expect(e.injected).toBe(false);
  });

  it('normalizes an assistant text turn', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-08-23T11:00:05.000Z' });
    expect(normalizeLine(line)).toEqual({ kind: 'assistant', at: '2026-08-23T11:00:05.000Z', text: 'done' });
  });

  it('collapses a tool_use to a one-line tool event with a summary', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }, timestamp: '2026-08-23T11:00:06.000Z' });
    const e = normalizeLine(line) as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
    expect(e.summary).toContain('npm test');
  });

  it('returns null for unrenderable / unknown lines', () => {
    expect(normalizeLine('{"type":"queue-operation"}')).toBeNull();
    expect(normalizeLine('not json')).toBeNull();
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

describe('normalizeLine AskUserQuestion', () => {
  it('emits an unresolved askUserQuestion event for a bare AskUserQuestion tool_use (single-line, no lookahead)', () => {
    const e = normalizeLine(assistantToolUseLine('toolu_1', 'AskUserQuestion', askQuestionInput)) as Extract<TranscriptEvent, { kind: 'askUserQuestion' }>;
    expect(e.kind).toBe('askUserQuestion');
    expect(e.toolUseId).toBe('toolu_1');
    expect(e.resolved).toBe(false);
    expect(e.questions[0]?.question).toBe('Proceed?');
  });

  it('a non-AskUserQuestion tool_use is unaffected — still collapses to the generic tool kind', () => {
    const e = normalizeLine(assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' })) as Extract<TranscriptEvent, { kind: 'tool' }>;
    expect(e.kind).toBe('tool');
    expect(e.name).toBe('Bash');
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
    expect(e.selectedLabels).toEqual(['Yes']);
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
    expect(e?.selectedLabels).toEqual(['Yes']);
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

  it('an ordinary tool_result for a non-AskUserQuestion tool is unaffected (pre-existing behavior, untouched)', () => {
    const chunk = [
      assistantToolUseLine('toolu_2', 'Bash', { command: 'ls' }),
      toolResultLine('toolu_2', 'file1\nfile2'),
    ].join('\n') + '\n';
    const { events } = parseChunk(chunk);
    expect(events).toHaveLength(2); // tool event + the pre-existing blank user bubble — unchanged, out of this task's scope
    expect(events[0]!.kind).toBe('tool');
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
    expect(e?.selectedLabels).toEqual(['Yes']);
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
    expect(e1?.selectedLabels).toEqual(['Yes']);
    expect(e2?.resolved).toBe(true);
    expect(e2?.selectedLabels).toEqual(['No']);
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
    expect(e?.selectedLabels).toEqual(['No']);
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
    expect(e?.selectedLabels).toEqual(['Yes']);
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
});
