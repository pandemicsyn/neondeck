import { describe, expect, it, vi } from 'vitest';
import type { GitHubPrReviewDraft } from './modules/github';
import {
  deleteGitHubPrReviewDraftComment,
  patchGitHubPrReviewDraftComment,
  postGitHubPrReviewDraftComment,
  putGitHubPrReviewDraft,
} from './modules/pr-events';
import { createPrReviewerDraftTools } from './modules/pr-reviewer';
import type { PrReviewRecord } from './modules/pr-reviews';
import { runtimePaths } from './runtime-home';

describe('PR reviewer local draft tools', () => {
  it('creates a Neon draft comment only through the bound review target', async () => {
    const review = reviewRecord();
    const emptyDraft = reviewDraft(review);
    const createdComment = {
      ...draftComment(emptyDraft.id),
      id: 'reviewer-draft:tool-call-1',
    };
    const completedDraft = {
      ...emptyDraft,
      comments: [createdComment],
    };
    const putDraft = vi.fn<typeof putGitHubPrReviewDraft>(() =>
      Promise.resolve(success('put', emptyDraft)),
    );
    const postComment = vi.fn<typeof postGitHubPrReviewDraftComment>(() =>
      Promise.resolve(success('post', completedDraft)),
    );
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => review,
        readLiveDraft: () => null,
        putDraft,
        postComment,
      },
    );
    const create = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_create',
    );
    expect(create).toMatchObject({ durable: true });

    await expect(
      create?.run({
        data: {
          path: 'src/app.ts',
          side: 'RIGHT',
          line: 12,
          body: 'Keep the invariant explicit.',
        },
        toolCallId: 'tool-call-1',
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        changed: true,
        action: 'neondeck_pr_review_draft_comment_create',
        data: {
          draftId: emptyDraft.id,
          comment: { id: createdComment.id, origin: 'neon' },
        },
      },
    });
    expect(putDraft).toHaveBeenCalledWith(
      { repo: review.repoFullName, prNumber: review.prNumber },
      { headSha: review.headSha, expectedAbsent: true },
      expect.any(Object),
    );
    expect(postComment.mock.calls[0]?.[0]).toEqual({
      repo: review.repoFullName,
      prNumber: review.prNumber,
    });
    expect(postComment.mock.calls[0]?.[1]).toMatchObject({
      draftId: emptyDraft.id,
      expectedRevision: emptyDraft.revision,
      path: 'src/app.ts',
      line: 12,
    });
    expect(postComment.mock.calls[0]?.[4]).toEqual({
      expectedHeadSha: review.headSha,
      id: 'reviewer-draft:tool-call-1',
      origin: 'neon',
    });
  });

  it('updates text or anchors while preserving the current body when omitted', async () => {
    const review = reviewRecord();
    const draft = reviewDraft(review, [draftComment('draft-1')]);
    const patchComment = vi.fn<typeof patchGitHubPrReviewDraftComment>(() =>
      Promise.resolve(
        success('patch', {
          ...draft,
          comments: [
            {
              ...draft.comments[0]!,
              path: 'src/next.ts',
              line: 20,
              origin: 'neon' as const,
            },
          ],
        }),
      ),
    );
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => review,
        readDraftForComment: () => draft,
        patchComment,
      },
    );
    const update = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_update',
    );
    expect(update).toMatchObject({ durable: true });

    await expect(
      update?.run({
        data: {
          commentId: 'comment-1',
          path: 'src/next.ts',
          side: 'RIGHT',
          line: 20,
        },
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        action: 'neondeck_pr_review_draft_comment_update',
      },
    });
    expect(patchComment.mock.calls[0]?.[0]).toEqual({
      repo: review.repoFullName,
      prNumber: review.prNumber,
    });
    expect(patchComment.mock.calls[0]?.[2]).toMatchObject({
      draftId: draft.id,
      expectedRevision: draft.revision,
      body: draft.comments[0]!.body,
      path: 'src/next.ts',
      side: 'RIGHT',
      line: 20,
    });
    expect(patchComment.mock.calls[0]?.[5]).toEqual({
      expectedHeadSha: review.headSha,
      origin: 'neon',
    });
  });

  it('preserves human origin and text during an anchor-only update', async () => {
    const review = reviewRecord();
    const humanComment = {
      ...draftComment('draft-1'),
      body: 'Human-authored wording.',
      origin: 'human' as const,
    };
    const draft = reviewDraft(review, [humanComment]);
    const patchComment = vi.fn<typeof patchGitHubPrReviewDraftComment>(() =>
      Promise.resolve(
        success('patch', {
          ...draft,
          comments: [{ ...humanComment, line: 18 }],
        }),
      ),
    );
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => review,
        readDraftForComment: () => draft,
        patchComment,
      },
    );
    const update = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_update',
    );

    await update?.run({
      data: { commentId: humanComment.id, line: 18 },
      step: immediateStep(),
    } as never);

    expect(patchComment.mock.calls[0]?.[2]).toMatchObject({
      draftId: draft.id,
      expectedRevision: draft.revision,
      body: humanComment.body,
      line: 18,
    });
    expect(patchComment.mock.calls[0]?.[5]).toEqual({
      expectedHeadSha: review.headSha,
      origin: 'human',
    });
  });

  it('refuses mutations after the bound review revision changes', async () => {
    const review = reviewRecord();
    const patchComment = vi.fn<typeof patchGitHubPrReviewDraftComment>();
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => ({ ...review, headSha: 'b'.repeat(40) }),
        patchComment,
      },
    );
    const update = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_update',
    );

    await expect(
      update?.run({
        data: { commentId: 'comment-1', body: 'Do not apply this.' },
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({
      output: {
        ok: false,
        changed: false,
        requires: ['currentReviewRevision'],
      },
    });
    expect(patchComment).not.toHaveBeenCalled();
  });

  it('refuses to delete a comment from another draft revision', async () => {
    const review = reviewRecord();
    const deleteComment = vi.fn<typeof deleteGitHubPrReviewDraftComment>();
    const otherDraft = {
      ...reviewDraft(review, [draftComment('draft-1')]),
      headSha: 'b'.repeat(40),
    };
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => review,
        readDraftForComment: () => otherDraft,
        deleteComment,
      },
    );
    const remove = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_delete',
    );
    expect(remove).toMatchObject({ durable: true });

    await expect(
      remove?.run({
        data: { commentId: 'comment-1' },
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({
      output: {
        ok: false,
        changed: false,
        requires: ['commentId'],
      },
    });
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it('treats a replayed delete as a successful no-op', async () => {
    const review = reviewRecord();
    const draft = reviewDraft(review, [draftComment('draft-1')]);
    const deletedDraft = { ...draft, comments: [] };
    const readDraftForComment = vi
      .fn<() => GitHubPrReviewDraft | null>()
      .mockReturnValueOnce(draft)
      .mockReturnValue(null);
    const deleteComment = vi.fn<typeof deleteGitHubPrReviewDraftComment>(() =>
      Promise.resolve(success('delete', deletedDraft)),
    );
    const tools = createPrReviewerDraftTools(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-draft-tools'),
      {
        readReview: () => review,
        readDraftForComment,
        readLiveDraft: () => deletedDraft,
        deleteComment,
      },
    );
    const remove = tools.find(
      (tool) => tool.name === 'neondeck_pr_review_draft_comment_delete',
    );

    await expect(
      remove?.run({
        data: { commentId: 'comment-1' },
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({ output: { ok: true, changed: true } });
    await expect(
      remove?.run({
        data: { commentId: 'comment-1' },
        step: immediateStep(),
      } as never),
    ).resolves.toMatchObject({ output: { ok: true, changed: false } });
    expect(deleteComment).toHaveBeenCalledTimes(1);
    expect(deleteComment.mock.calls[0]?.[3]).toEqual({
      draftId: draft.id,
      expectedHeadSha: review.headSha,
      expectedRevision: draft.revision,
    });
  });
});

function immediateStep() {
  return {
    do: async <T>(_name: string, effect: () => T | Promise<T>) => effect(),
  };
}

function reviewRecord(): PrReviewRecord {
  return {
    id: 'review-1',
    ref: 'example/repo#42',
    repoFullName: 'example/repo',
    prNumber: 42,
    title: 'Review draft tools',
    author: 'contributor',
    prUrl: 'https://github.com/example/repo/pull/42',
    status: 'ready',
    runId: 'submission-1',
    headSha: 'a'.repeat(40),
    baseSha: 'base-sha',
    baseRef: 'main',
    origin: 'panel',
    reviewUrl: '/review?repo=example%2Frepo&number=42',
    reportIds: [],
    findingCount: 1,
    seededCount: 1,
    reportOnlyCount: 0,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
    readyAt: '2026-08-05T12:00:00.000Z',
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}

function reviewDraft(
  review: PrReviewRecord,
  comments: GitHubPrReviewDraft['comments'] = [],
): GitHubPrReviewDraft {
  return {
    id: 'draft-1',
    repo: review.repoFullName,
    prNumber: review.prNumber,
    headSha: review.headSha,
    verdict: null,
    body: null,
    status: 'draft',
    revision: 1,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    submittedAt: null,
    comments,
  };
}

function draftComment(draftId: string) {
  return {
    id: 'comment-1',
    draftId,
    path: 'src/app.ts',
    side: 'RIGHT' as const,
    line: 12,
    startLine: null,
    startSide: null,
    body: 'Keep the invariant explicit.',
    origin: 'neon' as const,
    sourceFindingId: 'finding-1',
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
  };
}

function success(action: string, draft: GitHubPrReviewDraft) {
  return {
    ok: true,
    action,
    changed: true,
    message: 'Draft changed.',
    data: { draft },
  } as const;
}
