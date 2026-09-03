import { gateWritability } from '../lib/claude-adapter/version-gate.js';
import { deriveState, type SessionState } from './session-state.js';
import type { Host } from '../lib/claude-adapter/classify.js';

export type SessionMode = 'readonly' | 'owned';

/** What the API and PWA see. Never includes socketPath, peerProtocol, or any token. */
export interface SessionSummary {
  id: string;
  title: string;
  folder: string;
  cwd: string;
  host: Host;
  writable: boolean;
  state: SessionState;
  lastActivityAt: string | null;
  lastPrompt: string | null;
  lastPromptAt: string | null;
  mode: SessionMode;
  /** True while this session holds an entry in the owned map (domain/ownership.ts). */
  takenOver: boolean;
  /**
   * A pending AskUserQuestion tool call awaiting the user's answer (spec
   * Feature 5 §6), or null. Drives `state: 'awaiting-input'` here and the
   * question-rendering UI in the PWA.
   */
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
  /**
   * Dev servers resolved for this session — cwd itself plus any immediate
   * child directory that independently resolves its own port (spec §3);
   * empty when none resolve. A session's cwd is often a multi-project
   * workspace root, so this is a list, not a single nullable port.
   */
  devServerPorts: { folder: string; port: number }[];
}

/** The adapter facts the registry needs (a DiscoveredSession, structurally). */
export interface DiscoveredLike {
  id: string;
  title: string;
  folder: string;
  cwd: string;
  host: Host;
  peerProtocol: number;
  socketPath: string;
  lastPrompt: string | null;
  lastPromptAt: string | null;
  lastActivityAt: string | null;
  turnOpen: boolean;
  hasOutstandingBackgroundTask: boolean;
  pendingQuestion: { toolUseId: string; questions: unknown[] } | null;
}

export function buildSummary(
  d: DiscoveredLike,
  ctx: {
    isOwned: boolean;
    notifyIdleAt: string | null;
    alive: boolean;
    nowMs: number;
    devServerPorts: { folder: string; port: number }[];
  },
): SessionSummary {
  return {
    id: d.id,
    title: d.title,
    folder: d.folder,
    cwd: d.cwd,
    host: d.host,
    writable: gateWritability(d.peerProtocol).writable,
    // hasOutstandingBackgroundTask and hasPendingQuestion are optional on
    // deriveState's input (so unit tests can omit whichever is irrelevant to
    // the case under test) — this is the one production call site, and both
    // must always be passed explicitly here; do not rely on the default.
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      turnOpen: d.turnOpen,
      hasOutstandingBackgroundTask: d.hasOutstandingBackgroundTask,
      hasPendingQuestion: d.pendingQuestion !== null,
      nowMs: ctx.nowMs,
    }),
    lastActivityAt: d.lastActivityAt,
    lastPrompt: d.lastPrompt,
    lastPromptAt: d.lastPromptAt,
    mode: ctx.isOwned ? 'owned' : 'readonly',
    takenOver: ctx.isOwned,
    devServerPorts: ctx.devServerPorts,
    pendingQuestion: d.pendingQuestion,
  };
}

/** Sort key: most-recently-prompted first (spec §3). */
export function bySortOrder(a: SessionSummary, b: SessionSummary): number {
  return (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '');
}
