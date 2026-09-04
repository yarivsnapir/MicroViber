import { describe, it, expect } from 'vitest';
import { PromptLifecycle } from '../src/domain/prompt-lifecycle.js';
import type { PromptSender } from '../src/lib/claude-adapter/prompt-sender.js';

const okSender: PromptSender = { mode: 'owned', send: async () => ({ ok: true }) };
const failSender: PromptSender = { mode: 'owned', send: async () => ({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', message: 'refused', retryable: true }) };
const t0 = Date.parse('2026-08-23T12:00:00Z');

describe('PromptLifecycle', () => {
  it('write ok => queued, NOT accepted (accepted requires transcript observation)', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: okSender, nowMs: t0 });
    expect(r.state).toBe('queued');
  });

  it('observation of the matching user turn => accepted', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: okSender, nowMs: t0 });
    lc.observe({ sessionId: 's', text: 'hi', atISO: '2026-08-23T12:00:01Z' });
    expect(lc.get('k1')?.state).toBe('accepted');
  });

  it('write failure => failed', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: failSender, nowMs: t0 });
    expect(r.state).toBe('failed');
  });

  it('queued > 10 min with no observation => expired on sweep', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: okSender, nowMs: t0 });
    lc.sweepExpired(t0 + 10 * 60_000 + 1);
    expect(lc.get('k1')?.state).toBe('expired');
  });

  it('idempotent replay with same body => returns the original record, no second send', async () => {
    let sends = 0;
    const counting: PromptSender = { mode: 'owned', send: async () => { sends++; return { ok: true }; } };
    const lc = new PromptLifecycle();
    const a = await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: counting, nowMs: t0 });
    const b = await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: counting, nowMs: t0 + 5 });
    expect(sends).toBe(1);
    expect(b).toEqual(a);
  });

  it('same key with a different body => INVALID_INPUT', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'hi', sender: okSender, nowMs: t0 });
    await expect(lc.submit({ key: 'k1', sessionId: 's', text: 'DIFFERENT', sender: okSender, nowMs: t0 + 5 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('PromptLifecycle answer records (spec §5.2 step 2 / §5.4)', () => {
  const body = JSON.stringify({ toolUseId: 'toolu_1', selections: [['Yes']] });

  it('submit() stores answerBody atomically with the record', async () => {
    const lc = new PromptLifecycle();
    const r = await lc.submit({ key: 'k1', sessionId: 's', text: 'Answering your question:\n- Confirm: Yes', sender: okSender, nowMs: t0, answerBody: body });
    expect(r.answerBody).toBe(body);
    expect(r.state).toBe('queued');
  });

  it('findReplay() returns the record for the same key + same answerBody without any text (a status poll needs no recomposition)', async () => {
    const lc = new PromptLifecycle();
    const a = await lc.submit({ key: 'k1', sessionId: 's', text: 'Answering your question:\n- Confirm: Yes', sender: okSender, nowMs: t0, answerBody: body });
    expect(lc.findReplay({ key: 'k1', sessionId: 's', answerBody: body })).toBe(a);
  });

  it('findReplay() returns undefined for an unknown key', () => {
    expect(new PromptLifecycle().findReplay({ key: 'nope', sessionId: 's', text: 'hi' })).toBeUndefined();
  });

  it('findReplay() rejects a different answerBody under the same key', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'x', sender: okSender, nowMs: t0, answerBody: body });
    expect(() => lc.findReplay({ key: 'k1', sessionId: 's', answerBody: JSON.stringify({ toolUseId: 'toolu_1', selections: [['No']] }) })).toThrowError(/Idempotency-Key/);
  });

  it('kind mismatch is rejected both ways: text replay of an answer key, answer replay of a text key', async () => {
    const lc = new PromptLifecycle();
    await lc.submit({ key: 'k1', sessionId: 's', text: 'x', sender: okSender, nowMs: t0, answerBody: body });
    expect(() => lc.findReplay({ key: 'k1', sessionId: 's', text: 'x' })).toThrowError(/Idempotency-Key/);
    await lc.submit({ key: 'k2', sessionId: 's', text: 'hello', sender: okSender, nowMs: t0 });
    expect(() => lc.findReplay({ key: 'k2', sessionId: 's', answerBody: body })).toThrowError(/Idempotency-Key/);
  });

  it('a text replay still returns the original record by key + text (unchanged behaviour)', async () => {
    const lc = new PromptLifecycle();
    const a = await lc.submit({ key: 'k2', sessionId: 's', text: 'hello', sender: okSender, nowMs: t0 });
    expect(lc.findReplay({ key: 'k2', sessionId: 's', text: 'hello' })).toBe(a);
  });
});
