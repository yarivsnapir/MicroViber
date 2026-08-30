import { describe, it, expect } from 'vitest';
import { excludeSelfPort } from '../src/services/services.js';

describe('excludeSelfPort (spec §3 — devServerPorts must never allowlist the daemon itself)', () => {
  it('filters out an entry whose port matches the daemon\'s own listening port', () => {
    expect(excludeSelfPort([{ folder: 'f', port: 8730 }], 8730)).toEqual([]);
  });

  it('passes through an entry whose port differs from the daemon\'s own port', () => {
    expect(excludeSelfPort([{ folder: 'f', port: 5173 }], 8730)).toEqual([{ folder: 'f', port: 5173 }]);
  });

  it('filters only the matching entry out of a mixed list, keeping the rest', () => {
    const resolved = [{ folder: 'a', port: 8730 }, { folder: 'b', port: 5173 }];
    expect(excludeSelfPort(resolved, 8730)).toEqual([{ folder: 'b', port: 5173 }]);
  });

  it('passes through an empty list unchanged', () => {
    expect(excludeSelfPort([], 8730)).toEqual([]);
  });

  it('also excludes the webpane CONTENT port when passed (review finding M8 — a dev server resolving to the content port must not make the daemon proxy into its own front end)', () => {
    const resolved = [{ folder: 'a', port: 8443 }, { folder: 'b', port: 5173 }, { folder: 'c', port: 8730 }];
    expect(excludeSelfPort(resolved, 8730, 8443)).toEqual([{ folder: 'b', port: 5173 }]);
  });
});
