import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../src/lib/markdown.js';

/** T7: the highest-likelihood bug in the project. Adversarial transcript content must never execute. */
describe('SafeMarkdown (T7)', () => {
  it('does not emit a live <script> tag', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'hello <script>alert(1)</script> world'}</SafeMarkdown>);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)</script'); // no executable script element
  });
  it('renders raw HTML as inert escaped text, not a live element', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'<img src=x onerror="alert(1)">'}</SafeMarkdown>);
    expect(/<img[ >]/i.test(html)).toBe(false); // no LIVE img element
    expect(html).toContain('&lt;img');          // escaped to inert text
  });
  it('strips javascript: URLs from links', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'[click](javascript:alert(1))'}</SafeMarkdown>);
    expect(html.toLowerCase()).not.toContain('javascript:alert');
  });
  it('still renders ordinary markdown (bold, code, lists)', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'**bold** `code`\n\n1. one\n2. two'}</SafeMarkdown>);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ol');
  });
});
