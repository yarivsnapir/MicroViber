import { describe, it, expect } from 'vitest';
import { identity, DAEMON_NAME } from '../src/version.js';

describe('daemon identity', () => {
  it('reports its name and version', () => {
    expect(identity()).toEqual({ name: DAEMON_NAME, version: '0.0.0' });
  });
});
