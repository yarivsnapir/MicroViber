import type { Config } from '../config.js';
import type { AppDeps } from '../api/app.js';
import { discoverSessions } from '../lib/claude-adapter/discovery.js';
import { nodeDiscoverySources, readTranscriptText } from '../lib/claude-adapter/node-sources.js';
import { parseChunk } from '../lib/claude-adapter/tail.js';
import { buildSummary, bySortOrder, type SessionSummary } from '../domain/registry.js';
import { PromptLifecycle } from '../domain/prompt-lifecycle.js';
import { startOwnedSession, type OwnedSessionHandle } from '../lib/claude-adapter/session-manager.js';
import { nodeSpawner } from '../lib/claude-adapter/node-spawner.js';
import type { PromptSender } from '../lib/claude-adapter/prompt-sender.js';
import { AuditLog } from './audit-log.js';
import { identity } from '../version.js';
import { SUPPORTED_PEER_PROTOCOL } from '../lib/claude-adapter/classify.js';

const TRANSCRIPT_MAX_EVENTS = 500;

/**
 * Wires the real adapter + domain into AppDeps. Owned sessions are tracked so
 * they render with mode:'owned' and route sends to their stdin; every other
 * discovered session is read-only and its sendPrompt fails honestly rather
 * than pretending. Real takeover (story microviber-2) will move ownership
 * into domain/ownership.ts's OwnershipRegistry and add /takeover, /handback
 * routes; this story only removes the dead attach stub.
 */
export function createServices(config: Config, auditSink: (line: string) => void): AppDeps {
  const owned = new Map<string, OwnedSessionHandle>();
  const cwdById = new Map<string, string>();
  const lifecycle = new PromptLifecycle();
  const audit = new AuditLog(auditSink);
  const sources = nodeDiscoverySources();

  const readonlySender: PromptSender = {
    mode: 'readonly',
    send: async () => ({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'session is read-only until taken over', retryable: false }),
  };

  function listSessions(): SessionSummary[] {
    const now = Date.now();
    const discovered = discoverSessions(sources);
    const out = discovered.map((d) => {
      cwdById.set(d.id, d.cwd);
      return buildSummary(d, { isOwned: owned.has(d.id), notifyIdleAt: null, alive: true, nowMs: now });
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
      // Bounded: never ship an unbounded transcript to the client (§16.6).
      const bounded = events.slice(-TRANSCRIPT_MAX_EVENTS);
      return { events: bounded, nextCursor: null };
    },
    async sendPrompt(a) {
      const sender = owned.get(a.sessionId) ?? readonlySender;
      const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.text, sender, nowMs: Date.now() });
      audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.text, outcome: rec.state, requestId: a.requestId, at: new Date().toISOString() });
      return rec;
    },
    async startOwned(a) {
      const handle = await startOwnedSession({ spawner: nodeSpawner, claudeBin: config.claudeBin, cwd: a.cwd, name: a.name });
      owned.set(handle.sessionId, handle);
      handle.onExit(() => { owned.delete(handle.sessionId); });
      return { id: handle.sessionId };
    },
    health: () => ({ ...identity(), supportedPeerProtocol: SUPPORTED_PEER_PROTOCOL }),
  };
}
