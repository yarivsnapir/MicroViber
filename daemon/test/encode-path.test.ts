import { describe, it, expect } from 'vitest';
import { encodeProjectDir } from '../src/lib/claude-adapter/encode-path.js';

describe('encodeProjectDir', () => {
  it('maps / to -', () => {
    expect(encodeProjectDir('/Users/dev/my-project')).toBe('-Users-dev-my-project');
  });
  // MANDATORY: the _ rule. Getting this wrong yields silent "transcript not found"
  // for every user or folder containing an underscore (findings I1).
  it('maps underscore to -', () => {
    expect(encodeProjectDir('/Users/dev_user/proj')).toBe('-Users-dev-user-proj');
  });
  it('maps . to -', () => {
    expect(encodeProjectDir('/Users/dev/My.Project')).toBe('-Users-dev-My-Project');
  });
  it('handles all three together', () => {
    expect(encodeProjectDir('/home/a_b/x.y/z')).toBe('-home-a-b-x-y-z');
  });
});
