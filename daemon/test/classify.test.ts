import { describe, it, expect } from 'vitest';
import { classifyHost, isSupportedProtocol, SUPPORTED_PEER_PROTOCOL } from '../src/lib/claude-adapter/classify.js';

describe('classifyHost', () => {
  it('claude-vscode entrypoint => vscode', () => {
    expect(classifyHost({ entrypoint: 'claude-vscode', peerFeatures: ['notify_idle'] })).toBe('vscode');
  });
  it('cli entrypoint => terminal', () => {
    expect(classifyHost({ entrypoint: 'cli' })).toBe('terminal');
  });
  it('unknown entrypoint falls back to peerFeatures corroboration', () => {
    expect(classifyHost({ entrypoint: 'other', peerFeatures: ['notify_idle'] })).toBe('vscode');
    expect(classifyHost({ entrypoint: 'other' })).toBe('terminal');
  });
});

describe('isSupportedProtocol', () => {
  it('accepts the supported protocol', () => {
    expect(isSupportedProtocol(SUPPORTED_PEER_PROTOCOL)).toBe(true);
  });
  it('rejects any other protocol number (fail closed)', () => {
    expect(isSupportedProtocol(2)).toBe(false);
    expect(isSupportedProtocol(0)).toBe(false);
  });
});
