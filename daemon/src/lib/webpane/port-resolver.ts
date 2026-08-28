import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevportsConfig } from './devports-config.js';

function defaultReadFileIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * Tiers 1 and 3 do a bare regex-captured Number() with no bound check, unlike
 * tier 2 (devports.json), which fails closed on out-of-range ports via its
 * own Zod schema (devports-config.ts). An out-of-range match here must be
 * treated as "no match" — not a resolved port — so it falls through to the
 * next tier instead of silently overriding it (nullish-coalescing chaining
 * in resolveDevServerPort treats any number, including 0, as "resolved").
 */
function validPort(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
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
    const m = /port\s*:\s*(\d+)/.exec(text);
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
  return (
    fromDotenv(cwd, readFileIfExists) ??
    fromDevportsConfig(cwd, devports) ??
    fromStaticConfigScan(cwd, readFileIfExists)
  );
}
