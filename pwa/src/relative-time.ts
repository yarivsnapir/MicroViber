/** Human "2m ago" / "5h ago" used in the session list secondary line. */
export function relativeTime(fromISO: string, nowMs: number): string {
  const then = Date.parse(fromISO);
  if (Number.isNaN(then)) return '?';
  const mins = Math.max(0, Math.round((nowMs - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
