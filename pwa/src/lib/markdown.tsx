import Markdown from 'react-markdown';
import type { ReactElement } from 'react';
import { classifyLink } from './link-classify.js';
import { navigateWebPane } from '../components/WebPane.js';

/**
 * Safe transcript markdown. react-markdown renders to a React tree and does
 * NOT use innerHTML; raw HTML in content is inert (we never add rehype-raw),
 * and javascript: URLs are stripped by the default URL transform. This is the
 * T7 defense — rendering transcripts IS the product, and transcript content is
 * arbitrary model output, source code, and scraped web text.
 *
 * Story microviber-track-b-4 (spec §5): links are additionally classified
 * local vs external at render time — local links route into the Web pane
 * instead of navigating away. `sessionCwd` defaults to '' so callers that
 * only render fixed (non-relative-path) content don't need to supply one.
 */
export function SafeMarkdown({ children, sessionCwd = '' }: { children: string; sessionCwd?: string }): ReactElement {
  return (
    <Markdown
      components={{
        a: ({ href, children: linkChildren }) => {
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
