import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
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
const MAX_CHILD_DIRS_SCANNED = 25;

/**
 * A session's cwd is often a multi-project workspace root (this repo's own
 * convention: one Claude Code session at the workspace root, subprojects
 * reached via `cd studio && ...`) rather than a single project directory —
 * story-3's manual testing found that with only the cwd itself checked, a
 * workspace-root session can never resolve any dev server at all, even
 * though several of its immediate subdirectories each have their own
 * resolvable port. This lists cwd's immediate children only (no recursion —
 * bounded cost, matches the "shallow, explicit" resolution philosophy of the
 * tiers above) so each can be checked with the exact same tier 1-3 logic.
 * Symlinks are excluded rather than followed, to avoid a project file
 * steering resolution outside cwd's own tree (same spirit as T13's "never
 * import/execute" — a symlink is another way a hostile/careless repo
 * structure could redirect the scan somewhere unintended). The number of real
 * child DIRECTORIES scanned is capped at MAX_CHILD_DIRS_SCANNED (applied after
 * the directory filter, so the cap bounds the expensive per-child config-read
 * sweep the caller runs — not the raw readdir entries) so a huge or unusual
 * directory can't turn a routine GET /api/sessions into an unbounded per-child
 * file-read sweep. (readdirSync still enumerates every name — that part can't
 * be pre-capped — but the expensive per-child work is bounded.)
 */
function defaultListChildDirs(cwd: string): string[] {
  try {
    // Cap the number of real DIRECTORIES scanned, applied AFTER the filter
    // (review finding I4, corrected): the expensive per-child work is the
    // config-file-read sweep the caller runs on each returned name, so the
    // cap must bound the *filtered* directory count, not the raw readdir
    // entries. Slicing raw entries before filtering was wrong — it dropped a
    // real project dir (e.g. `studio`) whenever ≥25 dotfiles/files/symlinks
    // sorted ahead of it, silently un-resolving its dev server. `isDirectory`/
    // `isSymbolicLink` read the Dirent flags from the withFileTypes readdir —
    // no extra stat — so the filter itself is cheap; only resolveOne (in the
    // caller) does file I/O, and that is what MAX_CHILD_DIRS_SCANNED bounds.
    // (readdirSync still enumerates every name — unavoidable with readdirSync —
    // but the per-child config reads are capped.)
    return readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, MAX_CHILD_DIRS_SCANNED)
      .map((e) => e.name);
  } catch {
    return []; // ENOENT/EACCES/not-a-directory/race — best-effort, no children found
  }
}
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

/** The same tier 1-3 chain, scoped to one directory (cwd itself, or one of its children). */
function resolveOne(dir: string, devports: DevportsConfig, readFileIfExists: (p: string) => string | null): number | null {
  return (
    fromDotenv(dir, readFileIfExists) ??
    fromDevportsConfig(dir, devports) ??
    fromStaticConfigScan(dir, readFileIfExists)
  );
}

export interface ResolvedDevServer {
  folder: string;
  port: number;
}

/**
 * Resolves every dev server visible from a session's cwd: cwd itself (spec
 * §3's original single-project case) plus each of cwd's immediate child
 * directories (the multi-project workspace-root case — see
 * defaultListChildDirs above). Returns one entry per resolved port, folder
 * being the basename of whichever directory resolved it.
 */
export function resolveDevServerPorts(
  cwd: string,
  devports: DevportsConfig,
  deps: { readFileIfExists?: (p: string) => string | null; listChildDirs?: (cwd: string) => string[] } = {},
): ResolvedDevServer[] {
  const readFileIfExists = deps.readFileIfExists ?? defaultReadFileIfExists;
  const listChildDirs = deps.listChildDirs ?? defaultListChildDirs;
  const results: ResolvedDevServer[] = [];
  try {
    const own = resolveOne(cwd, devports, readFileIfExists);
    if (own !== null) results.push({ folder: basename(cwd), port: own });
    for (const child of listChildDirs(cwd)) {
      const port = resolveOne(join(cwd, child), devports, readFileIfExists);
      if (port !== null) results.push({ folder: child, port });
    }
    return results;
  } catch {
    // Best-effort: a thrown reader (custom deps, or an unforeseen edge case
    // in the default reader) must never crash the caller (e.g. GET
    // /api/sessions) — degrade to whatever resolved before the throw instead.
    // defaultReadFileIfExists/defaultListChildDirs no longer throw themselves;
    // this is defense in depth for any reader.
    return results;
  }
}
