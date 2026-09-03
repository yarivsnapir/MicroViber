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
  id: z.string(),
  name: z.string().max(128),
  input: z.unknown(),
});

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
});

export const AskUserQuestionInputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean().optional(),
  })),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>['questions'][number];

const Content = z.union([z.string(), z.array(z.union([TextBlock, ToolUseBlock, z.object({ type: z.string() }).passthrough()]))]);

export const TranscriptLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    message: z.object({ role: z.string(), content: Content }),
    timestamp: z.string().optional(),
    // Present on the tool_result line for an async Agent dispatch (isAsync
    // true means the result is a launch acknowledgement, not the agent's
    // actual output) and on the synthetic <task-notification> line Claude
    // Code injects when that agent later reports back (origin.kind) — the
    // basis of TranscriptMeta.hasOutstandingBackgroundTask.
    toolUseResult: z.object({ isAsync: z.boolean().optional() }).passthrough().optional(),
    origin: z.object({ kind: z.string().optional() }).passthrough().optional(),
  }),
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
