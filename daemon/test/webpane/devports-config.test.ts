import { describe, it, expect } from 'vitest';
import { loadDevportsConfig } from '../../src/lib/webpane/devports-config.js';

describe('loadDevportsConfig', () => {
  it('returns an empty config when the file does not exist (optional file)', () => {
    const cfg = loadDevportsConfig('/nonexistent/devports.json', { readFileIfExists: () => null });
    expect(cfg).toEqual({});
  });

  it('parses a valid config keyed by full absolute path', () => {
    const json = JSON.stringify({
      '/Users/you/Harness-2/studio': { port: 9005, framework: 'next', startCommand: 'npm run dev' },
      '/Users/you/Harness-2/audio-producer': { port: 9008 },
    });
    const cfg = loadDevportsConfig('/x/devports.json', { readFileIfExists: () => json });
    expect(cfg['/Users/you/Harness-2/studio']).toEqual({ port: 9005, framework: 'next', startCommand: 'npm run dev' });
    expect(cfg['/Users/you/Harness-2/audio-producer']).toEqual({ port: 9008 });
  });

  it('fails closed on malformed JSON — a typo should not silently resolve to no config', () => {
    expect(() => loadDevportsConfig('/x/devports.json', { readFileIfExists: () => '{ not json' })).toThrow();
  });

  it('fails closed on a schema violation (e.g. port out of range)', () => {
    const json = JSON.stringify({ '/x/studio': { port: 999999 } });
    expect(() => loadDevportsConfig('/x/devports.json', { readFileIfExists: () => json })).toThrow();
  });
});
