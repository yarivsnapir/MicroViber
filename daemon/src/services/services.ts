import type { Config } from '../config.js';
import type { AppDeps } from '../api/app.js';
import { discoverSessions } from '../lib/claude-adapter/discovery.js';
import { nodeDiscoverySources, readTranscriptText } from '../lib/claude-adapter/node-sources.js';
import { parseChunk } from '../lib/claude-adapter/tail.js';
import { buildSummary, bySortOrder, type SessionSummary } from '../domain/registry.js';
import { PromptLifecycle } from '../domain/prompt-lifecycle.js';
import { startTakeoverSession } from '../lib/claude-adapter/session-manager.js';
import { nodeSpawner } from '../lib/claude-adapter/node-spawner.js';
import { OwnershipRegistry, ForbiddenTakeoverError, takeover as domainTakeover } from '../domain/ownership.js';
import { AuditLog } from './audit-log.js';
import { identity } from '../version.js';
import { SUPPORTED_PEER_PROTOCOL } from '../lib/claude-adapter/classify.js';

const TRANSCRIPT_MAX_EVENTS = 500;

/**
 * Wires the real adapter + domain into AppDeps. Owned sessions are tracked in
 * domain/ownership.ts's OwnershipRegistry so they render with mode:'owned'
 * and route sends to their stdin; every other discovered session is
 * read-only and its sendPrompt fails honestly rather than pretending.
 */
export function createServices(config: Config, auditSink: (line: string) => void): AppDeps {
  const registry = new OwnershipRegistry();
  const cwdById = new Map<string, string>();
  const lifecycle = new PromptLifecycle();
  const audit = new AuditLog(auditSink);
  const sources = nodeDiscoverySources();

  function listSessions(): SessionSummary[] {
    const now = Date.now();
    const discovered = discoverSessions(sources);
    const out = discovered.map((d) => {
      cwdById.set(d.id, d.cwd);
      return buildSummary(d, { isOwned: registry.isOwned(d.id), notifyIdleAt: null, alive: true, nowMs: now });
    });
    return out.sort(bySortOrder);
  }

  return {
    config,
    listSessions,
    getTranscript(id, _cursor) {
      const cwd = cwdById.get(id);
      if (!cwd) { listSessions(); } // populate the cwd map on a cold call
      const resolved = cwdById.get(id);
      if (!resolved) return null;
      const text = readTranscriptText(resolved, id);
      if (text === null) return null;
      const { events } = parseChunk(text.endsWith('\n') ? text : text + '\n');
      // A prompt only becomes 'accepted' once its own text is seen landing
      // back in the transcript (prompt-lifecycle.ts) — this poll loop is
      // that observation point; nothing else reads the transcript.
      for (const e of events) {
        if (e.kind === 'user') lifecycle.observe({ sessionId: id, text: e.text, atISO: e.at });
      }
      // Bounded: never ship an unbounded transcript to the client (§16.6).
      const bounded = events.slice(-TRANSCRIPT_MAX_EVENTS);
      return { events: bounded, nextCursor: null };
    },
    async sendPrompt(a) {
      // spec §3.2 hard rule: a session is write-eligible only while it holds
      // an owned handle. Reject BEFORE prompt-lifecycle.submit() ever runs so
      // a rejected prompt leaves no PromptRecord behind — a retry re-checks
      // ownership instead of idempotently replaying a stale queued/failed one.
      const sender = registry.get(a.sessionId);
      if (!sender) {
        // Still audited (mode:'readonly', outcome:'rejected') even though no
        // PromptRecord is created — a stolen-bearer-token holder probing
        // session ids for writability must leave a forensic trace (spec
        // §9.5), same hashed-prompt treatment as the owned-path entry below.
        audit.record({ sessionId: a.sessionId, mode: 'readonly', clientId: a.clientId, prompt: a.text, outcome: 'rejected', requestId: a.requestId, at: new Date().toISOString() });
        throw Object.assign(new Error('session is read-only until taken over'), { code: 'FORBIDDEN' });
      }
      const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.text, sender, nowMs: Date.now() });
      audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.text, outcome: rec.state, requestId: a.requestId, at: new Date().toISOString() });
      return rec;
    },
    async takeover(sessionId) {
      const list = listSessions(); // refresh discovery so state/cwd are current
      const summary = list.find((s) => s.id === sessionId);
      const cwd = cwdById.get(sessionId);
      if (!summary || !cwd) throw Object.assign(new Error('no such session'), { code: 'NOT_FOUND' });
      // Fail-closed for unrecognized/incompatible Claude Code builds (spec:
      // "Unknown version ⇒ degrade to read-only mirror... never a
      // speculative write") — the PWA hides the takeover button for these,
      // but that's client-side only; enforce it here too.
      if (!summary.writable) {
        throw Object.assign(new Error('cannot take over a session on an unrecognized Claude Code build'), { code: 'FORBIDDEN' });
      }
      try {
        const handle = await domainTakeover({
          sessionId,
          state: summary.state,
          registry,
          spawn: () => startTakeoverSession({ spawner: nodeSpawner, claudeBin: config.claudeBin, cwd, sessionId }),
        });
        return { id: handle.sessionId, mode: 'owned' as const };
      } catch (e) {
        // spec: "Rejected with FORBIDDEN if the session is not idle."
        if (e instanceof ForbiddenTakeoverError) throw Object.assign(e, { code: 'FORBIDDEN' });
        throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: 'EXTERNAL_SERVICE_ERROR' });
      }
    },
    async handback(sessionId) {
      // Idempotent: OwnershipRegistry.release() is already a no-op when the
      // session was never taken over, and kills+forgets the child otherwise
      // (domain/ownership.ts) — no orphan `claude --resume` process is left
      // behind.
      registry.release(sessionId);
      return { id: sessionId, mode: 'readonly' as const };
    },
    health: () => ({ ...identity(), supportedPeerProtocol: SUPPORTED_PEER_PROTOCOL }),
  };
}
