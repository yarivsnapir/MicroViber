import { z } from 'zod';

/**
 * Canonical error envelope (§16.2) with MicroViber's two declared deltas
 * (spec §6): ADAPTER_UNSUPPORTED added, RATE_LIMITED dropped;
 * EXTERNAL_SERVICE_ERROR kept for peer-socket / owned-process failures.
 */
export const ErrorCode = z.enum([
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'EXTERNAL_SERVICE_ERROR',
  'ADAPTER_UNSUPPORTED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  EXTERNAL_SERVICE_ERROR: 502,
  ADAPTER_UNSUPPORTED: 503,
};

export function errorEnvelope(code: ErrorCode, message: string, details?: unknown) {
  return { success: false as const, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** An answer to the currently pending AskUserQuestion (spec askuserquestion-answer-mechanism §5.1). selections[i] = labels chosen for question i. */
export const AnswerBody = z.object({
  toolUseId: z.string().min(1).max(200),
  selections: z.array(z.array(z.string().min(1).max(500)).max(20)).min(1).max(4),
}).strict();
export type AnswerBody = z.infer<typeof AnswerBody>;

/** POST /api/sessions/:id/prompt — a plain user turn OR an answer; exactly one. */
export const SendPromptBody = z.union([
  z.object({ text: z.string().min(1).max(20000) }).strict(),
  z.object({ answer: AnswerBody }).strict(),
]);
export type SendPromptBody = z.infer<typeof SendPromptBody>;

export const WebpaneTokenBody = z.union([
  // Floor is 1024, not 1 — matches port-resolver.ts's validPort: no dev
  // server ever binds a privileged port, so a resolved port can never be
  // below 1024 in the first place (see port-resolver.ts's comment on why
  // that's a hard rule, not just a convention).
  z.object({ kind: z.literal('devserver'), port: z.number().int().min(1024).max(65535) }),
  z.object({ kind: z.literal('localfile'), path: z.string().min(1) }),
]);
