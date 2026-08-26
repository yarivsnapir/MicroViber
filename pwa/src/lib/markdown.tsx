import Markdown from 'react-markdown';
import type { ReactElement } from 'react';

/**
 * Safe transcript markdown. react-markdown renders to a React tree and does
 * NOT use innerHTML; raw HTML in content is inert (we never add rehype-raw),
 * and javascript: URLs are stripped by the default URL transform. This is the
 * T7 defense — rendering transcripts IS the product, and transcript content is
 * arbitrary model output, source code, and scraped web text.
 */
export function SafeMarkdown({ children }: { children: string }): ReactElement {
  return <Markdown>{children}</Markdown>;
}
