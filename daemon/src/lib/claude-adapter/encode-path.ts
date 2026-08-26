/**
 * Encode an absolute cwd into the directory name Claude Code uses under
 * ~/.claude/projects/. Claude maps '/', '.' AND '_' all to '-'.
 *
 * The underscore rule is the one that silently breaks discovery: miss it and
 * every developer whose username or folder contains an underscore gets
 * "transcript not found" for every session (Phase 0 finding I1).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}
