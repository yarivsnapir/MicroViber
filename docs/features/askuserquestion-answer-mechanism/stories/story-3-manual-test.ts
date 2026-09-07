/**
 * AC2 empirical probe for askuserquestion-answer-mechanism-3.
 *
 * The question AC2 asks: when the laptop itself answers a MULTI-question
 * AskUserQuestion, what does the resulting tool_result stub actually look
 * like, and can `isResolvingUserEntry` attribute it per question?
 *
 * This drives the SHIPPED adapter (detectAskUserQuestion +
 * isResolvingUserEntry) over real transcripts, so a PASS here is a statement
 * about the code that ships, not about a re-implementation.
 *
 * Redacted by default: option labels and stub content are replaced with
 * positional placeholders, so the output carries the SHAPE of the stub and
 * nothing a conversation said. Pass --raw to see the literal strings (useful
 * when a case does not parse and you need to see why).
 *
 * Usage, from the repo root:
 *   npx tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts
 *   npx tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts --raw
 *
 * Scan root: `~/.claude/projects` by default. Set MV_PROBE_ROOT to point the
 * walk somewhere else — a directory of hand-authored .jsonl fixtures, an
 * archived transcript export, or a single project's directory when you want
 * to keep the scan narrow. The walk is read-only either way, and a root that
 * does not exist yields 0 files and an INCONCLUSIVE verdict rather than a
 * throw.
 *
 *   MV_PROBE_ROOT=/path/to/fixtures \
 *     npx tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts
 */
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectAskUserQuestion, isResolvingUserEntry } from '../../../../daemon/src/lib/claude-adapter/ask-user-question.js';
import { TranscriptLineSchema } from '../../../../daemon/src/lib/claude-adapter/schemas.js';

const RAW = process.argv.includes('--raw');
const ROOT = process.env.MV_PROBE_ROOT ?? join(homedir(), '.claude', 'projects');

function transcripts(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let s: Stats;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) out.push(...transcripts(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

let files = 0, asks = 0, multi = 0, stubs = 0, parsed = 0;
const failures: string[] = [];

for (const file of transcripts(ROOT)) {
  files += 1;
  let lines: string[];
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }

  const parsedLines = lines.map((l) => {
    const t = l.trim();
    if (!t) return null;
    try { return TranscriptLineSchema.safeParse(JSON.parse(t)); } catch { return null; }
  });

  for (const [i, pl] of parsedLines.entries()) {
    if (!pl?.success || pl.data.type !== 'assistant') continue;
    const detected = detectAskUserQuestion(pl.data.message.content);
    if (!detected) continue;
    asks += 1;
    if (detected.questions.length < 2) continue;
    multi += 1;

    for (const later of parsedLines.slice(i + 1)) {
      if (!later?.success || later.data.type !== 'user') continue;
      const r = isResolvingUserEntry(later.data, detected);
      if (!r || r.by !== 'tool_result') continue;
      stubs += 1;
      const headers = detected.questions.map((q) => q.header).join(' | ');
      if (r.selectedLabels === undefined) {
        failures.push(`  ✗ ${detected.questions.length} questions [${RAW ? headers : 'redacted'}] — stub did NOT split per question`);
      } else {
        parsed += 1;
        console.log(`  ✓ ${detected.questions.length} questions → ${JSON.stringify(r.selectedLabels.map((ls) => RAW ? ls : ls.length))}`);
      }
      break;
    }
  }
}

console.log(`\nScanned ${files} transcript file(s) under ${ROOT}`);
console.log(`  AskUserQuestion calls found:            ${asks}`);
console.log(`  ...with 2+ questions:                   ${multi}`);
console.log(`  ...answered by a tool_result stub:      ${stubs}`);
console.log(`  ...whose stub split per question:       ${parsed}`);
for (const f of failures) console.log(f);

if (stubs === 0) {
  console.log('\nINCONCLUSIVE — no multi-question call was ever answered by a tool_result stub in these transcripts.');
  console.log('That is itself the AC2 finding: the asymmetry is unobservable here, and the code says "can\'t tell" rather than guessing.');
} else if (parsed === stubs) {
  console.log('\nCONFIRMED — every real multi-question stub split per question.');
} else {
  console.log(`\nPARTIAL — ${stubs - parsed} real stub(s) could not be split. Re-run with --raw and record the shape in spec §4.1.`);
}
