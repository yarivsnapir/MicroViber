import { z } from 'zod';
import { randomBytes } from 'node:crypto';

/**
 * All daemon config, zod-parsed once at startup (§16.8). Missing/invalid vars
 * crash the process immediately, not on first request. No scattered
 * process.env reads elsewhere; the bind address and claude bin are config,
 * not constants.
 */
const EnvSchema = z.object({
  MV_BIND_ADDRESS: z.string().min(1),
  MV_PORT: z.coerce.number().int().min(1).max(65535).default(8730),
  MV_BEARER_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
  MV_ALLOWED_HOSTS: z.string().optional(),
  MV_ALLOWED_ORIGINS: z.string().optional(),
  MV_VAPID_PUBLIC_KEY: z.string().optional(),
  MV_VAPID_PRIVATE_KEY: z.string().optional(),
  MV_CLAUDE_BIN: z.string().min(1).default('claude'),
  MV_WEBPANE_CONTENT_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
});

export interface Config {
  bindAddress: string;
  port: number;
  bearerToken: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  vapid: { publicKey: string; privateKey: string } | null;
  claudeBin: string;
  /**
   * External HTTPS port of the webpane CONTENT origin (spec T15, story
   * microviber-track-b-3): `tailscale serve` maps this second port to the
   * same daemon backend, and the daemon treats any request whose Host header
   * carries this port as dev-server content traffic — a separate browser
   * origin from the control plane, so framed content gets working
   * storage/fetch without ever being same-origin with the PWA's token.
   */
  webpaneContentPort: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.parse(env);

  if (!isBindAllowed(parsed.MV_BIND_ADDRESS)) {
    // §16.5 fail closed / spec T1-T2: never bind a public interface or wildcard.
    throw new Error(
      `refusing to start: MV_BIND_ADDRESS "${parsed.MV_BIND_ADDRESS}" is a public or wildcard bind. ` +
      `Bind to loopback or a private/tailnet address only.`,
    );
  }

  const csv = (s: string | undefined): string[] =>
    (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  const vapid =
    parsed.MV_VAPID_PUBLIC_KEY && parsed.MV_VAPID_PRIVATE_KEY
      ? { publicKey: parsed.MV_VAPID_PUBLIC_KEY, privateKey: parsed.MV_VAPID_PRIVATE_KEY }
      : null;

  if (parsed.MV_WEBPANE_CONTENT_PORT === parsed.MV_PORT) {
    // The content-plane discriminator is the Host header's port; if it equals
    // the daemon's own port, every direct request would be misread as
    // dev-server content traffic and the control plane would be unreachable.
    throw new Error('refusing to start: MV_WEBPANE_CONTENT_PORT must differ from MV_PORT');
  }

  return {
    bindAddress: parsed.MV_BIND_ADDRESS,
    port: parsed.MV_PORT,
    bearerToken: parsed.MV_BEARER_TOKEN ?? randomBytes(24).toString('base64url'),
    allowedHosts: csv(parsed.MV_ALLOWED_HOSTS),
    allowedOrigins: csv(parsed.MV_ALLOWED_ORIGINS),
    vapid,
    claudeBin: parsed.MV_CLAUDE_BIN,
    webpaneContentPort: parsed.MV_WEBPANE_CONTENT_PORT,
  };
}

/**
 * True only for loopback and private/tailnet addresses. Rejects 0.0.0.0, ::,
 * and any globally-routable address. The daemon executes code on the laptop,
 * so a public bind is never acceptable (spec T1/T2).
 */
export function isBindAllowed(addr: string): boolean {
  if (!addr) return false;
  const a = addr.trim();
  if (a === '0.0.0.0' || a === '::' || a === '*') return false;
  if (a === '127.0.0.1' || a === '::1' || a.startsWith('127.')) return true;

  // IPv6 private
  const lower = a.toLowerCase();
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return false;
  const [x, y] = oct as [number, number, number, number];
  if (x === 10) return true;                         // 10/8
  if (x === 172 && y >= 16 && y <= 31) return true;  // 172.16/12
  if (x === 192 && y === 168) return true;           // 192.168/16
  if (x === 169 && y === 254) return true;           // link-local
  if (x === 100 && y >= 64 && y <= 127) return true; // 100.64/10 CGNAT (Tailscale)
  return false;                                       // everything else = public
}
