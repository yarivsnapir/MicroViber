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

/**
 * Web Push endpoint guard (spec T19, story push-notification-dispatch-1). The
 * daemon POSTs encrypted notifications to whatever `endpoint` a subscriber
 * hands it. Even behind bearer auth, that must never become a way to make the
 * daemon issue requests at loopback, the tailnet, or a LAN host — so only a
 * public https hostname is accepted. Browser push services are always public
 * multi-label https hosts (fcm.googleapis.com, web.push.apple.com,
 * updates.push.services.mozilla.com, *.notify.windows.com).
 */
export function isSafePushEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  // Port, not just hostname: all four real push services are 443-only, and
  // `new URL()` normalizes an explicit `:443` away (port === ''), so pinning it
  // costs nothing. This is the check that actually does the work the hostname
  // rules below only look like they do — `*.nip.io`, `*.sslip.io` and
  // `localtest.me` are ordinary PUBLIC multi-label names that resolve to
  // loopback / RFC-1918 addresses, and `web-push` forwards the endpoint's port
  // verbatim, so without this a bearer holder could aim the daemon's only
  // outbound call at the daemon itself (`https://mv.localtest.me:8730/…`) or at
  // any other LAN port. See T19(b) for what the hostname rules do and do not buy.
  if (u.port !== '' && u.port !== '443') return false;
  // Strip the root-anchoring trailing dot before any check: `URL` keeps it on
  // domain names, so `localhost.` / `printer.local.` / `nas.` would otherwise
  // slip past every comparison below (and the dot would even make a
  // single-label name look multi-label) while still resolving to the same host.
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  if (/^[\d.]+$/.test(host)) return false;               // IPv4 literal
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal (URL.hostname keeps the brackets)
  if (!host.includes('.')) return false;                 // single-label names are never public push services
  return true;
}

/** POST /api/push/subscribe — exactly what the browser's PushSubscription.toJSON() returns. */
export const PushSubscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048).refine(isSafePushEndpoint, 'endpoint must be a public https URL'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
}).strict();
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;
