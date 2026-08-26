/**
 * T4/T5: strict Origin allowlist, never '*'. A missing Origin (non-browser or
 * same-origin request) is allowed; a present Origin must be listed. Because
 * auth rides in a header (not a cookie), a cross-origin page cannot forge
 * credentialed requests anyway, but this is defence in depth and the ONLY
 * gate WebSockets get (CORS does not govern WS — enforce this on the upgrade).
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}
