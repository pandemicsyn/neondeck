import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPullRequestReviewDecision,
  isOutOfDateMergeState,
  isOutOfDateState,
} from './pull-requests';

afterEach(() => vi.restoreAllMocks());

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

describe('GitHub pull request review decision', () => {
  it('reads the aggregate branch-protection-aware decision', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: { reviewDecision: 'APPROVED' },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      fetchPullRequestReviewDecision({
        token: 'github-token',
        owner: 'Acme-Org',
        repo: 'cloud',
        number: 4722,
      }),
    ).resolves.toBe('APPROVED');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
