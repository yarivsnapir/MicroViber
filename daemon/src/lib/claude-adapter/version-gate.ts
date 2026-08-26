import { isSupportedProtocol, SUPPORTED_PEER_PROTOCOL } from './classify.js';

/**
 * The version gate decides ONE thing: may we write to this session?
 * It NEVER sets session state — a session on an unrecognised Claude Code build
 * is still live and still mirroring, so it must not be labelled stale (spec §5.1).
 *
 * Fail closed (§16.5): an unknown peerProtocol degrades to read-only mirror,
 * never a speculative write against a protocol we no longer understand.
 */
export type Writability =
  | { writable: true }
  | { writable: false; reason: string };

export function gateWritability(peerProtocol: number): Writability {
  if (isSupportedProtocol(peerProtocol)) return { writable: true };
  return {
    writable: false,
    reason: `unsupported peerProtocol ${peerProtocol} (adapter understands ${SUPPORTED_PEER_PROTOCOL}) — read-only mirror`,
  };
}
