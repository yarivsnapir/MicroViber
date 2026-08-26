import { SessionJsonSchema } from './schemas.js';
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
  lastPromptAt: string | null;
  lastActivityAt: string | null;
}

export interface DiscoveryDeps {
  /** Absolute paths of ~/.claude/sessions/*.json (excluding .key files). */
  listSessionFiles(): string[];
  readFile(path: string): string;
  isAlive(pid: number): boolean;
  /** Raw transcript .jsonl text for a session, or null if not found. */
  readTranscript(cwd: string, sessionId: string): string | null;
}

const TITLE_FALLBACK_MAX = 80;

export function discoverSessions(deps: DiscoveryDeps): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];

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
      lastPromptAt: meta.lastPromptAt,
      lastActivityAt: meta.lastActivityAt,
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
