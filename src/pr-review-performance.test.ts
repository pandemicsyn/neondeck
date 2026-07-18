import { describe, expect, it } from 'vitest';
import {
  createReviewPerformanceFixture,
  measureReviewPerformanceFixture,
  reviewPerformanceFixtureProfiles,
} from './testing/review-performance-fixtures';

const warmTargets = {
  treeVisibleMs: 500,
  firstPatchMs: 1_000,
  threadsVisibleMs: 500,
};

describe('PR review performance harness', () => {
  it.each(reviewPerformanceFixtureProfiles)(
    'measures the $id fixture against warm review targets',
    async (profile) => {
      const fixture = await createReviewPerformanceFixture(profile);
      try {
        const timing = await measureReviewPerformanceFixture(fixture, 3);

        expect(timing.fileCount).toBe(profile.fileCount);
        expect(timing.threadCount).toBe(profile.annotationCount);
        expect(timing.treeVisibleMs).toHaveLength(3);
        expect(timing.firstPatchMs).toHaveLength(3);
        expect(timing.threadsVisibleMs).toHaveLength(3);
        expect(timing.treeVisibleMedianMs).toBeGreaterThanOrEqual(0);
        expect(timing.firstPatchMedianMs).toBeGreaterThanOrEqual(0);
        expect(timing.threadsVisibleMedianMs).toBeGreaterThanOrEqual(0);
        expect(timing.treeVisibleMedianMs < warmTargets.treeVisibleMs).toEqual(
          expect.any(Boolean),
        );
        expect(timing.firstPatchMedianMs < warmTargets.firstPatchMs).toEqual(
          expect.any(Boolean),
        );
        expect(
          timing.threadsVisibleMedianMs < warmTargets.threadsVisibleMs,
        ).toEqual(expect.any(Boolean));
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );
});
