/**
 * Verification script for askuserquestion-answer-mechanism-1, AC "backend-only
 * story — verification script required" (story-1.md). Exercises the happy
 * path against a REAL running daemon: POST {answer} for a genuinely pending
 * AskUserQuestion on a taken-over session, then polls the same
 * Idempotency-Key until the PromptStatus reaches 'accepted', printing every
 * intermediate status.
 *
 * Prerequisites (all manual, per architecture-spec.md's design — this script
 * intentionally does not spawn or take over sessions itself):
 *   1. The daemon is running (`bin/microviberd start`, per INSTALL.md).
 *   2. A real laptop Claude Code session has called AskUserQuestion and is
 *      sitting on that pending question (visible via GET /api/sessions as
 *      state: 'awaiting-input').
 *   3. That session has been taken over from the PWA (or via
 *      POST /api/sessions/:id/takeover) so mode is 'owned'.
 *
 * Usage:
 *   MV_PORT=8730 MV_BEARER_TOKEN=<token> SESSION_ID=<id> LABEL=Yes \
 *     npx tsx docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-answer-accepted.ts
 *
 * MV_BEARER_TOKEN defaults to reading ~/.microviber/token (the daemon's own
 * persisted token, per INSTALL.md's MV_BEARER_TOKEN row) if not set.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const port = process.env.MV_PORT ?? '8730';
const base = `http://127.0.0.1:${port}`;
const sessionId = process.env.SESSION_ID;
const label = process.env.LABEL ?? 'Yes';

function loadToken(): string {
  if (process.env.MV_BEARER_TOKEN) return process.env.MV_BEARER_TOKEN;
  try {
    return readFileSync(join(homedir(), '.microviber', 'token'), 'utf8').trim();
  } catch {
    console.error('No MV_BEARER_TOKEN set and could not read ~/.microviber/token. Set MV_BEARER_TOKEN explicitly.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (!sessionId) {
    console.error('Set SESSION_ID to a session currently awaiting-input and taken over (see GET /api/sessions).');
    process.exit(1);
  }
  const token = loadToken();
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  console.log(`GET /api/sessions/${sessionId}/transcript — checking for a pending AskUserQuestion...`);
  const tRes = await fetch(`${base}/api/sessions/${sessionId}/transcript`, { headers });
  const tBody = await tRes.json();
  if (!tRes.ok || !tBody.success) {
    console.error('❌ Could not read transcript:', tBody);
    process.exit(1);
  }
  const pending = (tBody.data.events as Array<{ kind: string; toolUseId?: string; resolved?: boolean; questions?: unknown[] }>)
    .filter((e) => e.kind === 'askUserQuestion' && e.resolved === false)
    .at(-1);
  if (!pending?.toolUseId) {
    console.error('❌ No pending (unresolved) askUserQuestion event found in this session\'s transcript. Trigger one first.');
    process.exit(1);
  }
  console.log(`✅ Found pending question, toolUseId=${pending.toolUseId}`);

  const key = randomUUID();
  const body = { answer: { toolUseId: pending.toolUseId, selections: [[label]] } };
  console.log(`POST /api/sessions/${sessionId}/prompt`, JSON.stringify(body), `(Idempotency-Key: ${key})`);

  const post = async () => {
    const r = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    return { status: r.status, j };
  };

  let last = await post();
  console.log(`→ HTTP ${last.status}`, JSON.stringify(last.j));
  if (last.status !== 200) {
    console.error('❌ Initial POST was rejected — see message above.');
    process.exit(1);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = last.j.data?.state;
    console.log(`  PromptStatus.state = ${state}`);
    if (state === 'accepted') {
      console.log('✅ accepted — the composed answer text landed in the transcript as a plain user turn.');
      const tr = await fetch(`${base}/api/sessions/${sessionId}/transcript`, { headers });
      const trBody = await tr.json();
      const ask = (trBody.data.events as Array<{ kind: string; toolUseId?: string; resolved?: boolean; resolvedBy?: string; selectedLabels?: string[] }>)
        .find((e) => e.kind === 'askUserQuestion' && e.toolUseId === pending.toolUseId);
      console.log(`  askUserQuestion event: resolved=${ask?.resolved} resolvedBy=${ask?.resolvedBy} selectedLabels=${JSON.stringify(ask?.selectedLabels)}`);
      return;
    }
    if (state === 'failed' || state === 'expired') {
      console.error(`❌ Terminal non-accepted state: ${state}`);
      process.exit(1);
    }
    // Reviewer finding: 'accepted' is driven ONLY by a transcript read
    // (services.ts's getTranscript calls lifecycle.observe) — re-POSTing
    // alone never advances the record. Read the transcript before every
    // re-POST so the loop can actually reach 'accepted' standalone.
    await fetch(`${base}/api/sessions/${sessionId}/transcript`, { headers });
    await new Promise((res) => setTimeout(res, 1500));
    last = await post(); // same key → replay/refresh of the same PromptRecord
  }
  console.error('❌ Timed out waiting for accepted — the model may not have picked up the answer yet.');
  process.exit(1);
}

main();
