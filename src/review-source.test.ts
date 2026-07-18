import { describe, expect, it } from 'vitest';
import {
  resolvedReviewRevision,
  reviewRevisionKey,
  unavailableReviewRevision,
} from '../shared/review-source';

describe('review source revision contract', () => {
  it('keys resolved revisions by kind, base, and immutable identity', () => {
    expect(
      reviewRevisionKey(
        resolvedReviewRevision({
          kind: 'worktree-diff',
          id: 'tree-sha',
          baseId: 'base-sha',
        }),
      ),
    ).toBe('worktree-diff:base-sha:tree-sha');
  });

  it('does not invent an identity for unavailable revisions', () => {
    expect(
      reviewRevisionKey(
        unavailableReviewRevision('git-commit', 'Head SHA is unavailable.'),
      ),
    ).toBeNull();
  });
});
