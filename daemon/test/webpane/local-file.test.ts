import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalFile, MAX_LOCAL_FILE_BYTES } from '../../src/lib/webpane/local-file.js';

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

  describe('guards against a real FIFO (DoS: readFileSync on a FIFO with no writer blocks the event loop forever, no timeout)', () => {
    it('returns null promptly instead of hanging, using the real default filesystem reader (no injected deps)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mv-local-file-fifo-test-'));
      const fifoPath = join(dir, 'a-fifo');
      try {
        execSync(`mkfifo "${fifoPath}"`);
      } catch {
        // mkfifo unavailable on this platform/CI image — skip rather than
        // fail the suite over an environment gap; the fake-stat test below
        // covers the same isFile()-guard logic without needing a real FIFO.
        rmSync(dir, { recursive: true, force: true });
        return;
      }
      // If the fix regresses (e.g. the isFile() guard is removed), this call
      // would hang the test process indefinitely — there is no writer on the
      // other end of the FIFO and readFileSync has no timeout. A prompt
      // return (not a timeout wrapper) is the actual proof the guard works.
      expect(readLocalFile(fifoPath)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('statFile injection (proves the stat-based guards without needing a real FIFO or a real oversized file)', () => {
    it('rejects a non-regular-file stat result without ever calling the byte-read path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mv-local-file-stat-test-'));
      const p = join(dir, 'whatever');
      // p exists as a real, readable regular file — so if the isFile() guard
      // were skipped, readFileSync(p) would succeed and return its bytes.
      // Getting null back is only possible because the fake statFile's
      // isFile()===false short-circuits BEFORE readFileSync is ever reached.
      writeFileSync(p, 'hi');
      const r = readLocalFile(p, {
        statFile: () => ({ isFile: () => false, size: 2 }),
      });
      expect(r).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a file whose reported size exceeds MAX_LOCAL_FILE_BYTES, without allocating that much memory', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mv-local-file-size-test-'));
      const p = join(dir, 'small-file-lying-about-its-size');
      writeFileSync(p, 'hi'); // tiny real file — the fake stat is what claims it's oversized
      const r = readLocalFile(p, {
        statFile: () => ({ isFile: () => true, size: MAX_LOCAL_FILE_BYTES + 1 }),
      });
      expect(r).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('allows a file at or under the cap through to the byte-read path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mv-local-file-size-ok-test-'));
      const p = join(dir, 'ok.txt');
      writeFileSync(p, 'hi');
      const r = readLocalFile(p, {
        statFile: () => ({ isFile: () => true, size: 2 }),
      });
      expect(r?.bytes.toString()).toBe('hi');
      expect(r?.contentType).toBe('text/plain');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
