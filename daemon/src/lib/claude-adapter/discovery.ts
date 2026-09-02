import { SessionJsonSchema, type SessionJson } from './schemas.js';
import { classifyHost, type Host } from './classify.js';
import { encodeProjectDir } from './encode-path.js';
import { scanTranscriptMeta } from './transcript-meta.js';

/**
 * A live session as facts only — no derived state (that's the domain layer,
 * Task 8) and CRUCIALLY no peerToken (T9: the token never leaves the adapter,
 * and never appears in any returned shape or log). This is an explicit
 * allowlist, not a passthrough of the raw session JSON.
 */
export interface DiscoveredSession {
  id: string;
  pid: number;
  cwd: string;
  folder: string;
  host: Host;
  title: string;
  peerProtocol: number;
  socketPath: string;
  lastPrompt: string | null;
  lastPromptAt: string | null;
  lastActivityAt: string | null;
  turnOpen: boolean;
  hasOutstandingBackgroundTask: boolean;
}

export interface DiscoveryDeps {
  /** Absolute paths of ~/.claude/sessions/*.json (excluding .key files). */
  listSessionFiles(): string[];
  readFile(path: string): string;
  isAlive(pid: number): boolean;
  /** Raw transcript .jsonl text for a session, or null if not found. */
  readTranscript(cwd: string, sessionId: string): string | null;
  /** mtime of a session file in ms — dedup keeps the most recently written one. */
  mtimeMs(path: string): number;
}

const TITLE_FALLBACK_MAX = 80;

export function discoverSessions(deps: DiscoveryDeps): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];

  // Claude Code writes one sessions/<pid>.json per PROCESS, and several live
  // processes can reference the same sessionId (a VSCode tab re-resuming a
  // session, a lingering pre-reload extension process, a takeover child).
  // Keep one file per sessionId — the newest-written one, i.e. the process
  // most recently attached — BEFORE the per-session transcript scan.
  const winners = new Map<string, { file: string; session: SessionJson; mtime: number }>();
  for (const file of deps.listSessionFiles()) {
    let json: unknown;
    try {
      json = JSON.parse(deps.readFile(file));
    } catch {
      continue;
    }
    const parsed = SessionJsonSchema.safeParse(json);
    if (!parsed.success) continue;
    const s = parsed.data;
    if (!deps.isAlive(s.pid)) continue;

    const mtime = deps.mtimeMs(file);
    const prev = winners.get(s.sessionId);
    if (!prev || mtime > prev.mtime) winners.set(s.sessionId, { file, session: s, mtime });
  }

  for (const { session: s } of winners.values()) {
    const transcript = deps.readTranscript(s.cwd, s.sessionId) ?? '';
    const meta = scanTranscriptMeta(transcript);
    const title =
      meta.title ??
      (meta.lastPrompt ? truncate(meta.lastPrompt, TITLE_FALLBACK_MAX) : '(untitled)');

    out.push({
      id: s.sessionId,
      pid: s.pid,
      cwd: s.cwd,
      folder: basename(s.cwd),
      host: classifyHost(s),
      title,
      peerProtocol: s.peerProtocol,
      socketPath: s.messagingSocketPath,
      // Capped well past display width (§16.6, same reasoning as the title
      // fallback) — the client truncates further for its own layout.
      lastPrompt: meta.lastPrompt ? truncate(meta.lastPrompt, 300) : null,
      lastPromptAt: meta.lastPromptAt,
      lastActivityAt: meta.lastActivityAt,
      turnOpen: meta.turnOpen,
      hasOutstandingBackgroundTask: meta.hasOutstandingBackgroundTask,
    });
  }
  return out;
}

/** Exposed so callers can locate a transcript with the correct encoding. */
export function transcriptRelPath(cwd: string, sessionId: string): string {
  return `${encodeProjectDir(cwd)}/${sessionId}.jsonl`;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
