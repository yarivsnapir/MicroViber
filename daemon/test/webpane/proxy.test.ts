import { describe, it, expect, vi, afterEach } from 'vitest';
import { proxyToLoopback } from '../../src/lib/webpane/proxy.js';

describe('proxyToLoopback (target host hardcoded to loopback, only port varies)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('always targets 127.0.0.1, forwarding method/path/headers/body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await proxyToLoopback(9005, '/dashboard', { method: 'GET', headers: { accept: 'text/html' } });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9005/dashboard', expect.objectContaining({ method: 'GET' }));
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('hi');
  });

  it('forwards a request body for non-GET methods', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = new TextEncoder().encode('{"x":1}');
    await proxyToLoopback(9005, '/api/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(body);
  });

  it('surfaces a connection failure as a thrown error, not a silent empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(proxyToLoopback(9005, '/', { method: 'GET', headers: {} })).rejects.toThrow(/ECONNREFUSED/);
  });
});
