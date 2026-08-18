// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPrReviewDraft, GitHubPullRequest } from '../../api';
import {
  prReviewQueryKeys,
  useGitHubPrReviewDraft,
  useGitHubPrReviewMutations,
} from './queries';

describe('useGitHubPrReviewMutations', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('clears the live draft cache after GitHub accepts the review', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const submittedDraft = reviewDraft('submitted');
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          action: 'github_pr_review_post',
          changed: true,
          message: 'Submitted PR review.',
          data: {
            draft: submittedDraft,
            review: {
              id: 123,
              nodeId: 'PRR_123',
              state: 'APPROVED',
              authorLogin: 'pandemicsyn',
              submittedAt: '2026-08-18T03:15:00.000Z',
              commitId: pr.headSha,
              url: `${pr.url}#pullrequestreview-123`,
              body: null,
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    let mutations: ReturnType<typeof useGitHubPrReviewMutations> | null = null;
    function Harness() {
      mutations = useGitHubPrReviewMutations(pr);
      return null;
    }

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      ),
    );

    await act(async () => {
      await mutations!.submitReview.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: null,
        verdict: 'approve',
        commentIds: ['comment-1'],
      });
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
    expect(cancelQueries).toHaveBeenCalledWith({
      exact: true,
      queryKey: prReviewQueryKeys.draft(pr),
    });
  });

  it('clears the draft when GitHub accepted a review that Neondeck could not verify', async () => {
    const pr = pullRequest();
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), reviewDraft('draft'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          action: 'github_pr_review_post',
          changed: true,
          message:
            'Submitted PR review but could not uniquely verify its durable delivery identity.',
          data: {
            draft: reviewDraft('submitted'),
            review: {
              id: 123,
              nodeId: 'PRR_123',
              state: 'APPROVED',
              authorLogin: 'pandemicsyn',
              submittedAt: '2026-08-18T03:15:00.000Z',
              commitId: pr.headSha,
              url: `${pr.url}#pullrequestreview-123`,
              body: null,
            },
          },
          requires: ['deliveryIdentity'],
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    let mutations: ReturnType<typeof useGitHubPrReviewMutations> | null = null;
    function Harness() {
      mutations = useGitHubPrReviewMutations(pr);
      return null;
    }

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      ),
    );

    await act(async () => {
      await expect(
        mutations!.submitReview.mutateAsync({
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha!,
          body: null,
          verdict: 'approve',
          commentIds: ['comment-1'],
        }),
      ).rejects.toThrow('could not uniquely verify');
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
  });

  it('ignores a draft response that was already in flight when submission completed', async () => {
    const pr = pullRequest();
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    let resolveDraftResponse!: (response: Response) => void;
    const draftResponse = new Promise<Response>((resolve) => {
      resolveDraftResponse = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).endsWith('/review-draft')) return draftResponse;
      return Promise.resolve(successfulSubmitResponse(pr));
    });

    let mutations: ReturnType<typeof useGitHubPrReviewMutations> | null = null;
    function Harness() {
      useGitHubPrReviewDraft(pr);
      mutations = useGitHubPrReviewMutations(pr);
      return null;
    }

    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      ),
    );

    await act(async () => {
      await mutations!.submitReview.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: null,
        verdict: 'approve',
        commentIds: ['comment-1'],
      });
    });

    await act(async () => {
      resolveDraftResponse(
        new Response(
          JSON.stringify({
            ok: true,
            action: 'github_pr_review_draft_get',
            changed: false,
            message: 'Fetched review draft.',
            data: { draft: reviewDraft('draft') },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
      await draftResponse;
      await Promise.resolve();
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
  });
});

function successfulSubmitResponse(pr: GitHubPullRequest) {
  return new Response(
    JSON.stringify({
      ok: true,
      action: 'github_pr_review_post',
      changed: true,
      message: 'Submitted PR review.',
      data: {
        draft: reviewDraft('submitted'),
        review: {
          id: 123,
          nodeId: 'PRR_123',
          state: 'APPROVED',
          authorLogin: 'pandemicsyn',
          submittedAt: '2026-08-18T03:15:00.000Z',
          commitId: pr.headSha,
          url: `${pr.url}#pullrequestreview-123`,
          body: null,
        },
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

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
    updatedAt: '2026-08-18T03:00:00.000Z',
    createdAt: '2026-08-18T02:00:00.000Z',
    relations: ['configured-repo'],
    ageDays: 0,
    stale: false,
    headSha: 'head-1',
    baseSha: 'base-1',
    baseRef: 'main',
    checks: null,
  };
}

function reviewDraft(
  status: GitHubPrReviewDraft['status'],
): GitHubPrReviewDraft {
  return {
    id: 'draft-1',
    repo: 'pandemicsyn/neondeck',
    prNumber: 66,
    headSha: 'head-1',
    verdict: 'approve',
    body: null,
    status,
    createdAt: '2026-08-18T03:00:00.000Z',
    updatedAt: '2026-08-18T03:15:00.000Z',
    submittedAt: status === 'submitted' ? '2026-08-18T03:15:00.000Z' : null,
    comments: [
      {
        id: 'comment-1',
        draftId: 'draft-1',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 12,
        startLine: null,
        startSide: null,
        body: 'Please check this helper.',
        origin: 'neon',
        createdAt: '2026-08-18T03:00:00.000Z',
        updatedAt: '2026-08-18T03:00:00.000Z',
      },
    ],
  };
}
