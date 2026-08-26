const KEY = 'microviber.token';

/** Extract the bearer token from a pairing URL fragment (#token=...). */
export function parseTokenFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(h);
  const t = params.get('token');
  return t && t.length >= 8 ? t : null;
}

export function loadToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function saveToken(t: string): void {
  try { localStorage.setItem(KEY, t); } catch { /* storage disabled */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

/** On load: capture a token from the pairing fragment, persist it, scrub the URL. */
export function captureTokenFromUrl(loc: { hash: string }, replaceHash: (h: string) => void): string | null {
  const t = parseTokenFromHash(loc.hash);
  if (t) { saveToken(t); replaceHash(''); return t; }
  return loadToken();
}
