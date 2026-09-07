import webpush from 'web-push'; // default import ONLY: Node's CJS interop exposes no `sendNotification` named export
import type { PushSubscription, RequestOptions } from 'web-push';
import { createHash } from 'node:crypto';

/**
 * Thin Web Push sender (story push-notification-dispatch-1, AC2). Lives in
 * lib/ next to webpane/, NOT in lib/claude-adapter/ — it knows nothing about
 * Claude Code. This is the daemon's ONLY outbound network call (spec T19):
 * an https POST to the push service the phone's browser chose, carrying an
 * aes128gcm-encrypted payload the service cannot read. Never constructed
 * unless MV_VAPID_* are configured (index.ts), so a daemon without keys makes
 * no outbound calls at all.
 */
export type NotifyPayload = { type: 'notify'; tag: string; title: string; body: string; sessionId: string };
export type DismissPayload = { type: 'dismiss'; tag: string };
export type SendOutcome = 'ok' | 'gone' | 'failed';

export interface PushSender {
  sendNotify(sub: PushSubscription, payload: NotifyPayload): Promise<SendOutcome>;
  sendDismiss(sub: PushSubscription, payload: DismissPayload): Promise<SendOutcome>;
}

export type SendFn = (sub: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

/** VAPID `sub` claim (RFC 8292 §2.1): how a push-service operator reaches this app server's owner. A public repo URL is the honest contact for a single-user tool. */
export const VAPID_SUBJECT = 'https://github.com/yarivsnapir/MicroViber';
/** An idle session is still worth knowing about an hour later; staleness is handled by Topic replacement, not a short TTL. */
export const NOTIFY_TTL_S = 3600;
/** Must outlive the notify it cancels while the phone is offline. */
export const DISMISS_TTL_S = 3600;
/** web-push arms its socket-timeout handler ONLY when `options.timeout` is set, and https.request has no default inactivity timeout — without this a push service that accepts the POST and never answers leaves the send pending forever, stalling the notify loop. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * RFC 8030 §5.4 Topic: ≤32 URL-safe base64 chars. Pushes sharing a topic
 * REPLACE each other while undelivered, so a dismiss queued behind an
 * undelivered notify cancels it before the phone ever sees it — the
 * push-service-side twin of sw.js's tag-keyed replace-not-stack. Hashed
 * because a raw session tag is longer than 32 chars and need not travel.
 */
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

export function createPushSender(
  vapid: { publicKey: string; privateKey: string },
  deps: { send?: SendFn; log?: (msg: string) => void } = {},
): PushSender {
  const send: SendFn = deps.send ?? ((s, p, o) => webpush.sendNotification(s, p, o));
  const log = deps.log ?? (() => {});
  const vapidDetails = { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey };

  async function deliver(sub: PushSubscription, payload: NotifyPayload | DismissPayload, ttl: number, urgency: 'high' | 'normal'): Promise<SendOutcome> {
    try {
      await send(sub, JSON.stringify(payload), { vapidDetails, TTL: ttl, urgency, topic: topicFor(payload.tag), timeout: SEND_TIMEOUT_MS });
      return 'ok';
    } catch (e) {
      const status = e instanceof webpush.WebPushError ? e.statusCode : undefined;
      if (status === 404 || status === 410) return 'gone';
      log(`push: ${payload.type} to ${new URL(sub.endpoint).host} failed: ${status ?? (e instanceof Error ? e.message : String(e))}`);
      return 'failed';
    }
  }

  return {
    sendNotify: (sub, p) => deliver(sub, p, NOTIFY_TTL_S, 'high'),
    sendDismiss: (sub, p) => deliver(sub, p, DISMISS_TTL_S, 'normal'),
  };
}
