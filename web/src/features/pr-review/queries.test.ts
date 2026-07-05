import { describe, expect, it } from 'vitest';
import type { GitHubPullRequest } from '../../api';
import { prReviewQueryKeys } from './queries';

describe('prReviewQueryKeys', () => {
  it('includes PR revision fields in files and review thread keys', () => {
    const pr = pullRequest();
    const updated = {
      ...pr,
      headSha: 'head-2',
      updatedAt: '2026-07-05T02:30:00.000Z',
    };

    expect(prReviewQueryKeys.files(pr)).not.toEqual(
      prReviewQueryKeys.files(updated),
    );
    expect(prReviewQueryKeys.reviewThreads(pr)).not.toEqual(
      prReviewQueryKeys.reviewThreads(updated),
    );
    expect(prReviewQueryKeys.draft(pr)).toEqual(
      prReviewQueryKeys.draft(updated),
    );
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
    baseRef: 'agent/diff-ui-pr1',
    checks: null,
  };
}
