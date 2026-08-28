import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * No folder restriction — any path the daemon process can read is servable
 * (spec §3 "Local file viewing", explicit deviation recorded in spec §9,
 * bounded by iframe sandboxing on the PWA side, a later story). This
 * function only reads bytes; it never executes, interprets, or evaluates
 * file content.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * Generous but bounded — this route also serves PDFs/images per the content-
 * type table above, so it needs headroom beyond a typical text file, but a
 * multi-GB regular file (or /dev/zero) must not be buffered whole into
 * memory (verified: that crashes the process with a heap-limit OOM).
 */
export const MAX_LOCAL_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Minimal shape used from fs.Stats — narrow so tests can inject a fake without a real Stats instance. */
type StatResult = { isFile(): boolean; size: number };
type StatFile = (p: string) => StatResult;

function defaultStatFile(p: string): StatResult {
  return statSync(p);
}

function readFileWithStatGuard(p: string, statFile: StatFile): Buffer | null {
  let st: StatResult;
  try {
    st = statFile(p);
  } catch {
    // ENOENT, EACCES on stat, a symlink to nowhere, etc. — same "can't serve
    // this" signal as any other failure below.
    return null;
  }
  // Reject anything that isn't a regular file (FIFOs, directories, device
  // nodes, sockets). existsSync/a bare readFileSync would not catch this: a
  // FIFO with no writer blocks readFileSync forever with no timeout, freezing
  // the daemon's entire event loop (verified: readFileSync on a FIFO never
  // returns), and a directory throws EISDIR. Mirrors the same guard in the
  // sibling reader, port-resolver.ts's defaultReadFileIfExists.
  if (!st.isFile()) return null;
  if (st.size > MAX_LOCAL_FILE_BYTES) return null;
  try {
    return readFileSync(p);
  } catch {
    // e.g. EACCES (permission denied) on the actual read — the route treats
    // any unreadable path as "not found", per the task's own acceptance
    // requirement ("404 when the file doesn't exist or is unreadable"), not
    // as a 500.
    return null;
  }
}

export function readLocalFile(
  path: string,
  deps: { readFileIfExists?: (p: string) => Buffer | null; statFile?: StatFile } = {},
): { bytes: Buffer; contentType: string } | null {
  const readFileIfExists = deps.readFileIfExists ?? ((p: string) => readFileWithStatGuard(p, deps.statFile ?? defaultStatFile));
  const bytes = readFileIfExists(path);
  if (bytes === null) return null;
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return { bytes, contentType };
}
