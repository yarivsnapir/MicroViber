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
export const ToolUseBlock = z.object({
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

// No control characters (newlines included) in transcript-sourced text that
// ends up echoed back into the session as a composed user turn — a label or
// header carrying a newline would let a poisoned AskUserQuestion (e.g. via
// prompt injection upstream) smuggle extra lines into what a user believes
// is a one-line "Yes" answer (security review finding, askuserquestion-
// answer-mechanism-1). Printable text plus ordinary whitespace only.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code <= 0x1f && code !== 0x09) || code === 0x7f) return true; // allow tab (0x09); no other C0 or DEL
  }
  return false;
}
const TrustedText = (max: number) => z.string().max(max).refine((s) => !hasControlChar(s), 'must not contain control characters');

export const AskUserQuestionInputSchema = z.object({
  questions: z.array(z.object({
    question: TrustedText(2000),
    header: TrustedText(200),
    options: z.array(z.object({ label: TrustedText(500), description: TrustedText(2000) })).max(50)
      // Two options sharing a label are indistinguishable once composed —
      // validateAnswer's exact-match check can't tell which the user meant,
      // and the composed text loses the distinction entirely.
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, 'option labels must be unique'),
    multiSelect: z.boolean().optional(),
  // Capped at 4 to match AnswerBody.selections' own .max(4) in schemas/api.ts
  // (review finding, askuserquestion-answer-mechanism-1) — a question with
  // more sub-questions than an answer can ever cover would be permanently
  // unanswerable rather than caught by validateAnswer's own error message.
  })).min(1).max(4),
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
    // .nullish() (not .optional()): a review spike's evidence for F18 was
    // captured via a projection (Python dict.get()) that renders an absent
    // key as literal `null`, leaving it ambiguous whether real transcripts
    // ever emit `"origin":null` / `"isMeta":null` outright. Tolerating null
    // costs nothing and prevents a stray null from failing this whole line's
    // parse (dropping it from every scan silently — the exact stuck
    // awaiting-input failure mode this feature exists to fix).
    origin: z.object({ kind: z.string().optional() }).passthrough().nullish(),
    // Claude Code stamps `isMeta: true` on the synthetic user turns it
    // injects itself — notably the "Continue from where you left off."
    // auto-continuation on resume (architecture-spec.md F17/F18). Human
    // turns leave it absent (or false). The basis of ask-user-question.ts's
    // rule (b): a meta turn never counts as a person answering.
    isMeta: z.boolean().nullish(),
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
export type UserTranscriptLine = Extract<TranscriptLine, { type: 'user' }>;
