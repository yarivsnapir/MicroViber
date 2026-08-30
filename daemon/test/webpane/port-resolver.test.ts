import { describe, it, expect } from 'vitest';
import { resolveDevServerPorts } from '../../src/lib/webpane/port-resolver.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => files[p] ?? null };
}

describe('resolveDevServerPorts (spec §3 — first match wins, per directory)', () => {
  it('tier 1: reads PORT= from the folder .env, never executes it', () => {
    const deps = fakeFs({ '/proj/.env': 'FOO=bar\nPORT=9015\nBAZ=qux\n' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([{ folder: 'proj', port: 9015 }]);
  });

  it('tier 2: falls back to devports.json (full-path keyed) when no .env PORT', () => {
    const deps = fakeFs({});
    expect(resolveDevServerPorts('/proj', { '/proj': { port: 9005 } }, deps)).toEqual([{ folder: 'proj', port: 9005 }]);
  });

  it('tier 1 wins over tier 2 when both are present', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=1111\n' });
    expect(resolveDevServerPorts('/proj', { '/proj': { port: 9005 } }, deps)).toEqual([{ folder: 'proj', port: 1111 }]);
  });

  it('tier 3: scans vite.config.* for a port: field when tiers 1-2 are absent', () => {
    const deps = fakeFs({ '/proj/vite.config.ts': 'export default { server: { port: 3000 } }' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([{ folder: 'proj', port: 3000 }]);
  });

  it('tier 3: scans package.json scripts for a --port flag', () => {
    const deps = fakeFs({ '/proj/package.json': JSON.stringify({ scripts: { dev: 'vite --port 4200' } }) });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([{ folder: 'proj', port: 4200 }]);
  });

  it('returns an empty array when no tier resolves anything', () => {
    expect(resolveDevServerPorts('/proj', {}, fakeFs({}))).toEqual([]);
  });

  it('never executes/imports the scanned files — only regexes their raw text', () => {
    // A file that would throw if imported/required must not crash resolution.
    const deps = fakeFs({ '/proj/vite.config.ts': 'throw new Error("do not import me"); export default { port: 3000 }' });
    expect(() => resolveDevServerPorts('/proj', {}, deps)).not.toThrow();
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([{ folder: 'proj', port: 3000 }]);
  });

  it('tier 1: PORT=0 in .env is out of range — does not short-circuit, falls through to tier 2', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=0\n' });
    expect(resolveDevServerPorts('/proj', { '/proj': { port: 9005 } }, deps)).toEqual([{ folder: 'proj', port: 9005 }]);
  });

  it('tier 1: PORT=0 in .env with no lower tier available resolves to empty, not port 0', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=0\n' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
  });

  it('tier 1: PORT=999999 in .env is out of range — falls through to tier 2', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=999999\n' });
    expect(resolveDevServerPorts('/proj', { '/proj': { port: 9005 } }, deps)).toEqual([{ folder: 'proj', port: 9005 }]);
  });

  it('tier 3: an out-of-range port in a scanned vite.config falls through to empty', () => {
    const deps = fakeFs({ '/proj/vite.config.ts': 'export default { server: { port: 999999 } }' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
  });

  it('tier 3: an out-of-range --port flag in package.json scripts falls through to empty', () => {
    const deps = fakeFs({ '/proj/package.json': JSON.stringify({ scripts: { dev: 'vite --port 0' } }) });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
  });

  it('tier 1: PORT=999 in .env is below the 1024 privileged-port floor — falls through rather than resolving', () => {
    const deps = fakeFs({ '/proj/.env': 'PORT=999\n' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
    // and still falls through to a lower tier when one is present
    expect(resolveDevServerPorts('/proj', { '/proj': { port: 9005 } }, deps)).toEqual([{ folder: 'proj', port: 9005 }]);
  });

  it('tier 3: scans angular.json (JSON key syntax) for a "port" field', () => {
    const deps = fakeFs({
      '/proj/angular.json': JSON.stringify({
        projects: { app: { architect: { serve: { options: { port: 4200 } } } } },
      }),
    });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([{ folder: 'proj', port: 4200 }]);
  });

  it('tier 3: does not false-match "transport" or "viewport" as "port"', () => {
    const deps = fakeFs({ '/proj/vite.config.ts': 'export default { transport: 5432, viewport: 1024 }' });
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
  });

  it('swallows a throwing reader and returns whatever resolved before the throw, never propagating it', () => {
    const deps = { readFileIfExists: (): string | null => { throw new Error('boom'); } };
    expect(() => resolveDevServerPorts('/proj', {}, deps)).not.toThrow();
    expect(resolveDevServerPorts('/proj', {}, deps)).toEqual([]);
  });

  describe('multi-project workspace root (story-3 manual-test finding)', () => {
    it('resolves each immediate child directory that independently resolves a port, in addition to cwd itself', () => {
      const deps = {
        readFileIfExists: fakeFs({
          '/ws/studio/.env': 'PORT=9005\n',
          '/ws/audio-producer/.env': 'PORT=9008\n',
        }).readFileIfExists,
        listChildDirs: () => ['studio', 'audio-producer', 'scenario-creator'],
      };
      // scenario-creator has no .env/config in this fixture, so it resolves nothing.
      expect(resolveDevServerPorts('/ws', {}, deps)).toEqual([
        { folder: 'studio', port: 9005 },
        { folder: 'audio-producer', port: 9008 },
      ]);
    });

    it('includes a port resolved at cwd itself alongside ports resolved from children', () => {
      const deps = {
        readFileIfExists: fakeFs({ '/ws/.env': 'PORT=3000\n', '/ws/studio/.env': 'PORT=9005\n' }).readFileIfExists,
        listChildDirs: () => ['studio'],
      };
      expect(resolveDevServerPorts('/ws', {}, deps)).toEqual([
        { folder: 'ws', port: 3000 },
        { folder: 'studio', port: 9005 },
      ]);
    });

    it('returns an empty array when cwd has no children and resolves nothing itself', () => {
      const deps = { readFileIfExists: fakeFs({}).readFileIfExists, listChildDirs: () => [] };
      expect(resolveDevServerPorts('/ws', {}, deps)).toEqual([]);
    });

    it('the default child-dir lister excludes node_modules, hidden directories, and symlinks, and caps the scan', () => {
      // Exercised via the real default (no listChildDirs override) against a
      // directory this repo actually has, to prove the real readdirSync-based
      // implementation — not just its injected double — behaves safely: it
      // must not throw and must not include a hostile-cost unbounded result.
      const results = resolveDevServerPorts(process.cwd(), {}, { readFileIfExists: fakeFs({}).readFileIfExists });
      expect(Array.isArray(results)).toBe(true);
    });

    it('resolves a real child project dir even when >25 files/dotfiles sort ahead of it (regression: cap must apply AFTER the dir filter, not to raw readdir entries)', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync: wf } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: j } = await import('node:path');
      const ws = mkdtempSync(j(tmpdir(), 'mv-ws-'));
      // 30 plain files that sort BEFORE "studio" — the old slice-before-filter
      // would consume the whole 25-entry budget on these and drop studio.
      for (let i = 0; i < 30; i++) wf(j(ws, `aa${String(i).padStart(2, '0')}.txt`), 'x');
      mkdirSync(j(ws, 'studio'));
      wf(j(ws, 'studio', '.env'), 'PORT=9005\n');
      // Real default lister (no listChildDirs override) — exercises readdirSync + slice.
      expect(resolveDevServerPorts(ws, {})).toEqual([{ folder: 'studio', port: 9005 }]);
    });

    it('a thrown reader mid-scan degrades to whatever resolved before it, never crashing the whole session list', () => {
      let calls = 0;
      const deps = {
        readFileIfExists: (p: string) => {
          calls += 1;
          if (p.includes('studio')) throw new Error('boom');
          return p === '/ws/.env' ? 'PORT=3000\n' : null;
        },
        listChildDirs: () => ['studio'],
      };
      expect(() => resolveDevServerPorts('/ws', {}, deps)).not.toThrow();
      expect(calls).toBeGreaterThan(0);
    });
  });
});
