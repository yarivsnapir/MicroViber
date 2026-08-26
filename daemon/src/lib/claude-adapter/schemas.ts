import { z } from 'zod';

/**
 * Shape of ~/.claude/sessions/<pid>.json, validated at the adapter boundary
 * (§16.2). Unknown keys are stripped, not rejected — Claude Code adds fields
 * across versions and the gate (Task 4) keys on peerProtocol, not on shape.
 *
 * NOTE: this file is the ONLY place that models Claude Code internals (§16.1).
 */
export const SessionJsonSchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  version: z.string().min(1).max(64),
  peerProtocol: z.number().int(),
  peerFeatures: z.array(z.string().max(64)).max(64).optional(),
  kind: z.string().max(64).optional(),
  entrypoint: z.string().max(64),
  messagingSocketPath: z.string().min(1).max(4096),
  name: z.string().max(256).optional(),
});

export type SessionJson = z.infer<typeof SessionJsonSchema>;

/** One line of a transcript .jsonl. Only the entry kinds we render are modelled. */
const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  name: z.string().max(128),
  input: z.unknown(),
});
const Content = z.union([z.string(), z.array(z.union([TextBlock, ToolUseBlock, z.object({ type: z.string() }).passthrough()]))]);

export const TranscriptLineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), message: z.object({ role: z.string(), content: Content }), timestamp: z.string().optional() }),
  z.object({
    type: z.literal('assistant'),
    // stop_reason distinguishes a turn parked waiting for the user
    // ('end_turn') from one still mid-flight ('tool_use', etc.) — the basis
    // of TranscriptMeta.turnOpen.
    message: z.object({ role: z.string(), content: Content, stop_reason: z.string().nullable().optional() }),
    timestamp: z.string().optional(),
  }),
  z.object({ type: z.literal('ai-title'), aiTitle: z.string().max(500) }),
  z.object({ type: z.literal('custom-title'), customTitle: z.string().max(500) }),
  z.object({ type: z.literal('last-prompt'), lastPrompt: z.string().max(20000) }),
]);

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
