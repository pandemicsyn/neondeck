// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readReviewBriefingRoute } from './App';

describe('review briefing route', () => {
  it('reads a review id for the standalone client route', () => {
    expect(
      readReviewBriefingRoute({
        pathname: '/review-briefing',
        search: '?id=review%3A123',
      }),
    ).toEqual({ kind: 'target', reviewId: 'review:123' });
  });

  it('rejects a standalone briefing route without an id', () => {
    expect(
      readReviewBriefingRoute({ pathname: '/review-briefing', search: '' }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      readReviewBriefingRoute({ pathname: '/review', search: '' }),
    ).toEqual({ kind: 'none' });
  });
});
