/**
 * DEV-ONLY preview harness for story-1 (microviber-track-c-1).
 *
 * Renders the REAL `Transcript` — same components, same Tailwind, same
 * dispatcher the phone runs — over a fixture that deliberately contains every
 * case on story-1's manual test checklist, including the ones that are
 * awkward to produce on demand: a failed tool result, a 40 000-character
 * output, a diff with a line far wider than a phone, and a one-line edit
 * inside a 200-line file.
 *
 * `vite build`'s only input is index.html, so this file never reaches
 * pwa/dist or the shipped bundle.
 *
 * Each section is numbered to match the checklist printed by
 * docs/features/microviber-track-c/stories/story-1-check.sh.
 */
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Transcript } from './components/Transcript.js';
import type { TranscriptEvent } from './lib/types.js';
import './index.css';

const at = '2026-09-08T10:00:00.000Z';

const HUGE = Array.from({ length: 400 }, (_, i) => `  ✓ test case ${i} passed in ${i % 7}ms`).join('\n');
const WIDE = `const config = { port: 8730, host: '127.0.0.1', bucket: 'studio-staging-a137e.firebasestorage.app', retries: 3, timeoutMs: 30000, label: 'a deliberately very wide line so the diff has something to scroll horizontally inside its own box' };`;
const BIG_FILE = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');

const tool = (
  name: string,
  summary: string,
  input: Record<string, unknown>,
  truncated = false,
): TranscriptEvent => ({ kind: 'tool', at, id: `toolu_${name}`, name, summary, input, truncated });

const result = (text: string, ok = true, truncated = false): TranscriptEvent =>
  ({ kind: 'toolResult', at, toolUseId: 'toolu_x', ok, text, truncated });

/** 1 — prose beside its tool calls, several calls, paragraph breaks, thinking. */
const SECTION_1: TranscriptEvent[] = [
  { kind: 'user', at, text: 'the port is hardcoded somewhere, find it and make it configurable', injected: true },
  { kind: 'thinking', at, text: 'It is probably in config.ts. I should grep for the literal too, in case it appears in more than one place — the daemon and the installer script both mention a port.' },
  { kind: 'assistant', at, text: 'Let me look at the config first.\n\nI will grep for the literal as well, since the installer may hardcode it too.' },
  tool('Read', 'daemon/src/config.ts', { file_path: 'daemon/src/config.ts', offset: 120, limit: 40 }),
  result('export const PORT = 8730;\nexport const HOST = "127.0.0.1";'),
  tool('Grep', '8730', { pattern: '8730', glob: '**/*.ts' }),
  result('daemon/src/config.ts:14\nbin/microviberd:22'),
];

/** 2 — a failed result, and a very large one. No need to trigger either by hand. */
const SECTION_2: TranscriptEvent[] = [
  { kind: 'assistant', at, text: 'Running the suite to see where we stand.' },
  tool('Bash', 'npm test', { command: 'npm test', description: 'run the full test suite' }),
  result(HUGE, true, true),
  { kind: 'assistant', at, text: 'And now a command that fails, so the error treatment is visible:' },
  tool('Bash', 'npm run nope', { command: 'npm run nope', description: 'a script that does not exist' }),
  result('npm error Missing script: "nope"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run', false),
];

/** 3 — diffs: a small edit, a very wide line, a whole-file write. */
const SECTION_3: TranscriptEvent[] = [
  tool('Edit', 'daemon/src/config.ts', {
    file_path: 'daemon/src/config.ts',
    old_string: 'const a = 1;\nexport const PORT = 8730;\nconst b = 2;',
    new_string: 'const a = 1;\nexport const PORT = Number(process.env.PORT ?? 8730);\nconst b = 2;',
  }),
  tool('Edit', 'daemon/src/wide.ts', { file_path: 'daemon/src/wide.ts', old_string: WIDE, new_string: WIDE.replace('8730', '9000') }),
  tool('Write', 'daemon/src/new.ts', { file_path: 'daemon/src/new.ts', content: "export const HOST = '127.0.0.1';\nexport const PORT = 8730;\nexport const RETRIES = 3;" }),
];

/** 4 — a one-line change inside a 200-line file: must be a small hunk. */
const SECTION_4: TranscriptEvent[] = [
  tool('Edit', 'a-big-file.ts', { file_path: 'a-big-file.ts', old_string: BIG_FILE, new_string: BIG_FILE.replace('line 100', 'line 100 — the only change in a 200-line file') }),
];

/** 5 — MultiEdit and TodoWrite: non-string fields must stay visible. */
const SECTION_5: TranscriptEvent[] = [
  tool('MultiEdit', 'daemon/src/config.ts', {
    file_path: 'daemon/src/config.ts',
    edits: [
      { old_string: 'const a = 1;', new_string: 'const a = 2;' },
      { old_string: 'const b = 3;', new_string: 'const b = 4;' },
    ],
  }),
  tool('TodoWrite', '', { todos: [{ content: 'widen the union', status: 'completed' }, { content: 'render diffs', status: 'in_progress' }] }),
  tool('Weird', '', {}),
];

/** 6 — AskUserQuestion, pending and resolved. Must be unchanged by story-1. */
const SECTION_6: TranscriptEvent[] = [
  {
    kind: 'askUserQuestion', at, toolUseId: 'toolu_ask1', resolved: true, resolvedBy: 'tool_result',
    selectedLabels: [['Yes, make it configurable']],
    questions: [{ question: 'Should the port be configurable?', header: 'Port', multiSelect: false, options: [{ label: 'Yes, make it configurable', description: 'Read process.env.PORT with a default' }, { label: 'No, leave it hardcoded', description: 'Simpler, but not deployable' }] }],
  },
  { kind: 'assistant', at, text: 'Making it configurable then.' },
  {
    kind: 'askUserQuestion', at, toolUseId: 'toolu_ask2', resolved: false,
    questions: [{ question: 'Ship this to main?', header: 'Ship', multiSelect: false, options: [{ label: 'Ship it', description: 'Squash-merge once CI is green' }, { label: 'Hold', description: 'Wait for another review' }] }],
  },
];

/** 7 — a long transcript, for scrolling. */
const SECTION_7: TranscriptEvent[] = Array.from({ length: 60 }, (_, i): TranscriptEvent[] => [
  { kind: 'assistant', at, text: `Step ${i + 1}: checking another file.` },
  tool('Read', `src/file-${i}.ts`, { file_path: `src/file-${i}.ts` }),
  result(`export const value${i} = ${i};`),
]).flat();

const SECTIONS: { n: number; title: string; look: string; events: TranscriptEvent[]; tall?: boolean }[] = [
  { n: 1, title: 'Prose, several tool calls, thinking', look: 'The explanation sits ABOVE the tool lines. Both Read and Grep are listed. The answer keeps its blank line between paragraphs. "thinking…" is a small marker — tap it.', events: SECTION_1 },
  { n: 2, title: 'Tool results, including a failure', look: 'No empty grey boxes. Each result is a readable one-line preview — tap to expand, tap to collapse. The npm error one is tinted red.', events: SECTION_2 },
  { n: 3, title: 'Diffs', look: 'Tap each. Removed lines red with "-", added green with "+", context muted. On the wide one, the diff scrolls sideways INSIDE its box — the page itself must not.', events: SECTION_3 },
  { n: 4, title: 'One-line edit in a 200-line file', look: 'Tap it. A small hunk — about 3 lines of context either side, not 200 lines.', events: SECTION_4 },
  { n: 5, title: 'MultiEdit, TodoWrite, no input', look: 'Tap each. The edits array and the todos list are still visible as values. The last one says "no input" rather than showing an empty box.', events: SECTION_5 },
  { n: 6, title: 'AskUserQuestion — unchanged by this story', look: 'Both cards render as before. The answered one highlights "Yes, make it configurable". No blank or stray row beside either.', events: SECTION_6 },
  { n: 7, title: 'A long transcript', look: 'Scroll it. Nothing renders blank, nothing throws, it stays responsive.', events: SECTION_7, tall: true },
];

function Section({ n, title, look, events, tall }: { n: number; title: string; look: string; events: TranscriptEvent[]; tall?: boolean }): ReactElement {
  return (
    <section className="border-t border-zinc-800">
      <header className="bg-zinc-900 px-4 py-3">
        <h2 className="text-[15px] font-bold text-amber-400">{n}. {title}</h2>
        <p className="mt-1 text-[13.5px] leading-snug text-zinc-400">{look}</p>
      </header>
      <div className={`flex flex-col ${tall ? 'h-[70vh]' : 'max-h-[85vh]'}`}>
        <Transcript events={events} sessionId={`preview-${n}`} sessionCwd="/Users/you/project" canAnswer={false} answerInFlight={null} />
      </div>
    </section>
  );
}

export function Preview(): ReactElement {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="bg-amber-500/10 border-b border-amber-700/60 px-4 py-3">
        <h1 className="text-[16px] font-bold text-amber-300">story-1 transcript preview</h1>
        <p className="mt-1 text-[13.5px] leading-snug text-zinc-300">
          The real transcript components, over a fixture holding every case on the checklist.
          No daemon, no pairing, no live session. Work down the 7 sections.
        </p>
      </div>
      {SECTIONS.map((s) => <Section key={s.n} {...s} />)}
      <footer className="border-t border-zinc-800 px-4 py-6 text-[13px] text-zinc-500">
        That is the whole checklist. Anything look wrong? Tell Claude which section number.
      </footer>
    </main>
  );
}

export const PREVIEW_SECTIONS = SECTIONS;

// Guarded so this module can be imported by a test (which has no #root) as
// well as by preview.html. `pwa/test/preview.test.tsx` renders <Preview /> and
// asserts every section mounts — the harness itself is checked, rather than
// assumed to work because the dev server returned a 200.
const mount = document.getElementById('root');
if (mount) createRoot(mount).render(<StrictMode><Preview /></StrictMode>);
