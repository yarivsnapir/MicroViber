import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer auth, checked in-route on EVERY route including the WS upgrade (§16.3).
 * The token travels only in the Authorization header — never a query param or
 * body (T8). Constant-time comparison avoids a timing oracle.
 */
export function checkBearer(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader) return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const got = authHeader.slice(prefix.length);
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
