import { existsSync, readFileSync } from 'node:fs';
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

export interface DevportsEntry {
  port: number;
  framework?: string;
  startCommand?: string;
}
export type DevportsConfig = Record<string, DevportsEntry>;

export function loadDevportsConfig(
  path: string,
  deps: { readFileIfExists?: (p: string) => string | null } = {},
): DevportsConfig {
  const readFileIfExists = deps.readFileIfExists ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
  const raw = readFileIfExists(path);
  if (raw === null) return {};
  const parsed = JSON.parse(raw); // throws SyntaxError on malformed JSON — fail closed
  // reason: Zod's parse returns string | undefined for optional fields, but exactOptionalPropertyTypes requires proper handling
  return DevportsConfigSchema.parse(parsed) as DevportsConfig; // throws ZodError on schema violation — fail closed
}
