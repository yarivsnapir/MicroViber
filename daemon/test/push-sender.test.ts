import { describe, it, expect, vi } from 'vitest';
import webpush from 'web-push';
import { createPushSender, topicFor, NOTIFY_TTL_S, DISMISS_TTL_S, VAPID_SUBJECT, type SendFn } from '../src/lib/push-sender.js';

const vapid = { publicKey: 'BPUBLIC', privateKey: 'PRIVATE' };
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' } };
const notify = { type: 'notify' as const, tag: 'session:s1', title: 'Fix the tests', body: 'Waiting for you · studio', sessionId: 's1' };
const dismiss = { type: 'dismiss' as const, tag: 'session:s1' };

describe('topicFor (RFC 8030 §5.4 — a later push with the same Topic replaces an undelivered earlier one)', () => {
  it('is exactly 32 URL-safe chars, deterministic, and never the raw tag', () => {
    const t = topicFor('session:0b8e1c3a-7d2f-4e9b-9a1c-2f3e4d5c6b7a');
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicFor('session:x')).toBe(topicFor('session:x'));
    expect(t).not.toContain('session');
  });

  it('differs per session', () => {
    expect(topicFor('session:a')).not.toBe(topicFor('session:b'));
  });
});

describe('createPushSender', () => {
  it('sendNotify: the JSON sw.js expects, high urgency, notify TTL, per-tag Topic, VAPID details', async () => {
    const send = vi.fn<SendFn>(async () => ({}));
    const r = await createPushSender(vapid, { send }).sendNotify(sub, notify);
    expect(r).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    const [gotSub, payload, opts] = send.mock.calls[0]!;
    expect(gotSub).toBe(sub);
    expect(JSON.parse(payload)).toEqual(notify);
    expect(opts).toEqual({ vapidDetails: { subject: VAPID_SUBJECT, ...vapid }, TTL: NOTIFY_TTL_S, urgency: 'high', topic: topicFor('session:s1') });
  });

  it('sendDismiss: {type:"dismiss", tag}, normal urgency, dismiss TTL, and the SAME Topic as the notify it cancels', async () => {
    const send = vi.fn<SendFn>(async () => ({}));
    const r = await createPushSender(vapid, { send }).sendDismiss(sub, dismiss);
    expect(r).toBe('ok');
    const [, payload, opts] = send.mock.calls[0]!;
    expect(JSON.parse(payload)).toEqual(dismiss);
    expect(opts).toEqual({ vapidDetails: { subject: VAPID_SUBJECT, ...vapid }, TTL: DISMISS_TTL_S, urgency: 'normal', topic: topicFor('session:s1') });
  });

  it.each([404, 410])('a %i from the push service => "gone" (the caller prunes), never a throw', async (status) => {
    const send = vi.fn<SendFn>(async () => { throw new webpush.WebPushError('rejected', status, {}, 'push subscription has unsubscribed or expired', sub.endpoint); });
    await expect(createPushSender(vapid, { send }).sendNotify(sub, notify)).resolves.toBe('gone');
  });

  it('any other failure => "failed", logged, never thrown — a flaky push service must not kill the notify loop', async () => {
    const log = vi.fn();
    const send = vi.fn<SendFn>(async () => { throw new Error('ECONNRESET'); });
    await expect(createPushSender(vapid, { send, log }).sendNotify(sub, notify)).resolves.toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
  });

  it('a 5xx is "failed" too (transient — keep the subscription)', async () => {
    const send = vi.fn<SendFn>(async () => { throw new webpush.WebPushError('busy', 503, {}, '', sub.endpoint); });
    await expect(createPushSender(vapid, { send }).sendDismiss(sub, dismiss)).resolves.toBe('failed');
  });
});
