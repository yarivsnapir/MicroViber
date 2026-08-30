import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { ReactElement } from 'react';
import { classifyLink } from './link-classify.js';
import { navigateWebPane } from '../components/WebPane.js';

/**
 * Safe transcript markdown. react-markdown renders to a React tree and does
 * NOT use innerHTML; raw HTML in content is inert (we never add rehype-raw),
 * and javascript:/data:/vbscript: URLs are stripped by the URL transform
 * below. This is the T7 defense — rendering transcripts IS the product, and
 * transcript content is arbitrary model output, source code, and scraped web
 * text.
 *
 * Story microviber-track-b-4 (spec §5): links are additionally classified
 * local vs external at render time — local links route into the Web pane
 * instead of navigating away. `sessionCwd` defaults to '' so callers that
 * only render fixed (non-relative-path) content don't need to supply one.
 *
 * Final whole-branch review, Finding 2: react-markdown's built-in
 * `defaultUrlTransform` only allows `https?|ircs?|mailto|xmpp` schemes, so a
 * `file://` link arrived here as an already-stripped `href === ''` and never
 * reached classifyLink's `localfile` branch — spec AC1's `file://` support
 * was dead in the actual product. This custom transform lets `file://`
 * through unchanged and delegates every other scheme to the default
 * (still-safe) behavior.
 */
function urlTransform(value: string): string {
  return value.startsWith('file://') ? value : defaultUrlTransform(value);
}

/**
 * Final whole-branch review, Findings 3+4: only intercept the link kinds
 * this story actually classifies (http(s), file://, and bare filesystem
 * paths). Everything else — an empty/stripped href (Finding 3: a stripped
 * javascript:/data: URL, or a literal `[text]()`), an in-page `#fragment`,
 * or another scheme entirely such as `mailto:`/`tel:` (Finding 4) — must
 * fall through to plain, unintercepted anchor behavior, exactly as it did
 * before this story existed. Without this guard, classifyLink's bare-path
 * fallback swallowed all of these and misclassified them as `localfile`,
 * producing a bogus "file not found" alert (or in mailto:'s case, silently
 * killing the mail-app handoff).
 */
function shouldIntercept(href: string): boolean {
  if (!href) return false; // empty/stripped — Finding 3
  if (href.startsWith('#')) return false; // in-page anchor — Finding 4
  if (href.startsWith('file://')) return true;
  if (/^https?:\/\//i.test(href)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // mailto:, tel:, etc. — Finding 4
  return true; // bare filesystem path
}

export function SafeMarkdown({ children, sessionCwd = '' }: { children: string; sessionCwd?: string }): ReactElement {
  return (
    <Markdown
      urlTransform={urlTransform}
      components={{
        a: ({ href, children: linkChildren }) => {
          if (!shouldIntercept(href ?? '')) {
            return <a href={href}>{linkChildren}</a>;
          }
          const classified = classifyLink(href ?? '', sessionCwd);
          if (classified.kind === 'external') {
            return <a href={classified.href} target="_blank" rel="noopener noreferrer">{linkChildren}</a>;
          }
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                navigateWebPane(classified.kind === 'devserver'
                  ? { kind: 'devserver', port: classified.port, path: classified.path }
                  : { kind: 'localfile', path: classified.path });
              }}
            >
              {linkChildren}
            </a>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}
