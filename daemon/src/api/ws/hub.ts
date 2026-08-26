export type Sink = (event: unknown) => void;

/**
 * Per-session pub/sub. Subscribing returns an unsubscribe fn that removes the
 * sink so a dropped socket leaks no listener (and no tailer, since the server
 * stops tailing a session with zero subscribers).
 */
export class Hub {
  private subs = new Map<string, Set<Sink>>();

  subscribe(sessionId: string, sink: Sink): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(sink);
    return () => {
      const s = this.subs.get(sessionId);
      if (!s) return;
      s.delete(sink);
      if (s.size === 0) this.subs.delete(sessionId);
    };
  }

  publish(sessionId: string, event: unknown): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const sink of set) sink(event);
  }

  subscriberCount(sessionId: string): number {
    return this.subs.get(sessionId)?.size ?? 0;
  }
}
