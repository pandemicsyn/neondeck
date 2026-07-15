import { describe, expect, it } from 'vitest';
import { isOutOfDateMergeState, isOutOfDateState } from './pull-requests';

describe('GitHub pull request merge state', () => {
  it.each([
    ['behind', true],
    ['blocked', false],
    ['dirty', false],
    ['clean', false],
    ['unstable', false],
    [null, false],
  ] as const)('maps %s to isOutOfDate=%s', (state, expected) => {
    expect(isOutOfDateMergeState(state)).toBe(expected);
  });
});

describe('GitHub pull request base comparison', () => {
  it('uses compare behind-by as the authoritative out-of-date signal', () => {
    expect(isOutOfDateState(2, 'blocked')).toBe(true);
    expect(isOutOfDateState(0, 'behind')).toBe(false);
  });

  it('falls back to mergeable state when comparison is unavailable', () => {
    expect(isOutOfDateState(null, 'behind')).toBe(true);
    expect(isOutOfDateState(null, 'blocked')).toBe(false);
  });
});
