export type ClassifiedLink =
  | { kind: 'external'; href: string }
  | { kind: 'devserver'; port: number; path: string }
  | { kind: 'localfile'; path: string };

/**
 * Spec §5: local (file:// / bare path / localhost|127.0.0.1 of any scheme)
 * vs external (any other http(s) URL). A relative bare path resolves
 * against the originating session's cwd before being sent anywhere.
 */
export function classifyLink(href: string, sessionCwd: string): ClassifiedLink {
  if (href.startsWith('file://')) {
    return { kind: 'localfile', path: href.slice('file://'.length) };
  }

  const httpMatch = /^https?:\/\/(localhost|127\.0\.0\.1)(:(\d+))?(\/.*)?$/.exec(href);
  if (httpMatch) {
    const port = httpMatch[3] ? Number(httpMatch[3]) : 80;
    const path = httpMatch[4] ?? '/';
    return { kind: 'devserver', port, path };
  }

  if (/^https?:\/\//.test(href)) {
    return { kind: 'external', href };
  }

  // Bare filesystem path: absolute (leading '/') used as-is, relative resolved against sessionCwd.
  if (href.startsWith('/')) return { kind: 'localfile', path: href };
  return { kind: 'localfile', path: `${sessionCwd.replace(/\/$/, '')}/${href}` };
}
