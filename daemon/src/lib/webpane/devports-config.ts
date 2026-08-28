import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

/**
 * Daemon-owned, explicit port config (spec §3 tier 2) — full-absolute-path
 * keyed, to avoid folder-basename collisions between differently-located
 * folders that happen to share a name. Optional file: missing => {}. Present
 * but malformed => throws (fail closed — a typo here should never silently
 * resolve to "no config" and leave the operator wondering why nothing works).
 */
const DevportsEntrySchema = z.object({
  port: z.number().int().min(1).max(65535),
  framework: z.string().optional(),
  startCommand: z.string().optional(),
});
const DevportsConfigSchema = z.record(z.string(), DevportsEntrySchema);

export type DevportsEntry = z.infer<typeof DevportsEntrySchema>;
export type DevportsConfig = z.infer<typeof DevportsConfigSchema>;

export function loadDevportsConfig(
  path: string,
  deps: { readFileIfExists?: (p: string) => string | null } = {},
): DevportsConfig {
  const readFileIfExists = deps.readFileIfExists ?? ((p: string) => {
    if (!existsSync(p)) return null;
    // statSync is metadata-only — never blocks on a FIFO the way readFileSync would.
    // A non-regular-file at this path (directory, FIFO, socket) or an oversized file
    // is treated as "present but malformed" — fail closed, consistent with the rest
    // of this function, rather than silently degrading to no-config or hanging.
    const st = statSync(p);
    if (!st.isFile()) throw new Error(`devports config path exists but is not a regular file: ${p}`);
    if (st.size > 1_048_576) throw new Error(`devports config file too large (>1MiB): ${p}`);
    return readFileSync(p, 'utf8');
  });
  const raw = readFileIfExists(path);
  if (raw === null) return {};
  const parsed = JSON.parse(raw); // throws SyntaxError on malformed JSON — fail closed
  return DevportsConfigSchema.parse(parsed); // throws ZodError on schema violation — fail closed
}
