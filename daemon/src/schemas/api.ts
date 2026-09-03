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

export const SendPromptBody = z.object({
  text: z.string().min(1).max(20000),
  /** tool_use_id of the pending AskUserQuestion this text answers (spec §6) — absent for a plain-text prompt. */
  toolUseId: z.string().max(200).optional(),
});

export const WebpaneTokenBody = z.union([
  // Floor is 1024, not 1 — matches port-resolver.ts's validPort: no dev
  // server ever binds a privileged port, so a resolved port can never be
  // below 1024 in the first place (see port-resolver.ts's comment on why
  // that's a hard rule, not just a convention).
  z.object({ kind: z.literal('devserver'), port: z.number().int().min(1024).max(65535) }),
  z.object({ kind: z.literal('localfile'), path: z.string().min(1) }),
]);
