import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryDeps } from './discovery.js';
import { transcriptRelPath } from './discovery.js';

/** Real filesystem/liveness sources for discovery. The only place that reads ~/.claude. */
export function nodeDiscoverySources(): DiscoveryDeps {
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  const projectsDir = join(homedir(), '.claude', 'projects');
  return {
    listSessionFiles: () =>
      (existsSync(sessionsDir) ? readdirSync(sessionsDir) : [])
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f)),
    readFile: (p) => readFileSync(p, 'utf8'),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    readTranscript: (cwd, sid) => {
      const p = join(projectsDir, transcriptRelPath(cwd, sid));
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
  };
}

export function readTranscriptText(cwd: string, sessionId: string): string | null {
  const p = join(homedir(), '.claude', 'projects', transcriptRelPath(cwd, sessionId));
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
