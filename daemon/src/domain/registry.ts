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
  /** Resolved dev-server port for this folder, or null if none resolves (spec §3). */
  devServerPort: number | null;
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
}

export function buildSummary(
  d: DiscoveredLike,
  ctx: {
    isOwned: boolean;
    notifyIdleAt: string | null;
    alive: boolean;
    nowMs: number;
    // Optional: the 3 pre-existing tests in registry.test.ts construct ctx
    // without this field, so it can't be required here.
    devServerPort?: number | null;
  },
): SessionSummary {
  return {
    id: d.id,
    title: d.title,
    folder: d.folder,
    cwd: d.cwd,
    host: d.host,
    writable: gateWritability(d.peerProtocol).writable,
    state: deriveState({
      alive: ctx.alive,
      lastActivityAt: d.lastActivityAt,
      notifyIdleAt: ctx.notifyIdleAt,
      turnOpen: d.turnOpen,
      nowMs: ctx.nowMs,
    }),
    lastActivityAt: d.lastActivityAt,
    lastPrompt: d.lastPrompt,
    lastPromptAt: d.lastPromptAt,
    mode: ctx.isOwned ? 'owned' : 'readonly',
    takenOver: ctx.isOwned,
    devServerPort: ctx.devServerPort ?? null,
  };
}

/** Sort key: most-recently-prompted first (spec §3). */
export function bySortOrder(a: SessionSummary, b: SessionSummary): number {
  return (b.lastPromptAt ?? '').localeCompare(a.lastPromptAt ?? '');
}
