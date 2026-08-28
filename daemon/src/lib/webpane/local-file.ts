import { existsSync, readFileSync } from 'node:fs';
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

function defaultReadFileIfExists(p: string): Buffer | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p);
  } catch {
    // e.g. EISDIR (path is a directory) or EACCES (permission denied) — the
    // route treats any unreadable path as "not found", per the task's own
    // acceptance requirement ("404 when the file doesn't exist or is
    // unreadable"), not as a 500.
    return null;
  }
}

export function readLocalFile(
  path: string,
  deps: { readFileIfExists?: (p: string) => Buffer | null } = {},
): { bytes: Buffer; contentType: string } | null {
  const readFileIfExists = deps.readFileIfExists ?? defaultReadFileIfExists;
  const bytes = readFileIfExists(path);
  if (bytes === null) return null;
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return { bytes, contentType };
}
