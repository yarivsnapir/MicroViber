/**
 * Host classification and protocol-support predicate.
 *
 * Phase 0 (I4): the session JSON's `entrypoint` field is the cleanest host
 * discriminator ('claude-vscode' vs 'cli'), with `peerFeatures` as corroboration
 * for anything unrecognised. The version gate keys on `peerProtocol`, observed
 * stable at 1 across Claude Code 2.1.216–2.1.237; `version` is diagnostics only.
 */
export type Host = 'vscode' | 'terminal';

/** The one peerProtocol the adapter understands. Bump only with a re-verified adapter. */
export const SUPPORTED_PEER_PROTOCOL = 1 as const;

export function classifyHost(s: { entrypoint: string; peerFeatures?: readonly string[] | undefined }): Host {
  if (s.entrypoint === 'claude-vscode') return 'vscode';
  if (s.entrypoint === 'cli') return 'terminal';
  // Unknown entrypoint (future launch path): corroborate with the VS Code-only feature.
  return (s.peerFeatures ?? []).includes('notify_idle') ? 'vscode' : 'terminal';
}

export function isSupportedProtocol(peerProtocol: number): boolean {
  return peerProtocol === SUPPORTED_PEER_PROTOCOL;
}
