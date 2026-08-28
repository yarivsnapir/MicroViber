import { randomBytes } from 'node:crypto';

export type WebpaneResource = { kind: 'devserver'; port: number } | { kind: 'localfile'; path: string };

const TOKEN_TTL_MS = 5 * 60_000; // 5 minutes — spec §7 "Iframe auth" Max-Age=300

export function resourceKey(r: WebpaneResource): string {
  return r.kind === 'devserver' ? `devserver:${r.port}` : `localfile:${r.path}`;
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * In-memory only (daemon restart clears it, same pattern as OwnershipRegistry).
 * Each token is bound to exactly one resource (a port, or a path) at mint
 * time; `check` validates both identity and TTL. This is the mechanism
 * behind the mv_webpane cookie's narrow scope (spec §7, cookie CSRF row).
 */
export class WebpaneTokenStore {
  private entries = new Map<string, { key: string; expiresAtMs: number }>();

  mint(resource: WebpaneResource, nowMs: number): string {
    const token = randomBytes(24).toString('base64url');
    this.entries.set(token, { key: resourceKey(resource), expiresAtMs: nowMs + TOKEN_TTL_MS });
    return token;
  }

  check(cookieValue: string | undefined, resource: WebpaneResource, nowMs: number): boolean {
    if (!cookieValue) return false;
    const entry = this.entries.get(cookieValue);
    if (!entry) return false;
    if (nowMs > entry.expiresAtMs) return false;
    return entry.key === resourceKey(resource);
  }
}
