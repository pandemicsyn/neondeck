import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type {
  GitHubPullRequest,
  GitHubPullRequestReviewThread,
} from '../../api';
import {
  invalidateSubmittedReviewQueries,
  prReviewQueryKeys,
  shouldRefreshReviewThreads,
  upsertReviewThread,
} from './queries';

describe('prReviewQueryKeys', () => {
  it('keys files by diff inputs and mutable threads by PR identity', () => {
    const pr = pullRequest();
    const activityUpdated = {
      ...pr,
      updatedAt: '2026-07-05T02:30:00.000Z',
    };
    const headUpdated = { ...activityUpdated, headSha: 'head-2' };
    const baseUpdated = { ...activityUpdated, baseSha: 'base-2' };

    expect(prReviewQueryKeys.files(pr)).not.toEqual(
      prReviewQueryKeys.files(headUpdated),
    );
    expect(prReviewQueryKeys.files(pr)).not.toEqual(
      prReviewQueryKeys.files(baseUpdated),
    );
    expect(prReviewQueryKeys.fileList(pr)).not.toEqual(
      prReviewQueryKeys.fileList(baseUpdated),
    );
    expect(prReviewQueryKeys.filePatch(pr, 'src/app.ts')).not.toEqual(
      prReviewQueryKeys.filePatch(baseUpdated, 'src/app.ts'),
    );
    expect(prReviewQueryKeys.reviewThreads(pr)).toEqual(
      prReviewQueryKeys.reviewThreads(headUpdated),
    );
    expect(prReviewQueryKeys.reviewThreads(pr)).toEqual(
      prReviewQueryKeys.reviewThreads(activityUpdated),
    );
    expect(prReviewQueryKeys.files(pr)).toEqual(
      prReviewQueryKeys.files(activityUpdated),
    );
    expect(prReviewQueryKeys.filePatch(pr, 'src/app.ts')).toEqual(
      prReviewQueryKeys.filePatch(activityUpdated, 'src/app.ts'),
    );
    expect(prReviewQueryKeys.draft(pr)).toEqual(
      prReviewQueryKeys.draft(activityUpdated),
    );
  });

  it('refreshes threads only after authoritative activity changes', () => {
    const initial = {
      repo: 'pandemicsyn/neondeck',
      number: 66,
      activityVersion: null,
    };
    const authoritative = {
      ...initial,
      activityVersion: '2026-07-05T02:00:00.000Z',
    };
    const activityUpdated = {
      ...authoritative,
      activityVersion: '2026-07-05T02:30:00.000Z',
    };

    expect(shouldRefreshReviewThreads(initial, authoritative)).toBe(false);
    expect(shouldRefreshReviewThreads(authoritative, authoritative)).toBe(
      false,
    );
    expect(shouldRefreshReviewThreads(authoritative, activityUpdated)).toBe(
      true,
    );
    expect(
      shouldRefreshReviewThreads(authoritative, {
        ...activityUpdated,
        number: 67,
      }),
    ).toBe(false);
  });

  it('splices returned review threads into cached thread data', () => {
    const existing = reviewThread({ id: 'thread-1', isResolved: false });
    const other = reviewThread({ id: 'thread-2', isResolved: false });
    const updated = reviewThread({ id: 'thread-1', isResolved: true });

    expect(
      upsertReviewThread(
        {
          reviewThreads: [existing, other],
          reviewThreadsTruncated: false,
          unresolvedReviewThreads: [existing, other],
        },
        updated,
      ),
    ).toEqual({
      reviewThreads: [updated, other],
      reviewThreadsTruncated: false,
      unresolvedReviewThreads: [other],
    });
  });

  it('invalidates durable review state and the review inbox after submit', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await invalidateSubmittedReviewQueries(client, pullRequest());

    expect(invalidate).toHaveBeenCalledWith({
      exact: true,
      queryKey: ['pr-reviews', 'pandemicsyn/neondeck', 66],
    });
    expect(invalidate).toHaveBeenCalledWith({
      exact: true,
      queryKey: ['pr-reviews'],
    });
  });
});

function pullRequest(): GitHubPullRequest {
  return {
    id: 66,
    title: 'Add GitHub PR diff review',
    repo: 'pandemicsyn/neondeck',
    number: 66,
    url: 'https://github.com/pandemicsyn/neondeck/pull/66',
    state: 'open',
    author: 'pandemicsyn',
    labels: [],
    comments: 0,
    updatedAt: '2026-07-05T02:00:00.000Z',
    createdAt: '2026-07-05T01:00:00.000Z',
    relations: ['configured-repo'],
    ageDays: 0,
    stale: false,
    headSha: 'head-1',
    baseSha: 'base-1',
    baseRef: 'agent/diff-ui-pr1',
    checks: null,
  };
}

function reviewThread(
  input: Pick<GitHubPullRequestReviewThread, 'id' | 'isResolved'>,
): GitHubPullRequestReviewThread {
  return {
    id: input.id,
    isResolved: input.isResolved,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    originalLine: null,
    diffSide: 'RIGHT',
    pullRequestRepo: 'pandemicsyn/neondeck',
    pullRequestNumber: 66,
    comments: [],
  };
}
