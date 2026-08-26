/**
 * T3 (DNS rebinding): a malicious page can resolve its own hostname to the
 * daemon's tailnet IP and issue requests from the victim's browser. The Host
 * header it sends is the attacker's domain, so validating Host against an
 * allowlist BEFORE auth closes the vector. Port is stripped before comparison.
 */
export function isHostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const host = stripPort(hostHeader).toLowerCase();
  return allowed.some((a) => a.toLowerCase() === host);
}

function stripPort(h: string): string {
  // IPv6 in brackets: [::1]:8730
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}
