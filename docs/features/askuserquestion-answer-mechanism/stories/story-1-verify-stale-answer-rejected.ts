/**
 * Verification script for askuserquestion-answer-mechanism-1, second half of
 * the "backend-only story — verification script required" AC (story-1.md).
 * POSTs a stale/unknown toolUseId as an {answer} against a taken-over
 * session and confirms: 400 INVALID_INPUT "question is no longer pending",
 * and a retry under the SAME Idempotency-Key is re-evaluated (still 400)
 * rather than replaying a persisted record — proving no PromptRecord was
 * created for the rejection (story AC10/AC11).
 *
 * Prerequisite: the daemon is running and SESSION_ID names a session that
 * has been taken over (mode: 'owned'). It does NOT need a pending question —
 * a stale toolUseId is stale precisely because nothing matches it.
 *
 * Usage:
 *   MV_PORT=8730 MV_BEARER_TOKEN=<token> SESSION_ID=<id> \
 *     npx tsx docs/features/askuserquestion-answer-mechanism/stories/story-1-verify-stale-answer-rejected.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const port = process.env.MV_PORT ?? '8730';
const base = `http://127.0.0.1:${port}`;
const sessionId = process.env.SESSION_ID;

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
    console.error('Set SESSION_ID to a taken-over session id (see GET /api/sessions, mode: "owned").');
    process.exit(1);
  }
  const token = loadToken();
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const key = randomUUID();
  const body = { answer: { toolUseId: 'toolu_definitely_not_pending', selections: [['Yes']] } };

  console.log(`POST /api/sessions/${sessionId}/prompt`, JSON.stringify(body), `(Idempotency-Key: ${key})`);
  const first = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body),
  });
  const firstBody = await first.json();
  console.log(`→ HTTP ${first.status}`, JSON.stringify(firstBody));
  if (first.status !== 400 || firstBody.error?.code !== 'INVALID_INPUT') {
    console.error('❌ Expected 400 INVALID_INPUT for a stale toolUseId.');
    process.exit(1);
  }
  console.log('✅ Rejected as expected — check the daemon\'s audit log now for a "rejected" line with this canonical body\'s promptHash.');

  console.log(`\nRetrying under the SAME Idempotency-Key (${key}) — expecting it to be re-evaluated, not replayed as a persisted record...`);
  const second = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body),
  });
  const secondBody = await second.json();
  console.log(`→ HTTP ${second.status}`, JSON.stringify(secondBody));
  if (second.status !== 400 || secondBody.error?.code !== 'INVALID_INPUT') {
    console.error('❌ Expected the retry to also be 400 INVALID_INPUT (proves no PromptRecord was persisted for the rejection).');
    process.exit(1);
  }
  console.log('✅ Retry still 400 — confirms no PromptRecord was persisted for the rejected attempt.');
}

main();
