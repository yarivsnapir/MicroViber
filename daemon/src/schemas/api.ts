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
});

export const WebpaneTokenBody = z.union([
  z.object({ kind: z.literal('devserver'), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal('localfile'), path: z.string().min(1) }),
]);
