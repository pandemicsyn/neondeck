import { categoryWatermark } from '../modules/pr-events';
import type { PrWatchInitialEventBaselineFetcher } from '../modules/watches';

export const emptyPrWatchInitialEventBaseline: PrWatchInitialEventBaselineFetcher =
  async (_watch, watchId) => [
    categoryWatermark(watchId, 'commits', null, {
      headSha: null,
      total: 0,
      truncated: false,
      shas: [],
    }),
    categoryWatermark(watchId, 'review_threads', null, {
      total: 0,
      truncated: false,
      unresolvedThreadIds: [],
      threads: [],
    }),
    categoryWatermark(watchId, 'requested_changes_reviews', null, {
      total: 0,
      truncated: false,
      reviewIds: [],
      reviews: [],
    }),
    categoryWatermark(watchId, 'conversation_comments', null, {
      total: 0,
      truncated: false,
      comments: [],
    }),
    categoryWatermark(watchId, 'check_suites', null, {
      total: 0,
      truncated: false,
      failingSuiteIds: [],
      pendingSuiteIds: [],
      suites: [],
    }),
    categoryWatermark(watchId, 'check_runs', null, {
      total: 0,
      truncated: false,
      failingRunIds: [],
      pendingRunIds: [],
      runs: [],
    }),
    categoryWatermark(watchId, 'mergeability', null, {}),
    categoryWatermark(watchId, 'out_of_date_branch', null, {}),
  ];
