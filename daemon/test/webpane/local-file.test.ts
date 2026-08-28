import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalFile } from '../../src/lib/webpane/local-file.js';

function fakeFs(files: Record<string, string>) {
  return { readFileIfExists: (p: string) => (files[p] !== undefined ? Buffer.from(files[p]) : null) };
}

describe('readLocalFile (no folder restriction — explicit accepted risk, spec §9)', () => {
  it('guesses text/html for .html', () => {
    const r = readLocalFile('/x/mockup.html', fakeFs({ '/x/mockup.html': '<h1>hi</h1>' }));
    expect(r?.contentType).toBe('text/html');
  });
  it('guesses text/markdown for .md', () => {
    const r = readLocalFile('/x/spec.md', fakeFs({ '/x/spec.md': '# hi' }));
    expect(r?.contentType).toBe('text/markdown');
  });
  it('guesses image/png for .png', () => {
    const r = readLocalFile('/x/icon.png', fakeFs({ '/x/icon.png': 'binary' }));
    expect(r?.contentType).toBe('image/png');
  });
  it('guesses application/pdf for .pdf', () => {
    const r = readLocalFile('/x/doc.pdf', fakeFs({ '/x/doc.pdf': 'binary' }));
    expect(r?.contentType).toBe('application/pdf');
  });
  it('falls back to application/octet-stream for an unrecognized extension', () => {
    const r = readLocalFile('/x/data.bin', fakeFs({ '/x/data.bin': 'binary' }));
    expect(r?.contentType).toBe('application/octet-stream');
  });
  it('returns null when the file does not exist or is unreadable', () => {
    expect(readLocalFile('/anywhere/at/all.txt', fakeFs({}))).toBeNull();
  });
  it('does not restrict which absolute paths are attempted (explicit spec deviation)', () => {
    const r = readLocalFile('/etc/hosts', fakeFs({ '/etc/hosts': '127.0.0.1 localhost' }));
    expect(r?.bytes.toString()).toBe('127.0.0.1 localhost');
  });

  it('returns null (not a throw) for a real directory path, using the real default filesystem reader (no injected deps)', () => {
    // Regression: readFileSync on a directory throws EISDIR. existsSync alone
    // doesn't catch this — defaultReadFileIfExists must also catch the
    // readFileSync failure and treat it as "unreadable" (null), matching the
    // "404 when the file doesn't exist or is unreadable" requirement. This is
    // the only test in the suite that exercises the real, non-injected
    // filesystem reader.
    const dir = mkdtempSync(join(tmpdir(), 'mv-local-file-test-'));
    expect(() => readLocalFile(dir)).not.toThrow();
    expect(readLocalFile(dir)).toBeNull();
  });
});
