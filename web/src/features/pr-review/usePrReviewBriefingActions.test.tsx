// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type {
  GitHubPrReviewDraft,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
} from '../../api';

const mutationHook = vi.hoisted(() => ({
  useGitHubPrReviewMutations: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getPrReview: vi.fn(),
  reconcilePrReviewSubmission: vi.fn(),
}));

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  getPrReview: api.getPrReview,
  reconcilePrReviewSubmission: api.reconcilePrReviewSubmission,
}));

vi.mock('./queries', () => ({
  prReviewQueryKeys: {
    draft: ({ number, repo }: { number: number; repo: string }) => [
      'pr-review',
      'draft',
      repo,
      number,
    ],
  },
  useGitHubPrReviewMutations: mutationHook.useGitHubPrReviewMutations,
}));

import {
  synchronizePrReviewSubmissionLock,
  usePrReviewBriefingActions,
} from './usePrReviewBriefingActions';

describe('usePrReviewBriefingActions', () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    api.getPrReview.mockResolvedValue({
      review: reviewFixture('submitted'),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('uses authoritative draft revisions for edit, dismiss, promote, and submit', async () => {
    const initialDraft = draftFixture(1);
    const editedDraft = draftFixture(2);
    const dismissedDraft = draftFixture(3);
    const promotedDraft = draftFixture(4);
    const settledDraft = {
      ...promotedDraft,
      body: 'Ship it.',
      verdict: 'approve' as const,
      revision: 5,
    };
    const mutations = mutationFixture();
    mutations.updateComment.mutateAsync.mockResolvedValue(editedDraft);
    mutations.deleteComment.mutateAsync.mockResolvedValue(dismissedDraft);
    mutations.addComment.mutateAsync.mockResolvedValue(promotedDraft);
    mutations.saveDraft.mutateAsync.mockResolvedValue(settledDraft);
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    const refetch = vi.fn(async () => ({ data: promotedDraft }));
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;

    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: initialDraft,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await act(async () => {
      await actions!.editComment('comment-1', '  Human wording.  ');
      await actions!.dismissComment('comment-1');
      await actions!.promoteFinding(findingFixture(), '  Promoted wording.  ');
      await actions!.submitApproval('  Ship it.  ');
    });

    expect(mutations.updateComment.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, body: 'Human wording.' }),
    );
    expect(mutations.deleteComment.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
    );
    expect(mutations.addComment.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        body: 'Promoted wording.',
        line: 24,
        side: 'LEFT',
        sourceFindingId: 'finding-2',
      }),
    );
    expect(mutations.saveDraft.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Ship it.',
        expectedRevision: 4,
        verdict: 'approve',
      }),
    );
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Ship it.',
        commentIds: ['comment-1'],
        expectedDraftRevision: 5,
        verdict: 'approve',
      }),
    );
  });

  it('does not promote a file-level note without a changed line', async () => {
    const mutations = mutationFixture();
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: draftFixture(1),
        refetch: vi.fn(),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(
      actions!.promoteFinding({ ...findingFixture(), line: null }),
    ).rejects.toThrow('changed-line anchor');
    expect(mutations.addComment.mutateAsync).not.toHaveBeenCalled();
  });

  it('locks all draft mutations while a no-draft submission crosses its barrier', async () => {
    const mutations = mutationFixture();
    const createdDraft = draftFixture(1);
    const settledDraft = { ...createdDraft, revision: 2 };
    mutations.saveDraft.mutateAsync.mockResolvedValue(settledDraft);
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    const barrier = deferred<{ data: GitHubPrReviewDraft | null }>();
    const refetch = vi.fn(() => barrier.promise);
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: null,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    const submission = actions!.submitApproval('');
    await actions!.submitApproval('duplicate');
    await expect(
      actions!.editComment('comment-1', 'late edit'),
    ).rejects.toThrow('already in progress');
    await expect(actions!.promoteFinding(findingFixture())).rejects.toThrow(
      'already in progress',
    );
    expect(mutations.saveDraft.mutateAsync).not.toHaveBeenCalled();
    barrier.resolve({ data: null });
    await act(async () => submission);

    expect(mutations.saveDraft.mutateAsync).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
    expect(mutations.addComment.mutateAsync).not.toHaveBeenCalled();
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();
  });

  it('shares the submission barrier between the panel row and briefing surfaces', async () => {
    const mutations = mutationFixture();
    const settledDraft = { ...draftFixture(1), revision: 2 };
    mutations.saveDraft.mutateAsync.mockResolvedValue(settledDraft);
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    const barrier = deferred<{ data: GitHubPrReviewDraft | null }>();
    const draftQuery = { data: null, refetch: vi.fn(() => barrier.promise) };
    let rowActions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    let briefingActions: ReturnType<typeof usePrReviewBriefingActions> | null =
      null;
    function Harness() {
      rowActions = usePrReviewBriefingActions(
        reviewFixture(),
        draftQuery as never,
      );
      briefingActions = usePrReviewBriefingActions(
        reviewFixture(),
        draftQuery as never,
      );
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    let submission!: Promise<unknown>;
    act(() => {
      submission = rowActions!.submitApproval('');
    });
    await act(async () => Promise.resolve());

    expect(briefingActions!.busy).toBe(true);
    await briefingActions!.submitApproval('duplicate');
    await expect(
      briefingActions!.promoteFinding(findingFixture()),
    ).rejects.toThrow('already in progress');
    barrier.resolve({ data: null });
    await act(async () => submission);

    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();
    expect(draftQuery.refetch).toHaveBeenCalledOnce();
  });

  it('keeps the cross-surface lock while authoritative state is submitting', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    const submitBarrier = deferred<unknown>();
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockImplementation(
      () => submitBarrier.promise,
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
    let rowActions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    let staleBriefingActions: ReturnType<
      typeof usePrReviewBriefingActions
    > | null = null;
    function Harness() {
      rowActions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      staleBriefingActions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    let submission!: Promise<unknown>;
    act(() => {
      submission = rowActions!.submitApproval('');
    });
    await vi.waitFor(() =>
      expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce(),
    );
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitting')));

    expect(staleBriefingActions!.submitting).toBe(true);
    await staleBriefingActions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    submitBarrier.resolve({});
    await act(async () => submission);
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitted')));
    expect(staleBriefingActions!.submitting).toBe(false);
  });

  it('shares and accumulates rejected comments across submission surfaces', async () => {
    const mutations = mutationFixture();
    let draft = {
      ...draftFixture(1),
      comments: [
        draftFixture(1).comments[0],
        {
          ...draftFixture(1).comments[0],
          id: 'comment-2',
          body: 'Second draft body',
        },
      ],
    };
    mutations.saveDraft.mutateAsync.mockImplementation(async () => {
      draft = { ...draft, revision: draft.revision + 1 };
      return draft;
    });
    mutations.submitReview.mutateAsync
      .mockRejectedValueOnce(
        new ApiError('One inline comment was rejected.', 422, '/review', {
          ok: false,
          changed: false,
          data: {
            code: 'github-review-submit-failed',
            failingCommentIds: ['comment-1'],
          },
        }),
      )
      .mockRejectedValueOnce(
        new ApiError('Another inline comment was rejected.', 422, '/review', {
          ok: false,
          changed: false,
          data: {
            code: 'github-review-submit-failed',
            failingCommentIds: ['comment-2'],
          },
        }),
      )
      .mockResolvedValueOnce({});
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValue(new Error('refresh unavailable'));
    const refetch = vi.fn(async () => ({ data: draft }));
    let rowActions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    let briefingActions: ReturnType<typeof usePrReviewBriefingActions> | null =
      null;
    function Harness() {
      rowActions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch,
      } as never);
      briefingActions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(
      act(async () => rowActions!.submitApproval('')),
    ).rejects.toThrow('One inline comment was rejected.');
    renderHarness(root, queryClient, <Harness />);
    expect(briefingActions!.rejectedCommentCount).toBe(1);
    await expect(
      act(async () => briefingActions!.submitApproval('retry')),
    ).rejects.toThrow('Another inline comment was rejected.');
    renderHarness(root, queryClient, <Harness />);
    expect(rowActions!.rejectedCommentCount).toBe(2);
    await act(async () => rowActions!.submitApproval('final retry'));

    expect(mutations.submitReview.mutateAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ commentIds: ['comment-1', 'comment-2'] }),
    );
    expect(mutations.submitReview.mutateAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ commentIds: ['comment-2'] }),
    );
    expect(mutations.submitReview.mutateAsync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ commentIds: [] }),
    );
    expect(rowActions!.rejectedCommentCount).toBe(0);
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitted')));
  });

  it('resubmits a rejected comment after the briefing edits it', async () => {
    const mutations = mutationFixture();
    let draft = {
      ...draftFixture(1),
      comments: [
        draftFixture(1).comments[0],
        {
          ...draftFixture(1).comments[0],
          id: 'comment-2',
          body: 'Second draft body',
        },
      ],
    };
    mutations.saveDraft.mutateAsync.mockImplementation(async () => {
      draft = { ...draft, revision: draft.revision + 1 };
      return draft;
    });
    mutations.updateComment.mutateAsync.mockImplementation(async (input) => {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        comments: draft.comments.map((comment) =>
          comment.id === input.id ? { ...comment, body: input.body } : comment,
        ),
      };
      return draft;
    });
    mutations.submitReview.mutateAsync
      .mockRejectedValueOnce(
        new ApiError('One inline comment was rejected.', 422, '/review', {
          ok: false,
          changed: false,
          data: {
            code: 'github-review-submit-failed',
            failingCommentIds: ['comment-1'],
          },
        }),
      )
      .mockResolvedValueOnce({});
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValue(new Error('refresh unavailable'));
    const refetch = vi.fn(async () => ({ data: draft }));
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'One inline comment was rejected.',
    );
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.rejectedCommentCount).toBe(1);
    await act(async () => actions!.editComment('comment-1', 'Fixed body'));
    expect(actions!.rejectedCommentCount).toBe(0);
    await act(async () => actions!.submitApproval('retry'));

    expect(mutations.submitReview.mutateAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ commentIds: ['comment-1', 'comment-2'] }),
    );
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitted')));
  });

  it('resubmits a rejected comment after an external draft edit', async () => {
    const mutations = mutationFixture();
    let draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockImplementation(async () => {
      draft = { ...draft, revision: draft.revision + 1 };
      return draft;
    });
    mutations.submitReview.mutateAsync
      .mockRejectedValueOnce(
        new ApiError('The inline comment was rejected.', 422, '/review', {
          ok: false,
          changed: false,
          data: {
            code: 'github-review-submit-failed',
            failingCommentIds: ['comment-1'],
          },
        }),
      )
      .mockResolvedValueOnce({});
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValue(new Error('refresh unavailable'));
    const refetch = vi.fn(async () => ({ data: draft }));
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'The inline comment was rejected.',
    );
    expect(actions!.rejectedCommentCount).toBe(1);

    draft = {
      ...draft,
      revision: draft.revision + 1,
      comments: draft.comments.map((comment) => ({
        ...comment,
        body: 'Corrected in the workbench.',
        updatedAt: '2026-08-22T18:05:00.000Z',
      })),
    };
    renderHarness(root, queryClient, <Harness />);

    expect(actions!.rejectedCommentCount).toBe(0);
    await act(async () => actions!.submitApproval('retry'));
    expect(mutations.submitReview.mutateAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ commentIds: ['comment-1'] }),
    );
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitted')));
  });

  it('keeps a no-draft promotion pending across draft creation and comment insertion', async () => {
    const mutations = mutationFixture();
    const createdDraft = { ...draftFixture(1), comments: [] };
    const promotedDraft = draftFixture(2);
    const settledDraft = {
      ...promotedDraft,
      verdict: 'approve' as const,
      revision: 3,
    };
    const draftCreation = deferred<GitHubPrReviewDraft>();
    const commentInsertion = deferred<GitHubPrReviewDraft>();
    mutations.saveDraft.mutateAsync
      .mockImplementationOnce(() => draftCreation.promise)
      .mockResolvedValueOnce(settledDraft);
    mutations.addComment.mutateAsync.mockImplementationOnce(
      () => commentInsertion.promise,
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    const refetch = vi.fn(async () => ({ data: promotedDraft }));
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: null,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    const promotion = actions!.promoteFinding(findingFixture());
    const submission = actions!.submitApproval('');
    draftCreation.resolve(createdDraft);
    await act(async () => Promise.resolve());

    expect(mutations.addComment.mutateAsync).toHaveBeenCalledOnce();
    expect(refetch).not.toHaveBeenCalled();
    expect(mutations.submitReview.mutateAsync).not.toHaveBeenCalled();

    commentInsertion.resolve(promotedDraft);
    await act(async () => promotion);
    await act(async () => submission);

    expect(refetch).toHaveBeenCalledOnce();
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();
  });

  it('retains a successful submission lock until authoritative state leaves ready', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await act(async () => actions!.submitApproval(''));

    expect(actions!.submitting).toBe(true);
    await actions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    review = reviewFixture('submitted');
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.submitting).toBe(false);
  });

  it('does not unlock a successful submission for an immediate stale ready refresh', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockResolvedValue({ review: reviewFixture('ready') });
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await act(async () => actions!.submitApproval(''));

    expect(actions!.submitting).toBe(true);
    await actions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    review = reviewFixture('submitted');
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.submitting).toBe(false);
  });

  it('does not unlock an accepted response for a stale ready refresh', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockRejectedValue(
      new ApiError('Accepted but unverified.', 409, '/review', {
        ok: false,
        changed: true,
        data: {
          draft: { status: 'submitted' },
          review: { id: 42 },
        },
      }),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockResolvedValue({ review: reviewFixture('ready') });
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Accepted but unverified.',
    );

    expect(actions!.submitting).toBe(true);
    await actions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    review = reviewFixture('submitted');
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.submitting).toBe(false);
  });

  it.each([
    {
      label: 'submission-uncertain',
      data: {
        ok: false,
        changed: true,
        data: { code: 'submission-uncertain' },
      },
    },
    {
      label: 'accepted-but-unverified',
      data: {
        ok: false,
        changed: true,
        data: {
          draft: { status: 'submitted' },
          review: { id: 42 },
        },
      },
    },
  ])(
    'retains the lock for a rejected $label response until reconciliation',
    async ({ data }) => {
      const mutations = mutationFixture();
      const draft = draftFixture(1);
      mutations.saveDraft.mutateAsync.mockResolvedValue({
        ...draft,
        revision: 2,
      });
      mutations.submitReview.mutateAsync.mockRejectedValue(
        new ApiError('Reconcile this submission.', 409, '/review', data),
      );
      mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
      api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
      let review = reviewFixture();
      let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
      function Harness() {
        actions = usePrReviewBriefingActions(review, {
          data: draft,
          refetch: vi.fn(async () => ({ data: draft })),
        } as never);
        return null;
      }
      renderHarness(root, queryClient, <Harness />);

      await expect(
        act(async () => actions!.submitApproval('')),
      ).rejects.toThrow('Reconcile this submission.');

      expect(actions!.submitting).toBe(true);
      await actions!.submitApproval('duplicate');
      expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

      review = reviewFixture('submitted');
      renderHarness(root, queryClient, <Harness />);
      expect(actions!.submitting).toBe(false);
    },
  );

  it('retains the lock when the submit transport loses its response', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Failed to fetch',
    );

    expect(actions!.submitting).toBe(true);
    await actions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    review = reviewFixture('submitted');
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.submitting).toBe(false);
  });

  it('retains the lock for an unstructured server error after submit starts', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockRejectedValue(
      new ApiError('Internal server error.', 500, '/review', {
        ok: false,
      }),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Internal server error.',
    );

    expect(actions!.submitting).toBe(true);
    await actions!.submitApproval('duplicate');
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();

    review = reviewFixture('submitted');
    renderHarness(root, queryClient, <Harness />);
    expect(actions!.submitting).toBe(false);
  });

  it('makes a settled ambiguous submission recoverable after it reaches submitting', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockResolvedValue({
      review: reviewFixture('submitting'),
    });
    api.reconcilePrReviewSubmission.mockResolvedValue({
      review: reviewFixture('submitted'),
    });
    let review = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(review, {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Failed to fetch',
    );
    review = reviewFixture('submitting');
    renderHarness(root, queryClient, <Harness />);

    expect(actions!.busy).toBe(false);
    await act(async () => actions!.recoverSubmission());
    expect(api.reconcilePrReviewSubmission).toHaveBeenCalledWith('review-1');
    expect(actions!.submitting).toBe(false);
  });

  it('releases a recoverable ambiguous lock when later state proves ready', async () => {
    const mutations = mutationFixture();
    let draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockImplementation(async () => {
      draft = { ...draft, revision: draft.revision + 1 };
      return draft;
    });
    mutations.submitReview.mutateAsync
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({});
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValueOnce(new Error('refresh unavailable'));
    const refetch = vi.fn(async () => ({ data: draft }));
    const readyReview = reviewFixture();
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(readyReview, {
        data: draft,
        refetch,
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Failed to fetch',
    );
    expect(actions!.submitting).toBe(true);

    act(() => synchronizePrReviewSubmissionLock(reviewFixture('ready')));
    expect(actions!.submitting).toBe(false);
    await act(async () => actions!.submitApproval('retry'));
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledTimes(2);
    act(() => synchronizePrReviewSubmissionLock(reviewFixture('submitted')));
  });

  it('releases an ambiguous-attempt lock when authoritative state returns ready', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockResolvedValue({
      ...draft,
      revision: 2,
    });
    mutations.submitReview.mutateAsync.mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockResolvedValue({ review: reviewFixture('ready') });
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Failed to fetch',
    );

    expect(actions!.submitting).toBe(false);
    await expect(actions!.submitApproval('retry')).rejects.toThrow(
      'review draft changed',
    );
    expect(mutations.submitReview.mutateAsync).toHaveBeenCalledOnce();
  });

  it('releases the lock when a transport error occurs before submit starts', async () => {
    const mutations = mutationFixture();
    const draft = draftFixture(1);
    mutations.saveDraft.mutateAsync.mockRejectedValue(
      new TypeError('Draft save failed'),
    );
    mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
    api.getPrReview.mockRejectedValue(new Error('refresh unavailable'));
    let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
    function Harness() {
      actions = usePrReviewBriefingActions(reviewFixture(), {
        data: draft,
        refetch: vi.fn(async () => ({ data: draft })),
      } as never);
      return null;
    }
    renderHarness(root, queryClient, <Harness />);

    await expect(act(async () => actions!.submitApproval(''))).rejects.toThrow(
      'Draft save failed',
    );

    expect(actions!.submitting).toBe(false);
    await expect(actions!.submitApproval('retry')).rejects.toThrow(
      'Draft save failed',
    );
    expect(mutations.saveDraft.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutations.submitReview.mutateAsync).not.toHaveBeenCalled();
  });

  it.each(['submitted', 'ready'] as const)(
    'reconciles an interrupted submission to %s and publishes the record',
    async (status) => {
      const mutations = mutationFixture();
      mutationHook.useGitHubPrReviewMutations.mockReturnValue(mutations);
      const recovered = { ...reviewFixture(status), status };
      api.reconcilePrReviewSubmission.mockResolvedValue({ review: recovered });
      const onReviewChange = vi.fn<(review: PrReviewRecord) => void>();
      let actions: ReturnType<typeof usePrReviewBriefingActions> | null = null;
      function Harness() {
        actions = usePrReviewBriefingActions(
          reviewFixture('submitting'),
          { data: draftFixture(1), refetch: vi.fn() } as never,
          { onReviewChange },
        );
        return null;
      }
      renderHarness(root, queryClient, <Harness />);

      await act(async () => actions!.recoverSubmission());

      expect(api.reconcilePrReviewSubmission).toHaveBeenCalledWith('review-1');
      expect(onReviewChange).toHaveBeenCalledWith(recovered);
    },
  );
});

function renderHarness(
  root: ReturnType<typeof createRoot>,
  queryClient: QueryClient,
  child: ReactNode,
) {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>{child}</QueryClientProvider>,
    ),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function mutationFixture() {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
  return {
    addComment: mutation(),
    deleteComment: mutation(),
    saveDraft: mutation(),
    submitReview: mutation(),
    updateComment: mutation(),
  };
}

function draftFixture(revision: number): GitHubPrReviewDraft {
  const now = `2026-08-22T18:00:0${revision}.000Z`;
  return {
    id: 'draft-1',
    repo: 'owner/repo',
    prNumber: 1,
    headSha: 'head123',
    verdict: null,
    body: null,
    status: 'draft',
    revision,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    comments: [
      {
        id: 'comment-1',
        draftId: 'draft-1',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 12,
        startLine: null,
        startSide: null,
        body: 'Draft body',
        origin: 'neon',
        sourceFindingId: 'finding-1',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function reviewFixture(
  status: PrReviewRecord['status'] = 'ready',
): PrReviewRecord {
  return {
    id: 'review-1',
    repoFullName: 'owner/repo',
    prNumber: 1,
    status,
    headSha: 'head123',
  } as PrReviewRecord;
}

function findingFixture(): PrReviewReportOnlyFinding {
  return {
    sourceId: 'finding-2',
    severity: 'minor',
    path: 'src/other.ts',
    line: 24,
    side: 'LEFT',
    summary: 'The fallback deserves a comment.',
    suggestedFix: 'Guard it.',
    reason: 'The automatic anchor was unavailable.',
  };
}
