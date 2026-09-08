/**
 * story-1 (microviber-track-c-1) — end-to-end normalizer diagnostic.
 *
 * Run:  npx tsx docs/features/microviber-track-c/stories/story-1-manual-test.ts
 *
 * Why this exists. story-1's manual checklist is mostly "look at the phone",
 * but a good half of each item is really a question about the EVENT STREAM the
 * daemon hands the phone — did the prose survive next to the tool call, did
 * every call survive, did the blank bubble go, is the payload capped. Those are
 * answerable without a device, so they are answered here instead of being
 * handed to a person.
 *
 * This drives the REAL `parseChunk` over a synthetic transcript shaped like
 * Claude Code's own `.jsonl`. It reads nothing from `~/.claude`, touches no
 * network, needs no daemon running and no credentials, and writes nothing.
 * What it cannot do is tell you whether the result LOOKS right on a phone —
 * that part stays on the human checklist.
 */
import { parseChunk, type TranscriptEvent } from '../../../../daemon/src/lib/claude-adapter/tail.js';

// ─── a synthetic session, in Claude Code's transcript shape ──────────────────

const ts = (n: number) => `2026-09-08T10:00:${String(n).padStart(2, '0')}.000Z`;

const line = (o: unknown) => JSON.stringify(o);

const HUGE = 'x'.repeat(40_000);

const transcript = [
  // a plain human turn
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'check the config and fix the port' }] }, timestamp: ts(1) }),

  // thinking + prose + TWO tool calls in ONE assistant message.
  // Pre-story-1 this whole line collapsed to a single `tool` event for Grep.
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'the port is probably hardcoded somewhere' },
        { type: 'text', text: 'Let me look at the config.' },
        { type: 'text', text: 'I will grep for the port too.' },
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'daemon/src/config.ts', offset: 120, limit: 40 } },
        { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: '9008' } },
      ],
    },
    timestamp: ts(2),
  }),

  // an ordinary tool result — the empty grey box, pre-story-1
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export const PORT = 9008;' }] }, timestamp: ts(3) }),

  // a FAILED tool result
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_grep', content: 'grep: no such file', is_error: true }] }, timestamp: ts(4) }),

  // an Edit, so the phone can draw a diff
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'daemon/src/config.ts', old_string: 'export const PORT = 9008;', new_string: 'export const PORT = Number(process.env.PORT ?? 9008);' } }] },
    timestamp: ts(5),
  }),

  // a result far too big to ship whole
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: HUGE }] }, timestamp: ts(6) }),

  // a Write, whose whole content is one huge string field
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: 'a.ts', content: HUGE } }] }, timestamp: ts(7) }),

  // the resume handshake Claude Code injects itself — must never render
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] }, isMeta: true, timestamp: ts(8) }),

  // an AskUserQuestion, and the laptop's answer stub that resolves it
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?', header: 'Confirm', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] } }],
    },
    timestamp: ts(9),
  }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Confirm: Yes' }] }, timestamp: ts(10) }),
].join('\n') + '\n';

// ─── run the real normalizer ─────────────────────────────────────────────────

const { events, remainder } = parseChunk(transcript);

const kinds = events.map((e) => e.kind);
const tools = events.filter((e): e is Extract<TranscriptEvent, { kind: 'tool' }> => e.kind === 'tool');
const results = events.filter((e): e is Extract<TranscriptEvent, { kind: 'toolResult' }> => e.kind === 'toolResult');
const thinking = events.filter((e): e is Extract<TranscriptEvent, { kind: 'thinking' }> => e.kind === 'thinking');
const users = events.filter((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user');
const assistants = events.filter((e): e is Extract<TranscriptEvent, { kind: 'assistant' }> => e.kind === 'assistant');
const asks = events.filter((e): e is Extract<TranscriptEvent, { kind: 'askUserQuestion' }> => e.kind === 'askUserQuestion');

const CAP = 32_000;
const byName = (n: string) => tools.find((t) => t.name === n);
const read = byName('Read');
const edit = byName('Edit');
const write = byName('Write');

// ─── checks, one per acceptance criterion this script can reach ──────────────

interface Check { ac: string; what: string; pass: boolean; detail: string }

const checks: Check[] = [
  {
    ac: 'AC1', what: 'prose sharing a message with a tool call survives',
    pass: assistants.some((a) => a.text.includes('Let me look at the config.')),
    detail: `assistant events: ${assistants.length}`,
  },
  {
    ac: 'AC2', what: 'BOTH tool calls in the multi-tool message survive, in order',
    pass: tools.map((t) => t.name).join(',').startsWith('Read,Grep'),
    detail: `tool order: ${tools.map((t) => t.name).join(' → ')}`,
  },
  {
    ac: 'AC3', what: 'two text blocks join with a blank line, not a space',
    pass: assistants.some((a) => a.text.includes('config.\n\nI will grep')),
    detail: JSON.stringify(assistants[0]?.text ?? ''),
  },
  {
    ac: 'AC5/AC6', what: 'tool results are their own event; NO blank user bubble',
    // 4 tool_result lines go in, 3 come out: the 4th is the AskUserQuestion
    // answer stub, which is deliberately consumed whole by the resolution pass
    // rather than surfacing as a toolResult (that is AC15, checked below).
    // Exactly 1 user event — the single real human turn. The isMeta handshake
    // and every tool_result-only line contribute none.
    pass: results.length === 3 && users.length === 1,
    detail: `toolResult events: ${results.length} (expect 3 of 4 tool_result lines — the AskUserQuestion stub is consumed), user events: ${users.length} (expect 1)`,
  },
  {
    ac: 'AC7', what: 'is_error marks a result not-ok; everything else ok',
    pass: results.filter((r) => !r.ok).length === 1 && results.find((r) => !r.ok)?.text === 'grep: no such file',
    detail: `not-ok results: ${results.filter((r) => !r.ok).map((r) => r.text).join(' | ')}`,
  },
  {
    ac: 'AC9', what: 'thinking carries its reasoning text',
    pass: thinking.length === 1 && thinking[0]?.text === 'the port is probably hardcoded somewhere',
    detail: `thinking: ${JSON.stringify(thinking[0]?.text ?? null)}`,
  },
  {
    ac: 'AC10', what: 'no `error` event kind is ever constructed',
    pass: !kinds.includes('error' as TranscriptEvent['kind']),
    detail: `kinds seen: ${[...new Set(kinds)].join(', ')}`,
  },
  {
    ac: 'AC11', what: "a Read's offset and limit reach the phone (old event dropped them)",
    pass: read?.input.offset === 120 && read?.input.limit === 40 && read?.summary === 'daemon/src/config.ts',
    detail: `Read input: ${JSON.stringify(read?.input)} · summary: ${JSON.stringify(read?.summary)}`,
  },
  {
    ac: 'AC12', what: 'each oversized STRING FIELD is capped and the event flagged',
    pass: write?.truncated === true && String(write?.input.content ?? '').length <= CAP + 1 && write?.input.file_path === 'a.ts',
    detail: `Write truncated=${String(write?.truncated)} content=${String(write?.input.content ?? '').length} chars, file_path kept=${JSON.stringify(write?.input.file_path)}`,
  },
  {
    ac: 'AC12', what: 'an oversized tool RESULT is capped and flagged',
    pass: results.some((r) => r.truncated && r.text.length <= CAP + 1),
    detail: `max result length: ${Math.max(...results.map((r) => r.text.length))}, truncated flags: ${results.map((r) => r.truncated).join(',')}`,
  },
  {
    ac: 'AC12', what: 'the object KEEPS ITS SHAPE so the diff can address fields by name',
    pass: typeof edit?.input.old_string === 'string' && typeof edit?.input.new_string === 'string',
    detail: `Edit input keys: ${Object.keys(edit?.input ?? {}).join(', ')}`,
  },
  {
    ac: 'AC14/AC15', what: 'the AskUserQuestion resolves, and its tool_result is DROPPED (not a toolResult)',
    pass: asks.length === 1 && asks[0]?.resolved === true && !results.some((r) => r.toolUseId === 'toolu_ask'),
    detail: `asks: ${asks.length}, resolved: ${String(asks[0]?.resolved)}, resolvedBy: ${String(asks[0]?.resolvedBy)}, leaked as toolResult: ${String(results.some((r) => r.toolUseId === 'toolu_ask'))}`,
  },
  {
    ac: 'F17/F18', what: 'the isMeta resume handshake still never renders',
    pass: !users.some((u) => u.text.includes('Continue from where you left off')),
    detail: `user texts: ${users.map((u) => JSON.stringify(u.text)).join(', ')}`,
  },
  {
    ac: '—', what: 'parseChunk consumed every complete line (no remainder)',
    pass: remainder === '',
    detail: `remainder: ${JSON.stringify(remainder)}`,
  },
];

// ─── report ──────────────────────────────────────────────────────────────────

console.log('\nstory-1 normalizer diagnostic — real parseChunk over a synthetic transcript\n');
console.log(`  ${events.length} events from 10 transcript lines`);
console.log(`  stream: ${kinds.join(' · ')}\n`);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? '✅' : '❌'} [${c.ac}] ${c.what}`);
  console.log(`       ${c.detail}`);
}

console.log(`\n  ${checks.length - failed}/${checks.length} checks passed\n`);

if (failed > 0) {
  console.log('  FAILED — the event stream the phone would receive is wrong.\n');
  process.exitCode = 1;
} else {
  console.log('  All normalizer-level checks pass. What remains is genuinely visual:');
  console.log('  whether this stream LOOKS right on a phone. See story-1.md.\n');
}
