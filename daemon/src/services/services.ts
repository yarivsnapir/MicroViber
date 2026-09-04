import type { Config } from '../config.js';
import type { AppDeps } from '../api/app.js';
import { discoverSessions } from '../lib/claude-adapter/discovery.js';
import { nodeDiscoverySources, readTranscriptText } from '../lib/claude-adapter/node-sources.js';
import { parseChunk } from '../lib/claude-adapter/tail.js';
import { scanTranscriptMeta } from '../lib/claude-adapter/transcript-meta.js';
import { composeAnswerText, ANSWER_TEXT_MAX_CHARS, validateAnswer } from '../lib/claude-adapter/ask-user-question.js';
import { canonicalAnswerBody } from '../domain/answer.js';
import { buildSummary, bySortOrder, type SessionSummary } from '../domain/registry.js';
import { PromptLifecycle } from '../domain/prompt-lifecycle.js';
import { startTakeoverSession } from '../lib/claude-adapter/session-manager.js';
import { nodeSpawner } from '../lib/claude-adapter/node-spawner.js';
import { OwnershipRegistry, ForbiddenTakeoverError, takeover as domainTakeover } from '../domain/ownership.js';
import { AuditLog } from './audit-log.js';
import { identity } from '../version.js';
import { SUPPORTED_PEER_PROTOCOL } from '../lib/claude-adapter/classify.js';
import { loadDevportsConfig, type DevportsConfig } from '../lib/webpane/devports-config.js';
import { resolveDevServerPorts, type ResolvedDevServer } from '../lib/webpane/port-resolver.js';
import { proxyToLoopback } from '../lib/webpane/proxy.js';
import { WebpaneTokenStore } from '../lib/webpane/webpane-auth.js';
import type { WebpaneResource } from '../lib/webpane/webpane-auth.js';
import { readLocalFile } from '../lib/webpane/local-file.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSCRIPT_MAX_EVENTS = 500;

/**
 * devServerPorts feeds the dev-server reverse-proxy allowlist — an entry whose
 * port happens to be one of the daemon's OWN ports (its control port, or the
 * webpane CONTENT port) must never enroll it, or that proxy could loop back
 * onto the daemon's own front end (review finding M8). Pure and exported so
 * this exclusion is unit-testable without standing up the full createServices
 * wiring (which touches the real filesystem via nodeDiscoverySources()).
 */
export function excludeSelfPort(resolved: ResolvedDevServer[], ...ownPorts: number[]): ResolvedDevServer[] {
  const blocked = new Set(ownPorts);
  return resolved.filter((r) => !blocked.has(r.port));
}

/**
 * Wires the real adapter + domain into AppDeps. Owned sessions are tracked in
 * domain/ownership.ts's OwnershipRegistry so they render with mode:'owned'
 * and route sends to their stdin; every other discovered session is
 * read-only and its sendPrompt fails honestly rather than pretending.
 */
export function createServices(config: Config, auditSink: (line: string) => void): AppDeps {
  const registry = new OwnershipRegistry();
  const webpaneTokens = new WebpaneTokenStore();
  const cwdById = new Map<string, string>();
  const lifecycle = new PromptLifecycle();
  const audit = new AuditLog(auditSink);
  const sources = nodeDiscoverySources();
  // Short-TTL memo for listResolvedDevServerPorts (review finding I4).
  let devPortsMemo: { value: number[]; atMs: number } | null = null;

  // Loaded once at service-creation time, not per listSessions() call (spec
  // §3) — devports.json is optional (Task 1: missing => {}, malformed =>
  // throws, fail closed).
  const here = dirname(fileURLToPath(import.meta.url));
  const devportsPath = join(here, '..', '..', '..', 'devports.json'); // microviber/ repo root
  let devports: DevportsConfig;
  try {
    devports = loadDevportsConfig(devportsPath);
  } catch (e) {
    // Re-thrown so the error names its actual source file — main()'s
    // top-level handler (index.ts) otherwise mislabels any ZodError as a
    // .env problem, and a bare JSON.parse SyntaxError names no file at all.
    throw new Error(`invalid ${devportsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  function resolveDevServerPortsForSession(cwd: string): ResolvedDevServer[] {
    return excludeSelfPort(resolveDevServerPorts(cwd, devports), config.port, config.webpaneContentPort);
  }

  function listSessions(): SessionSummary[] {
    const now = Date.now();
    const discovered = discoverSessions(sources);
    const out = discovered.map((d) => {
      cwdById.set(d.id, d.cwd);
      return buildSummary(d, {
        isOwned: registry.isOwned(d.id),
        notifyIdleAt: null,
        alive: true,
        nowMs: now,
        devServerPorts: resolveDevServerPortsForSession(d.cwd),
      });
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
      const at = () => new Date().toISOString();
      // The audited "prompt" is the text for a plain prompt, and the
      // canonical body for an answer until it is composed (spec §5.2).
      const auditPrompt = 'text' in a.body ? a.body.text : canonicalAnswerBody(a.body.answer);
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
        audit.record({ sessionId: a.sessionId, mode: 'readonly', clientId: a.clientId, prompt: auditPrompt, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error('session is read-only until taken over'), { code: 'FORBIDDEN' });
      }

      if ('text' in a.body) {
        // §6 "audit every write attempt, not only successes": a same-key
        // reuse with different text throws from inside submit()'s own
        // findReplay() — caught here so the rejection still leaves a trace
        // (review finding, askuserquestion-answer-mechanism-1).
        try {
          const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text: a.body.text, sender, nowMs: Date.now() });
          audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.body.text, outcome: rec.state, requestId: a.requestId, at: at() });
          return rec;
        } catch (e) {
          audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: a.body.text, outcome: 'rejected', requestId: a.requestId, at: at() });
          throw e;
        }
      }

      // Answer path (spec §5.2 order): 2. same-key replay BEFORE any
      // transcript access — the PWA's status poll re-POSTs this exact body
      // after the pending question is already gone. Both outcomes of this
      // lookup — a real replay AND a same-key/different-body rejection —
      // are write-attempt audit events (§6) and must not return/throw silently.
      const answerBody = canonicalAnswerBody(a.body.answer);
      let replay;
      try {
        replay = lifecycle.findReplay({ key: a.key, sessionId: a.sessionId, answerBody });
      } catch (e) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw e;
      }
      if (replay) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: replay.state, requestId: a.requestId, at: at() });
        return replay;
      }

      // 3. New key: re-derive the pending question from the live transcript,
      // validate, compose, submit. Rejections persist no record but are audited.
      const cwd = cwdById.get(a.sessionId) ?? (listSessions(), cwdById.get(a.sessionId));
      const transcript = cwd ? readTranscriptText(cwd, a.sessionId) : null;
      const pending = transcript === null ? null : scanTranscriptMeta(transcript).pendingQuestion;
      const verdict = validateAnswer(pending, a.body.answer);
      if (!verdict.ok || !pending) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error(verdict.ok ? 'question is no longer pending' : verdict.message), { code: 'INVALID_INPUT' });
      }
      const text = composeAnswerText(pending.questions, a.body.answer.selections);
      if (text.length > ANSWER_TEXT_MAX_CHARS) {
        audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: answerBody, outcome: 'rejected', requestId: a.requestId, at: at() });
        throw Object.assign(new Error('answer too long'), { code: 'INVALID_INPUT' });
      }
      const rec = await lifecycle.submit({ key: a.key, sessionId: a.sessionId, text, sender, nowMs: Date.now(), answerBody });
      audit.record({ sessionId: a.sessionId, mode: sender.mode, clientId: a.clientId, prompt: text, outcome: rec.state, requestId: a.requestId, at: at() });
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
    mintWebpaneToken(resource: WebpaneResource) {
      return { cookieValue: webpaneTokens.mint(resource, Date.now()), maxAgeSeconds: 300 };
    },
    checkWebpaneCookie(cookieValue, resource) {
      return webpaneTokens.check(cookieValue, resource, Date.now());
    },
    resolveWebpaneCookie(cookieValue) {
      return webpaneTokens.resolve(cookieValue, Date.now());
    },
    listResolvedDevServerPorts() {
      // Short-TTL memo (review finding I4): this runs a full listSessions()
      // (synchronous session discovery + per-session multi-file scans) and is
      // now called on EVERY content-plane request and WS upgrade. A ~200ms
      // window is fine for an allowlist check — a port entering/leaving the
      // allowlist within 200ms of a request is a non-issue for a single user.
      const now = Date.now();
      if (devPortsMemo && now - devPortsMemo.atMs <= 200) return devPortsMemo.value;
      const value = [...new Set(listSessions().flatMap((s) => s.devServerPorts.map((r) => r.port)))];
      devPortsMemo = { value, atMs: now };
      return value;
    },
    proxyDevServer: proxyToLoopback,
    readLocalFile,
  };
}
