/**
 * Reverse-proxies to a resolved local dev-server port. The target host is
 * hardcoded to loopback — only the port varies, never a non-loopback host
 * (spec §7, proxy-steering row). The port-allowlist check lives in the route
 * handler (app.ts), not here — this function trusts its caller.
 */
export async function proxyToLoopback(
  port: number,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  const body = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers, body };
}
