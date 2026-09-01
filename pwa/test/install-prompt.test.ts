// @vitest-environment jsdom
// pwa/test/install-prompt.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureInstallPrompt } from '../src/lib/install-prompt.js';

describe('captureInstallPrompt (spec §2)', () => {
  beforeEach(() => { Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), writable: true }); });

  it('captures a beforeinstallprompt event and exposes it', () => {
    const { getEvent } = captureInstallPrompt();
    expect(getEvent()).toBeNull();
    const evt = new Event('beforeinstallprompt');
    Object.assign(evt, { preventDefault: vi.fn() });
    window.dispatchEvent(evt);
    expect(getEvent()).toBe(evt);
  });

  it('isStandalone reflects display-mode: standalone', () => {
    const { isStandalone } = captureInstallPrompt();
    expect(isStandalone()).toBe(false);
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    expect(isStandalone()).toBe(true);
  });
});
