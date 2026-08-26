import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApi } from '../src/lib/api.js';

describe('api.handback (microviber-3 AC 6/7)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/sessions/{id}/handback with the bearer header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 's1', mode: 'readonly' } }),
    });
    const api = createApi('http://x.test', 'tok-123');

    const result = await api.handback('s1');

    expect(result).toEqual({ id: 's1', mode: 'readonly' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/api/sessions/s1/handback');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  // AC 7: the dead fresh-start client fn and the daemon route it called are
  // removed entirely, not just unused — enforced at the type level (any
  // lingering reference fails `npm run typecheck`) and verified by grep in
  // the story report, not by a runtime assertion here.
});
