import type { SessionSummary } from '../domain/registry.js';
import { NotifyPolicy, type NotifyIntent } from '../domain/notify-policy.js';
import type { PushSender } from '../lib/push-sender.js';
import type { PushSubscriptionStore } from '../lib/push-subscription-store.js';

const STATE_PHRASE: Record<SessionSummary['state'], string> = {
  idle: 'Waiting for you',
  'awaiting-input': 'Needs your answer',
  working: 'Working',
  stale: 'Ended',
};
const STATUS_LINE_MAX = 100;

/**
 * The notification body (functional spec §4: "a short status line about what
 * the session was doing"): why it fired + where, then the last prompt. One
 * line — lock screens truncate anyway. NotifyPolicy stays unmodified; it just
 * receives this as `statusLine`.
 */
export function statusLineFor(s: Pick<SessionSummary, 'state' | 'folder' | 'lastPrompt'>): string {
  const head = `${STATE_PHRASE[s.state]} · ${s.folder}`;
  const prompt = (s.lastPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return head;
  const clipped = prompt.length > STATUS_LINE_MAX ? prompt.slice(0, STATUS_LINE_MAX - 1) + '…' : prompt;
  return `${head} — ${clipped}`;
}

export function toNotifyInput(sessions: readonly SessionSummary[]): { id: string; state: SessionSummary['state']; title: string; statusLine: string }[] {
  return sessions.map((s) => ({ id: s.id, state: s.state, title: s.title, statusLine: statusLineFor(s) }));
}

export interface DispatchDeps {
  store: Pick<PushSubscriptionStore, 'list' | 'remove'>;
  sender: PushSender;
  log?: (msg: string) => void;
}

/**
 * Fans each intent out to every stored subscription. A 'notify' goes out as a
 * notify push; a 'dismiss' goes out as a dismiss push (sw.js closes the tag —
 * AC7 as reconciled with AC4: a dismiss NEVER calls sendNotify). 'gone'
 * (404/410) prunes that one subscription — the browser unsubscribed or the
 * service expired it; retrying forever would only spam a dead endpoint.
 */
export async function dispatchIntents(intents: readonly NotifyIntent[], deps: DispatchDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  for (const intent of intents) {
    for (const sub of [...deps.store.list()]) { // defensive copy — the store already snapshots, but this keeps the fan-out independent of that
      const outcome = intent.type === 'notify'
        ? await deps.sender.sendNotify(sub, { type: 'notify', tag: intent.tag, title: intent.title, body: intent.body, sessionId: intent.sessionId })
        : await deps.sender.sendDismiss(sub, { type: 'dismiss', tag: intent.tag });
      if (outcome === 'gone') {
        deps.store.remove(sub.endpoint);
        log(`push: pruned expired subscription at ${new URL(sub.endpoint).host}`);
      }
    }
  }
}

export interface NotifyLoop {
  /** One reconcile-and-dispatch cycle. Exposed for tests and for a deliberate immediate run. */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * The daemon-side poll that turns session-state transitions into pushes (AC4).
 * The PWA's own 4s poll cannot do this — the whole point is the phone with
 * the PWA CLOSED. The first cycle only PRIMES the policy: every session is
 * "new" to a fresh NotifyPolicy, so without priming a daemon restart would
 * re-notify every currently-idle session (a launchd KeepAlive restart at 3am
 * must not buzz the phone about sessions the user already knew about).
 */
export function startNotifyLoop(opts: DispatchDeps & { listSessions(): SessionSummary[]; intervalMs: number; policy?: NotifyPolicy }): NotifyLoop {
  const policy = opts.policy ?? new NotifyPolicy();
  const log = opts.log ?? (() => {});
  let primed = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return; // a slow push service must not stack overlapping cycles
    inFlight = true;
    try {
      const intents = policy.reconcile(toNotifyInput(opts.listSessions()));
      if (!primed) { primed = true; return; }
      if (intents.length > 0) await dispatchIntents(intents, opts);
    } catch (e) {
      log(`push: notify cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, opts.intervalMs);
  if (typeof (timer as { unref?: unknown }).unref === 'function') (timer as { unref(): void }).unref(); // never the thing keeping the process alive
  return { tick, stop: () => clearInterval(timer) };
}
