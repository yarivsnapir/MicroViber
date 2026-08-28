import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DevportsConfig } from './devports-config.js';

/**
 * Stats before reading, and never throws. Rejects anything that isn't a
 * regular file (directories, FIFOs, device nodes, sockets) — a FIFO passed
 * to readFileSync would block the event loop forever with no timeout, a real
 * unrecoverable DoS, and a directory would throw EISDIR and crash the caller.
 * Also caps size so a huge file can't be read unbounded into memory.
 */
function defaultReadFileIfExists(p: string): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null; // directories, FIFOs, device nodes, sockets
    if (st.size > 1_048_576) return null; // don't read unbounded/huge files into memory
    return readFileSync(p, 'utf8');
  } catch {
    return null; // ENOENT / EACCES / race / anything else — best-effort, treat as absent
  }
}

/**
 * Tiers 1 and 3 do a bare regex-captured Number() with no bound check, unlike
 * tier 2 (devports.json), which fails closed on out-of-range ports via its
 * own Zod schema (devports-config.ts). An out-of-range match here must be
 * treated as "no match" — not a resolved port — so it falls through to the
 * next tier instead of silently overriding it (nullish-coalescing chaining
 * in resolveDevServerPort treats any number, including 0, as "resolved").
 *
 * The resolved devServerPort becomes a security allowlist for the dev-server
 * reverse-proxy route (a later story): the daemon will only proxy to ports
 * that resolved here. Floor is 1024, not 1 — no dev server ever binds a
 * privileged port, so a `.env` with PORT=22 or PORT=5432 must never enroll
 * SSH/Postgres into that allowlist.
 */
function validPort(n: number): number | null {
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** Tier 1 (spec §3): a PORT= line in the folder's own .env. Text scan only — never imported/executed. */
function fromDotenv(cwd: string, readFileIfExists: (p: string) => string | null): number | null {
  const text = readFileIfExists(join(cwd, '.env'));
  if (!text) return null;
  const m = /^PORT=(\d+)$/m.exec(text);
  return m?.[1] ? validPort(Number(m[1])) : null;
}

/** Tier 2 (spec §3): microviber/devports.json, keyed by full absolute path. */
function fromDevportsConfig(cwd: string, devports: DevportsConfig): number | null {
  return devports[cwd]?.port ?? null;
}

/**
 * Tier 3 (spec §3): a non-executing regex/text scan of common dev-server
 * config files. Lowest confidence — only consulted when tiers 1-2 resolve
 * nothing. Deliberately never imports/requires any of these files (a
 * malicious or broken config file must not crash resolution, let alone
 * execute) — text pattern matching only.
 */
function fromStaticConfigScan(cwd: string, readFileIfExists: (p: string) => string | null): number | null {
  const candidates = ['vite.config.ts', 'vite.config.js', 'angular.json', 'webpack.config.js', 'webpack.config.cjs'];
  for (const file of candidates) {
    const text = readFileIfExists(join(cwd, file));
    if (!text) continue;
    const m = /\bport"?\s*:\s*"?(\d+)/.exec(text);
    if (m?.[1]) {
      const port = validPort(Number(m[1]));
      if (port !== null) return port;
    }
  }
  const pkgText = readFileIfExists(join(cwd, 'package.json'));
  if (pkgText) {
    try {
      // reason: JSON parsed config object needs flexible typing before extraction
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      for (const script of Object.values(pkg.scripts ?? {})) {
        const m = /--port[= ](\d+)/.exec(script);
        if (m?.[1]) {
          const port = validPort(Number(m[1]));
          if (port !== null) return port;
        }
      }
    } catch {
      // Malformed package.json: not this resolver's problem to report — just no match.
    }
  }
  return null;
}

export function resolveDevServerPort(
  cwd: string,
  devports: DevportsConfig,
  deps: { readFileIfExists?: (p: string) => string | null } = {},
): number | null {
  const readFileIfExists = deps.readFileIfExists ?? defaultReadFileIfExists;
  try {
    return (
      fromDotenv(cwd, readFileIfExists) ??
      fromDevportsConfig(cwd, devports) ??
      fromStaticConfigScan(cwd, readFileIfExists)
    );
  } catch {
    // Best-effort: a thrown reader (custom deps, or an unforeseen edge case
    // in the default reader) must never crash the caller (e.g. GET
    // /api/sessions) — degrade to "unresolved" instead. defaultReadFileIfExists
    // itself no longer throws, but this is defense in depth for any reader.
    return null;
  }
}
