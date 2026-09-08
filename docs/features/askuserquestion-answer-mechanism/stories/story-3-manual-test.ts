/**
 * AC2 empirical probe for askuserquestion-answer-mechanism-3.
 *
 * The question AC2 asks: when the laptop itself answers an AskUserQuestion,
 * what does the resulting tool_result stub actually look like, and can
 * `isResolvingUserEntry` attribute it per question?
 *
 * This drives the SHIPPED adapter (detectAskUserQuestion +
 * isResolvingUserEntry) over real transcripts, so a PASS here is a statement
 * about the code that ships, not about a re-implementation.
 *
 * QUARANTINE: reading `~/.claude/*` and parsing transcript lines outside
 * `daemon/src/lib/claude-adapter/` is normally forbidden (architecture spec
 * §6, "Adapter quarantine"). This file is that rule's one written carve-out —
 * a non-shipped `docs/` diagnostic, read-only, imported by no runtime module.
 * Read the carve-out there before copying this pattern into a new probe.
 *
 * WHAT IT PRINTS
 *  - counts for BOTH shapes of call — 1-question and 2+-question. AC2 is about
 *    the per-question split, which only 2+ can exercise, but "did the
 *    tool_result label path work at ANY question count" is the prior question
 *    and a 1-question-only failure reads very differently from a total one;
 *  - one `✓` line per stub that did split;
 *  - a table of the DISTINCT redacted SIGNATURES of the stubs that did not,
 *    most common first (`× 37`), capped at the 10 most common shapes. Fifty
 *    failures are fifty copies of a handful of formats; the shapes are the
 *    finding, the individual lines are noise.
 *
 * THE SIGNATURE is a stub with everything a conversation said taken out of it,
 * and everything about its FORMAT left in. In order: this call's own option
 * labels become `<L>`, its question headers `<H>`, its question texts `<Q>`,
 * and every remaining run of letters/digits collapses to a single `·` (one per
 * run, not per character). Punctuation, quotes, `=`, `:`, `,` and whitespace
 * survive untouched, newlines are escaped to `\n` so one stub stays on one
 * line, and the result is cut at 160 chars — the stub's TRUE length is
 * printed beside it rather than inferred from the truncated text. So a stub
 * reading
 *   Your questions have been answered: "Pick a mode"="Fast", "Confirm"="Yes"
 * prints as
 *   · · · · ·: "<Q>"="<L>", "<H>"="<L>"
 * — enough to read the wire format straight off, nothing of what was asked or
 * answered.
 *
 * Redacted by default. Pass --raw for literal option labels on the `✓` lines
 * and, under each failing signature, the literal headers and stub content
 * behind it — so a signature's reading can be confirmed rather than trusted.
 *
 * Usage, from the repo root — via the REPO'S OWN pinned `tsx`
 * (a root devDependency, so the lockfile fixes its version). Not `npx tsx`:
 * that resolves an undeclared executable from the network at whatever version
 * is current, which §6's "opt-in, enumerated" network standard forbids.
 *   ./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts
 *   ./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts --raw
 *
 * Scan root: `~/.claude/projects` by default. Set MV_PROBE_ROOT to point the
 * walk somewhere else — a directory of hand-authored .jsonl fixtures, an
 * archived transcript export, or a single project's directory when you want
 * to keep the scan narrow. The walk is read-only either way, and a root that
 * does not exist yields 0 files and an INCONCLUSIVE verdict rather than a
 * throw.
 *
 *   MV_PROBE_ROOT=/path/to/fixtures \
 *     ./node_modules/.bin/tsx docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts
 *
 * The walk never follows a symlink and never reads a non-regular file, so the
 * scan cannot leave the root it was pointed at — see `transcripts` below.
 */
import { readdirSync, readFileSync, lstatSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectAskUserQuestion, isResolvingUserEntry, type DetectedQuestion } from '../../../../daemon/src/lib/claude-adapter/ask-user-question.js';
import { TranscriptLineSchema, ToolResultBlock, type UserTranscriptLine } from '../../../../daemon/src/lib/claude-adapter/schemas.js';

const RAW = process.argv.includes('--raw');
const ROOT = process.env.MV_PROBE_ROOT ?? join(homedir(), '.claude', 'projects');

const SIGNATURE_MAX_CHARS = 160;
const SHAPES_SHOWN = 10;
const RAW_EXAMPLES_PER_SHAPE = 3;

/**
 * Bounds what a `.jsonl` read may cost. A real transcript routinely exceeds
 * the 1 MiB cap `port-resolver.ts` puts on small text config files, so this
 * matches the other T13/T14 reader instead — `local-file.ts`'s
 * MAX_LOCAL_FILE_BYTES — which is generous enough for real content while
 * still refusing to buffer a multi-GB file (or /dev/zero) whole into memory.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * The precedent readers (T13) don't recurse at all — `port-resolver.ts` walks
 * one level and caps breadth at 25 children — so there is no depth cap to
 * copy. This is that bound's recursive analogue: generous next to the real
 * `~/.claude/projects/<slug>/<uuid>.jsonl` layout (depth 2), while refusing to
 * descend a pathologically deep tree forever. Breadth is deliberately NOT
 * capped the way port-resolver's is: there, an uncapped sweep would slow a
 * routine `GET /api/sessions`; here, scanning every transcript under the root
 * IS the diagnostic, and truncating it would silently corrupt the counts.
 */
const MAX_WALK_DEPTH = 8;

/**
 * Read-only, and bounded to the root it was given: T13/T14 reader discipline,
 * matching `port-resolver.ts`'s `defaultListChildDirs`/`defaultReadFileIfExists`.
 *
 * Symlinks are EXCLUDED rather than followed. `statSync` follows them, so the
 * previous version of this walk would descend a symlinked child and read files
 * outside its own root — verified: a root containing nothing but a symlink to a
 * sibling directory reported `Scanned 1 transcript file(s)`, and `--raw` would
 * then print stub content from there. The §6 carve-out is granted on this
 * diagnostic's reads staying read-only *and inside the root it names*, which is
 * only true if the walk cannot be redirected out of it. `isDirectory`/`isFile`/
 * `isSymbolicLink` here read the Dirent flags from the `withFileTypes` readdir,
 * so the filter costs no extra syscall.
 *
 * (A symlink CYCLE was never the unbounded recursion it looks like — the kernel's
 * SYMLOOP_MAX makes the 33rd `stat` fail ELOOP, so the old walk stopped at depth
 * 32 rather than exhausting the stack. Excluding symlinks ends it at depth 0.)
 */
function transcripts(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > MAX_WALK_DEPTH) return out;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow a link out of the root
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...transcripts(p, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Stats before reading and never throws, exactly like the sibling readers.
 * `lstatSync`, not `statSync`, so an entry swapped for a symlink between the
 * readdir above and this read is still refused rather than followed; `isFile()`
 * rejects FIFOs (a `readFileSync` on one blocks forever with no timeout),
 * directories, device nodes and sockets; and the size cap keeps a huge file
 * from being read unbounded into memory.
 */
function readTranscript(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return null;
    if (st.size > MAX_TRANSCRIPT_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null; // ENOENT / EACCES / race — best-effort, treat as unreadable
  }
}

/**
 * One span of the stub under redaction: `mark` pieces are already-substituted
 * placeholders and are never looked at again, `text` pieces are still literal
 * conversation content. Substituting into a piece LIST rather than into a
 * string is what keeps the final `·` mask from eating the `L`/`H`/`Q` out of
 * the placeholders it just wrote — no escaping, no sentinel characters, and a
 * stub that literally contains "<L>" cannot be mistaken for one.
 */
interface Piece { mark: boolean; text: string }

/** Distinct, non-empty, longest first — so a term that contains another is substituted whole. */
function longestFirst(terms: string[]): string[] {
  return [...new Set(terms)].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
}

function substitute(pieces: Piece[], needle: string, placeholder: string): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.mark) { out.push(piece); continue; }
    for (const [i, part] of piece.text.split(needle).entries()) {
      if (i > 0) out.push({ mark: true, text: placeholder });
      if (part.length > 0) out.push({ mark: false, text: part });
    }
  }
  return out;
}

/**
 * Unicode-aware on purpose: `\w` would leave Hebrew, accented Latin and every
 * other non-ASCII script standing in what is supposed to be a redacted line.
 * One `·` per RUN, so the mask says "a word was here", not how long it was.
 */
function maskWords(s: string): string {
  return s.replace(/[\p{L}\p{N}\p{M}_]+/gu, '·');
}

function escapeLineBreaks(s: string): string {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** The structural signature of one stub against the call it answers (see the header comment). */
function signatureOf(detected: DetectedQuestion, stub: string): string {
  let pieces: Piece[] = [{ mark: false, text: stub }];
  for (const label of longestFirst(detected.questions.flatMap((q) => q.options.map((o) => o.label)))) {
    pieces = substitute(pieces, label, '<L>');
  }
  for (const header of longestFirst(detected.questions.map((q) => q.header))) {
    pieces = substitute(pieces, header, '<H>');
  }
  for (const question of longestFirst(detected.questions.map((q) => q.question))) {
    pieces = substitute(pieces, question, '<Q>');
  }
  const masked = escapeLineBreaks(pieces.map((p) => (p.mark ? p.text : maskWords(p.text))).join(''));
  return masked.length > SIGNATURE_MAX_CHARS ? `${masked.slice(0, SIGNATURE_MAX_CHARS)}…` : masked;
}

/**
 * The literal tool_result the adapter just declined to split. `isResolvingUserEntry`
 * reports the verdict, not the evidence, so the probe re-reads the block —
 * through the adapter's own exported `ToolResultBlock`, not a hand-rolled
 * shape, which is the condition the §6 carve-out is granted on.
 */
function stubContent(entry: UserTranscriptLine, toolUseId: string): string | null {
  const content = entry.message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const r = ToolResultBlock.safeParse(block);
    if (r.success && r.data.tool_use_id === toolUseId) return typeof r.data.content === 'string' ? r.data.content : null;
  }
  return null;
}

interface Shape {
  signature: string;
  count: number;
  questionCounts: Set<number>;
  minLength: number; maxLength: number;
  examples: { headers: string; stub: string }[];
}

const shapes = new Map<string, Shape>();

function recordFailure(detected: DetectedQuestion, stub: string | null): void {
  const signature = stub === null ? '(tool_result content was not a string)' : signatureOf(detected, stub);
  const length = stub?.length ?? 0;
  const existing = shapes.get(signature);
  if (existing === undefined) {
    shapes.set(signature, {
      signature, count: 1, questionCounts: new Set([detected.questions.length]),
      minLength: length, maxLength: length,
      examples: [{ headers: detected.questions.map((q) => q.header).join(' | '), stub: stub ?? '' }],
    });
    return;
  }
  existing.count += 1;
  existing.questionCounts.add(detected.questions.length);
  existing.minLength = Math.min(existing.minLength, length);
  existing.maxLength = Math.max(existing.maxLength, length);
  if (existing.examples.length < RAW_EXAMPLES_PER_SHAPE) {
    existing.examples.push({ headers: detected.questions.map((q) => q.header).join(' | '), stub: stub ?? '' });
  }
}

function span(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

function plural(n: number): string {
  return n === 1 ? '1 question' : `${n} questions`;
}

let files = 0, asks = 0;
let single = 0, singleStubs = 0, singleParsed = 0;
let multi = 0, stubs = 0, parsed = 0;

for (const file of transcripts(ROOT)) {
  files += 1;
  const text = readTranscript(file);
  if (text === null) continue;
  const lines = text.split('\n');

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
    const isMulti = detected.questions.length >= 2;
    if (isMulti) multi += 1; else single += 1;

    for (const later of parsedLines.slice(i + 1)) {
      if (!later?.success || later.data.type !== 'user') continue;
      const r = isResolvingUserEntry(later.data, detected);
      if (!r || r.by !== 'tool_result') continue;
      if (isMulti) stubs += 1; else singleStubs += 1;
      if (r.selectedLabels === undefined) {
        recordFailure(detected, stubContent(later.data, detected.toolUseId));
      } else {
        if (isMulti) parsed += 1; else singleParsed += 1;
        console.log(`  ✓ ${plural(detected.questions.length)} → ${JSON.stringify(r.selectedLabels.map((ls) => RAW ? ls : ls.length))}`);
      }
      break;
    }
  }
}

console.log(`\nScanned ${files} transcript file(s) under ${ROOT}`);
console.log(`  AskUserQuestion calls found:            ${asks}`);
console.log(`  ...with 1 question:                     ${single}`);
console.log(`     ...answered by a tool_result stub:   ${singleStubs}`);
console.log(`     ...whose stub matched a label run:   ${singleParsed}`);
console.log(`  ...with 2+ questions:                   ${multi}`);
console.log(`     ...answered by a tool_result stub:   ${stubs}`);
console.log(`     ...whose stub split per question:    ${parsed}`);

const ranked = [...shapes.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
if (ranked.length > 0) {
  const total = ranked.reduce((n, s) => n + s.count, 0);
  console.log(`\nUnsplittable stubs: ${total} in ${ranked.length} distinct shape(s), most common first.`);
  console.log(`  <L> one of this call's option labels | <H> a question header | <Q> a question text`);
  console.log(`  ·   one masked run of letters/digits | len the stub's true length`);
  for (const shape of ranked.slice(0, SHAPES_SHOWN)) {
    console.log(`\n  × ${shape.count}  q${[...shape.questionCounts].sort((a, b) => a - b).join(',')}  len ${span(shape.minLength, shape.maxLength)}`);
    console.log(`      ${shape.signature}`);
    if (!RAW) continue;
    for (const example of shape.examples) {
      console.log(`      raw headers: ${example.headers}`);
      console.log(`      raw stub:    ${escapeLineBreaks(example.stub)}`);
    }
    if (shape.count > shape.examples.length) console.log(`      (+${shape.count - shape.examples.length} more stub(s) in this shape)`);
  }
  if (ranked.length > SHAPES_SHOWN) console.log(`\n  (+${ranked.length - SHAPES_SHOWN} more distinct shape(s) not shown)`);
  if (!RAW) console.log(`\n  Re-run with --raw for the literal stub behind each shape.`);
}

if (stubs === 0) {
  console.log('\nINCONCLUSIVE — no multi-question call was ever answered by a tool_result stub in these transcripts.');
  console.log('That is itself the AC2 finding: the asymmetry is unobservable here, and the code says "can\'t tell" rather than guessing.');
} else if (parsed === stubs) {
  console.log('\nCONFIRMED — every real multi-question stub split per question.');
} else {
  console.log(`\nPARTIAL — ${stubs - parsed} real stub(s) could not be split. Read the shapes above, then record the format in spec §4.1.`);
}

if (singleStubs === 0) {
  console.log('Single-question path: no 1-question call was answered by a tool_result stub here — the label path is untested at any count.');
} else if (singleParsed === singleStubs) {
  console.log(`Single-question path: all ${singleStubs} stub(s) matched a label run — the label path does work where no boundary has to be guessed.`);
} else if (singleParsed === 0) {
  console.log(`Single-question path: 0 of ${singleStubs} stub(s) matched a label run — the stub is not a label run at ANY question count, so this is the format, not the split.`);
} else {
  console.log(`Single-question path: ${singleParsed} of ${singleStubs} stub(s) matched a label run.`);
}
