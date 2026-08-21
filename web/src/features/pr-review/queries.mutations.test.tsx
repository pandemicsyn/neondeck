// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPrReviewDraft, GitHubPullRequest } from '../../api';
import {
  newerDraftSnapshot,
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

  it('clears the live draft cache after discard returns its historical record', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          action: 'github_pr_review_draft_delete',
          changed: true,
          message: 'Discarded review draft.',
          data: { draft: reviewDraft('discarded') },
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
      await mutations!.discardDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: liveDraft.id,
        expectedRevision: liveDraft.revision,
      });
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
  });

  it('reconciles the authoritative draft returned by a CAS conflict', async () => {
    const pr = pullRequest();
    const staleDraft = reviewDraft('draft');
    const currentDraft = {
      ...staleDraft,
      body: 'Saved by the popout client.',
      updatedAt: '2026-08-19T12:00:00.000Z',
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), staleDraft);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          action: 'github_pr_review_draft_put',
          changed: false,
          message: 'The review draft changed.',
          requires: ['currentDraft'],
          data: { currentDraft },
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
        mutations!.saveDraft.mutateAsync({
          repo: pr.repo,
          number: pr.number,
          draftId: staleDraft.id,
          expectedRevision: staleDraft.revision,
          headSha: staleDraft.headSha,
          body: 'Stale local edit.',
        }),
      ).rejects.toThrow('The review draft changed.');
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      currentDraft,
    );
  });

  it('clears the live draft cache after GitHub accepts the review', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith('/review-draft')
          ? liveDraftResponse(null)
          : successfulSubmitResponse(pr),
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
        draftId: liveDraft.id,
        expectedDraftRevision: liveDraft.revision,
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

  it('cancels an active draft query before clearing its submitted cache', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    const cancellation = Promise.withResolvers<void>();
    const cancelQueries = vi
      .spyOn(queryClient, 'cancelQueries')
      .mockImplementation(() => cancellation.promise);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith('/review-draft')
          ? liveDraftResponse(null)
          : successfulSubmitResponse(pr),
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

    let submission!: Promise<unknown>;
    let submissionSettled = false;
    act(() => {
      submission = mutations!.submitReview.mutateAsync({
        draftId: liveDraft.id,
        expectedDraftRevision: liveDraft.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: null,
        verdict: 'approve',
        commentIds: ['comment-1'],
      });
      void submission.finally(() => {
        submissionSettled = true;
      });
    });

    await vi.waitFor(() => expect(cancelQueries).toHaveBeenCalledOnce());
    expect(submissionSettled).toBe(false);
    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      liveDraft,
    );

    cancellation.resolve();
    await act(async () => submission);

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
  });

  it('does not wait for the post-submit draft refresh', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    const draftRefresh = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      String(input).endsWith('/review-draft')
        ? draftRefresh.promise
        : Promise.resolve(successfulSubmitResponse(pr)),
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
        draftId: liveDraft.id,
        expectedDraftRevision: liveDraft.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: null,
        verdict: 'approve',
        commentIds: ['comment-1'],
      });
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();
    draftRefresh.resolve(liveDraftResponse(null));
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
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith('/review-draft')
          ? liveDraftResponse(null)
          : acceptedUnverifiedSubmitResponse(pr),
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
          draftId: 'draft-1',
          expectedDraftRevision: reviewDraft('draft').revision,
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
    let draftReadCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).endsWith('/review-draft')) {
        draftReadCount += 1;
        return draftReadCount === 1
          ? draftResponse
          : Promise.resolve(liveDraftResponse(null));
      }
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
        draftId: 'draft-1',
        expectedDraftRevision: reviewDraft('draft').revision,
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

  it('preserves a new draft saved while submission verification is pending', async () => {
    const pr = pullRequest();
    const submittedDraft = reviewDraft('draft');
    const newerDraft = {
      ...reviewDraft('draft'),
      id: 'draft-2',
      body: 'Summary saved during verification.',
      comments: [],
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), submittedDraft);
    let resolveSubmission!: (response: Response) => void;
    const submissionResponse = new Promise<Response>((resolve) => {
      resolveSubmission = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/reviews')) return submissionResponse;
      if (url.endsWith('/review-draft') && init?.method === 'PUT') {
        return Promise.resolve(liveDraftResponse(newerDraft));
      }
      if (url.endsWith('/review-draft')) {
        return Promise.resolve(liveDraftResponse(null));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

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

    let submission!: Promise<unknown>;
    act(() => {
      submission = mutations!.submitReview.mutateAsync({
        draftId: submittedDraft.id,
        expectedDraftRevision: submittedDraft.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: null,
        verdict: 'approve',
        commentIds: ['comment-1'],
      });
      void submission.catch(() => undefined);
    });

    await act(async () => {
      await mutations!.saveDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: newerDraft.body,
      });
    });

    resolveSubmission(acceptedUnverifiedSubmitResponse(pr));
    await act(async () => {
      await expect(submission).rejects.toThrow('could not uniquely verify');
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toMatchObject(
      {
        id: 'draft-2',
        body: 'Summary saved during verification.',
      },
    );
  });

  it('ignores an older same-draft reconciliation response after a newer save', async () => {
    const pr = pullRequest();
    const original = reviewDraft('draft');
    const newer = {
      ...original,
      body: 'Saved after the lease was released.',
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), original);
    const reconciliation = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/reviews')) {
        return Promise.resolve(uncertainSubmitResponse());
      }
      if (url.endsWith('/review-draft') && init?.method === 'PUT') {
        return Promise.resolve(liveDraftResponse(newer));
      }
      if (url.endsWith('/review-draft')) return reconciliation.promise;
      throw new Error(`Unexpected request: ${url}`);
    });

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
          draftId: original.id,
          expectedDraftRevision: original.revision,
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha!,
          body: null,
          verdict: 'approve',
          commentIds: ['comment-1'],
        }),
      ).rejects.toThrow('could not be confirmed');
    });
    await act(async () => {
      await mutations!.saveDraft.mutateAsync({
        draftId: original.id,
        expectedRevision: original.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: newer.body,
      });
    });
    reconciliation.resolve(liveDraftResponse(original));
    await act(async () => {
      await reconciliation.promise;
      await Promise.resolve();
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      newer,
    );
  });

  it('clears a discarded draft before creating the next draft', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const discardedDraft = reviewDraft('discarded');
    const nextDraft = {
      ...reviewDraft('draft'),
      id: 'draft-2',
      comments: [],
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(liveDraftResponse(discardedDraft));
      }
      if (init?.method === 'PUT') {
        return Promise.resolve(liveDraftResponse(nextDraft));
      }
      throw new Error(`Unexpected method: ${init?.method}`);
    });

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
      await mutations!.discardDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: liveDraft.id,
        expectedRevision: liveDraft.revision,
      });
    });
    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toBeNull();

    await act(async () => {
      await mutations!.saveDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        verdict: 'approve',
      });
    });
    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toMatchObject(
      { id: 'draft-2', status: 'draft' },
    );
  });

  it('preserves a replacement draft that arrives before discard settles', async () => {
    const pr = pullRequest();
    const original = reviewDraft('draft');
    const discarded = reviewDraft('discarded');
    const replacement = {
      ...original,
      id: 'draft-2',
      body: 'Created by reviewer chat after discard.',
      comments: [],
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), original);
    const discardResponse = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => discardResponse.promise,
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

    let discarding!: Promise<unknown>;
    act(() => {
      discarding = mutations!.discardDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: original.id,
        expectedRevision: original.revision,
      });
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    act(() => {
      queryClient.setQueryData(prReviewQueryKeys.draft(pr), replacement);
    });
    discardResponse.resolve(liveDraftResponse(discarded));
    await act(async () => discarding);

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      replacement,
    );
  });

  it('does not replace a newer draft with a delayed explicit-draft save', async () => {
    const pr = pullRequest();
    const original = reviewDraft('draft');
    const replacement = {
      ...original,
      id: 'draft-2',
      body: 'Replacement draft.',
      comments: [],
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), original);
    const saveResponse = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => saveResponse.promise,
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

    let saving!: Promise<unknown>;
    act(() => {
      saving = mutations!.saveDraft.mutateAsync({
        draftId: original.id,
        expectedRevision: original.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: 'Delayed save.',
      });
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    act(() => {
      queryClient.setQueryData(prReviewQueryKeys.draft(pr), replacement);
    });
    saveResponse.resolve(
      liveDraftResponse({
        ...original,
        body: 'Delayed save.',
        updatedAt: '2026-08-18T03:15:30.000Z',
      }),
    );
    await act(async () => saving);

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      replacement,
    );
  });

  it('keeps a newer draft snapshot when mutation responses arrive out of order', () => {
    const older = reviewDraft('draft');
    const newer = {
      ...older,
      body: 'Newest body',
      revision: older.revision + 1,
      updatedAt: '2026-08-18T03:16:00.000Z',
    } satisfies GitHubPrReviewDraft;

    expect(newerDraftSnapshot(newer, older)).toBe(newer);
    expect(newerDraftSnapshot(older, newer)).toBe(newer);
    const higherRevisionWithOlderMetadata = {
      ...older,
      body: 'Revision wins for the same draft.',
      revision: older.revision + 1,
      updatedAt: '2026-08-18T03:14:00.000Z',
    } satisfies GitHubPrReviewDraft;
    expect(newerDraftSnapshot(older, higherRevisionWithOlderMetadata)).toBe(
      higherRevisionWithOlderMetadata,
    );
    expect(
      newerDraftSnapshot({ ...newer, revision: older.revision }, older),
    ).toMatchObject({ body: 'Newest body' });
    expect(
      newerDraftSnapshot(
        { ...newer, id: 'replacement-draft' },
        { ...older, id: 'delayed-original-draft' },
      ),
    ).toMatchObject({ id: 'replacement-draft' });
  });

  it('does not move the cross-draft frontier backward for a newer revision', async () => {
    const pr = pullRequest();
    const original = reviewDraft('draft');
    const higherRevision = {
      ...original,
      body: 'Higher revision with older metadata.',
      revision: original.revision + 1,
      updatedAt: '2026-08-18T03:14:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const delayedReplacement = {
      ...original,
      id: 'delayed-replacement',
      body: 'Older replacement response.',
      revision: 1,
      updatedAt: '2026-08-18T03:14:30.000Z',
    } satisfies GitHubPrReviewDraft;
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), original);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(liveDraftResponse(higherRevision))
      .mockResolvedValueOnce(liveDraftResponse(delayedReplacement));

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
      await mutations!.saveDraft.mutateAsync({
        draftId: original.id,
        expectedRevision: original.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: higherRevision.body,
      });
      await mutations!.saveDraft.mutateAsync({
        expectedAbsent: true,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: delayedReplacement.body,
      });
    });

    expect(queryClient.getQueryData(prReviewQueryKeys.draft(pr))).toEqual(
      higherRevision,
    );
  });

  it('does not restore an older save response after discard completes', async () => {
    const pr = pullRequest();
    const liveDraft = reviewDraft('draft');
    const discardedDraft = {
      ...reviewDraft('discarded'),
      updatedAt: '2026-08-18T03:17:00.000Z',
    } satisfies GitHubPrReviewDraft;
    const delayedSave = Promise.withResolvers<Response>();
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), liveDraft);
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.method === 'PUT') return delayedSave.promise;
      if (init?.method === 'DELETE') {
        return Promise.resolve(liveDraftResponse(discardedDraft));
      }
      throw new Error(`Unexpected method: ${init?.method}`);
    });

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

    let save!: Promise<unknown>;
    act(() => {
      save = mutations!.saveDraft.mutateAsync({
        draftId: liveDraft.id,
        expectedRevision: liveDraft.revision,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha!,
        body: 'Older save',
      });
      void save.catch(() => undefined);
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());

    await act(async () => {
      await mutations!.discardDraft.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: liveDraft.id,
        expectedRevision: liveDraft.revision,
      });
    });
    delayedSave.resolve(liveDraftResponse(liveDraft));
    await act(async () => save);

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

function acceptedUnverifiedSubmitResponse(pr: GitHubPullRequest) {
  return new Response(
    JSON.stringify({
      ok: false,
      action: 'github_pr_review_post',
      changed: true,
      message:
        'Submitted PR review but could not uniquely verify its durable delivery identity.',
      data: {
        draft: reviewDraft('submitted'),
        review: submittedReview(pr),
      },
      requires: ['deliveryIdentity'],
    }),
    {
      status: 409,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function uncertainSubmitResponse() {
  return new Response(
    JSON.stringify({
      ok: false,
      action: 'github_pr_review_post',
      changed: true,
      message:
        'GitHub review submission could not be confirmed. Reconcile before retrying.',
      data: { code: 'submission-uncertain' },
      requires: ['submissionReconciliation'],
    }),
    {
      status: 409,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function liveDraftResponse(draft: GitHubPrReviewDraft | null) {
  return new Response(
    JSON.stringify({
      ok: true,
      action: 'github_pr_review_draft_get',
      changed: false,
      message: draft ? 'Fetched review draft.' : 'No review draft.',
      data: { draft },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function submittedReview(pr: GitHubPullRequest) {
  return {
    id: 123,
    nodeId: 'PRR_123',
    state: 'APPROVED',
    authorLogin: 'pandemicsyn',
    submittedAt: '2026-08-18T03:15:00.000Z',
    commitId: pr.headSha,
    url: `${pr.url}#pullrequestreview-123`,
    body: null,
  };
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
    revision: 1,
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
