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

  // Final whole-branch review, Finding 2: SafeMarkdown now supplies a custom
  // `urlTransform` (to let file:// through — see below) instead of relying
  // on react-markdown's built-in default. This proves the T7 defense still
  // holds under the custom transform, not just the default one.
  it('still strips data: and vbscript: URLs after the file:// allowance', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'[a](data:text/html,x) [b](vbscript:x)'}</SafeMarkdown>);
    expect(html.toLowerCase()).not.toContain('data:text/html');
    expect(html.toLowerCase()).not.toContain('vbscript:');
  });

  // Final whole-branch review, Finding 2 (IMPORTANT): react-markdown's
  // default urlTransform only allows https?|ircs?|mailto|xmpp, so file://
  // links were silently stripped to href="" before ever reaching
  // link-classify.ts's localfile branch — spec AC1's file:// support was
  // dead code in the real product despite passing in link-classify.test.ts's
  // direct unit tests.
  it('lets a file:// link through, unlike javascript:/data:', () => {
    const html = renderToStaticMarkup(<SafeMarkdown sessionCwd="/proj">{'[spec](file:///Users/you/spec.md)'}</SafeMarkdown>);
    expect(html).toContain('file:///Users/you/spec.md');
  });
  it('still renders ordinary markdown (bold, code, lists)', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'**bold** `code`\n\n1. one\n2. two'}</SafeMarkdown>);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ol');
  });
});
