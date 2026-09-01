import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('manifest.webmanifest (spec §2)', () => {
  it('has both icon sizes with any+maskable purpose', () => {
    const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
    expect(m.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icon-192.png', sizes: '192x192', purpose: 'any maskable' }),
      expect.objectContaining({ src: '/icon-512.png', sizes: '512x512', purpose: 'any maskable' }),
    ]));
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
  });
});
