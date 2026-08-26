/**
 * Pairing URL with the bearer token in the FRAGMENT. Browsers never send the
 * fragment to a server, so the token cannot leak into access logs or referers
 * (spec T8). The PWA reads it client-side and clears it from the URL.
 *
 * The port is omitted when it equals the scheme's default (443 for https, 80
 * for http) — the common case behind a reverse proxy (`tailscale serve`
 * terminates HTTPS on the public `*.ts.net` name at :443).
 */
export function buildPairingUrl(host: string, port: number, token: string, scheme: 'http' | 'https' = 'https'): string {
  const isDefaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  const portPart = isDefaultPort ? '' : `:${port}`;
  return `${scheme}://${host}${portPart}/#token=${encodeURIComponent(token)}`;
}

/**
 * Selects what the startup pairing URL should point at. When a public host
 * is configured (MV_ALLOWED_HOSTS' first entry — the daemon already requires
 * this to be set for the Host-allowlist check, T3), the daemon is assumed to
 * be reachable there over HTTPS via a reverse proxy (e.g. `tailscale serve`,
 * which terminates HTTPS on the `*.ts.net` name and forwards to the daemon's
 * local bind). Otherwise, fall back to the daemon's own local http origin —
 * unchanged pre-existing behavior for a bare local run.
 */
export function selectPairingTarget(
  config: { allowedHosts: string[]; bindAddress: string; port: number },
): { host: string; port: number; scheme: 'http' | 'https' } {
  const publicHost = config.allowedHosts[0];
  if (publicHost) {
    return { host: publicHost, port: 443, scheme: 'https' };
  }
  return { host: config.bindAddress, port: config.port, scheme: 'http' };
}
