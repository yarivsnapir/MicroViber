import { describe, it, expect } from 'vitest';
import { classifyLink } from '../src/lib/link-classify.js';

describe('classifyLink (story microviber-track-b-4, spec §5)', () => {
  it('classifies an http://localhost:<port> link as devserver, preserving the path', () => {
    expect(classifyLink('http://localhost:9005/scenarios/42', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/scenarios/42' });
  });
  it('classifies https://localhost too — scheme does not matter', () => {
    expect(classifyLink('https://localhost:9005/', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/' });
  });
  it('classifies 127.0.0.1 the same as localhost', () => {
    expect(classifyLink('http://127.0.0.1:9008/health', '/proj')).toEqual({ kind: 'devserver', port: 9008, path: '/health' });
  });
  it('defaults devserver path to "/" when the URL has no trailing path', () => {
    expect(classifyLink('http://localhost:9005', '/proj')).toEqual({ kind: 'devserver', port: 9005, path: '/' });
  });
  it('classifies a file:// URI as localfile, used as-is', () => {
    expect(classifyLink('file:///Users/you/spec.md', '/proj')).toEqual({ kind: 'localfile', path: '/Users/you/spec.md' });
  });
  it('classifies an absolute bare path as localfile, used as-is', () => {
    expect(classifyLink('/Users/you/mockup.html', '/proj')).toEqual({ kind: 'localfile', path: '/Users/you/mockup.html' });
  });
  it('classifies a relative bare path as localfile, resolved against sessionCwd', () => {
    expect(classifyLink('docs/spec.md', '/proj')).toEqual({ kind: 'localfile', path: '/proj/docs/spec.md' });
  });
  it('resolves a relative path against sessionCwd even when sessionCwd has a trailing slash', () => {
    expect(classifyLink('docs/spec.md', '/proj/')).toEqual({ kind: 'localfile', path: '/proj/docs/spec.md' });
  });
  it('classifies a real external URL as external', () => {
    expect(classifyLink('https://github.com/yarivsnapir/MicroViber/pull/1', '/proj')).toEqual({ kind: 'external', href: 'https://github.com/yarivsnapir/MicroViber/pull/1' });
  });
});
