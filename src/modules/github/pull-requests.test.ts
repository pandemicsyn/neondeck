import { describe, expect, it } from 'vitest';
import { isOutOfDateMergeState } from './pull-requests';

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
