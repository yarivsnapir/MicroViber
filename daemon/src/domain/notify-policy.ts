type State = 'working' | 'idle' | 'stale' | 'awaiting-input';
interface SessionLite { id: string; state: State; title: string; statusLine?: string }

export type NotifyIntent =
  | { type: 'notify'; sessionId: string; tag: string; title: string; body: string }
  | { type: 'dismiss'; tag: string };

const tagOf = (id: string) => `session:${id}`;

function isWaitingForYou(s: State): boolean {
  return s === 'idle' || s === 'awaiting-input';
}

/**
 * Decides push notifications from session-state transitions.
 * - a session becoming "waiting for you" (idle OR awaiting-input) => notify
 *   (tagged per session so a later one replaces rather than stacks), carrying
 *   the harness status line (findings I3).
 * - a session leaving that "waiting for you" state, going away, or being
 *   opened => dismiss that tag (spec §8 / user A6: a notification overtaken
 *   by events must clear itself).
 * Trigger is isWaitingForYou (idle OR awaiting-input), so both "nothing to do"
 * and "blocked on a question" states notify — not idle alone.
 */
export class NotifyPolicy {
  private last = new Map<string, State>();

  reconcile(sessions: readonly SessionLite[]): NotifyIntent[] {
    const intents: NotifyIntent[] = [];
    const seen = new Set<string>();

    for (const s of sessions) {
      seen.add(s.id);
      const prev = this.last.get(s.id);
      const prevWaiting = prev !== undefined && isWaitingForYou(prev);
      const nowWaiting = isWaitingForYou(s.state);
      if (nowWaiting && !prevWaiting) {
        intents.push({ type: 'notify', sessionId: s.id, tag: tagOf(s.id), title: s.title, body: s.statusLine ?? '' });
      } else if (!nowWaiting && prevWaiting) {
        intents.push({ type: 'dismiss', tag: tagOf(s.id) });
      }
      this.last.set(s.id, s.state);
    }

    // Sessions that were waiting and have now disappeared: dismiss + forget.
    for (const [id, prev] of this.last) {
      if (!seen.has(id)) {
        if (isWaitingForYou(prev)) intents.push({ type: 'dismiss', tag: tagOf(id) });
        this.last.delete(id);
      }
    }
    return intents;
  }

  onOpened(sessionId: string): NotifyIntent {
    return { type: 'dismiss', tag: tagOf(sessionId) };
  }
}
