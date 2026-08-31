export type ClassifiedLink =
  | { kind: 'external'; href: string }
  | { kind: 'devserver'; port: number; path: string }
  | { kind: 'localfile'; path: string };

/**
 * Spec §5: local (file:// / bare path / localhost|127.0.0.1|[::1] of any
 * scheme) vs external (any other http(s) URL). A relative bare path
 * resolves against the originating session's cwd before being sent
 * anywhere.
 *
 * Security-review finding: the http(s) matches below were previously
 * case-sensitive while markdown.tsx's shouldIntercept() checked case-
 * insensitively — an uppercase-scheme URL like `HTTPS://github.com/...`
 * passed shouldIntercept but then missed both http(s) matches here and
 * fell into the bare-path fallback, misclassified as `localfile` (breaking
 * AC4 and rendering with no rel="noopener noreferrer"). Both matches are
 * now case-insensitive to match shouldIntercept's guard. A protocol-relative
 * URL (`//host/path`) is now classified external too, for the same reason —
 * it isn't `http(s)://`-prefixed so it used to fall into the same bare-path
 * trap.
 */
export function classifyLink(href: string, sessionCwd: string): ClassifiedLink {
  if (href.startsWith('file://')) {
    return { kind: 'localfile', path: href.slice('file://'.length) };
  }

  if (href.startsWith('//')) {
    return { kind: 'external', href };
  }

  const httpMatch = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?([/?#].*)?$/i.exec(href);
  if (httpMatch) {
    const port = httpMatch[2] ? Number(httpMatch[2]) : 80;
    const rest = httpMatch[3] ?? '';
    const path = rest === '' || rest.startsWith('/') ? (rest || '/') : `/${rest}`;
    return { kind: 'devserver', port, path };
  }

  if (/^https?:\/\//i.test(href)) {
    return { kind: 'external', href };
  }

  // Bare filesystem path: absolute (leading '/') used as-is, relative resolved against sessionCwd.
  if (href.startsWith('/')) return { kind: 'localfile', path: href };
  return { kind: 'localfile', path: `${sessionCwd.replace(/\/$/, '')}/${href}` };
}
