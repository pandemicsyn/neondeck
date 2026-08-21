import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  fetchPullRequestReviewComments,
  GitHubPrReviewSubmitError,
  invalidatePullRequestReviewSurfaceThreadCache,
  submitPullRequestReview,
  type GitHubPrReviewDraft,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewThreadComment,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  prEventTargetInputSchema,
  prReviewSubmitInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import { isConfiguredRepoTarget, resolvePullRequestTarget } from './target';
import {
  requestedChangesReviewDeliveryFingerprint,
  reviewThreadCommentDeliveryFingerprint,
} from './watermarks';
import { recordNeondeckPrDeliveriesAndCompleteFollowup } from './deliveries';
import {
  claimPrReviewSubmissionFollowup,
  enqueuePrReviewSubmissionFollowup,
  listPendingPrReviewSubmissionFollowupIds,
  recoverProcessingPrReviewSubmissionFollowups,
  retryPrReviewSubmissionFollowup,
  schedulePrReviewSubmissionFollowup,
} from '../pr-reviews/submission-followups';
import { errorMessage, eventTargetJson, failResult, okResult } from './utils';

export async function postGitHubPrReview(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  reviewInput: v.InferInput<typeof prReviewSubmitInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsedReview = v.safeParse(prReviewSubmitInputSchema, reviewInput);
  if (!parsedTarget.success || !parsedReview.success) {
    return failResult('github_pr_review_post', 'Invalid PR review input.', {
      errors: [
        ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
        ...(!parsedReview.success ? [v.summarize(parsedReview.issues)] : []),
      ],
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pr_review_post',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_post',
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      'github_pr_review_post',
      `Repository "${resolved.target.repoFullName}" is not configured for PR reviews.`,
      { requires: ['repo'] },
    );
  }

  try {
    const submitter =
      dependencies.submitPullRequestReview ?? submitPullRequestReview;
    const result = await submitter({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      databasePath: paths.neondeckDatabase,
      paths,
      draftId: parsedReview.output.draftId,
      headSha: parsedReview.output.headSha,
      expectedDraftRevision: parsedReview.output.expectedDraftRevision,
      commentIds: parsedReview.output.commentIds,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
    });
    try {
      invalidatePullRequestReviewSurfaceThreadCache({
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
      });
    } catch {
      // GitHub has accepted the review; a later refresh can rebuild this cache.
    }
    const followupId = submittedDeliveryFollowupId(
      resolved.target.repoFullName,
      resolved.target.number,
      result.review.id,
    );
    schedulePrReviewSubmissionFollowup(
      {
        id: followupId,
        kind: 'delivery',
        payload: {
          target: resolved.target,
          result,
          commentIds: parsedReview.output.commentIds,
        } satisfies SubmittedDeliveryFollowupPayload,
      },
      paths,
      () => {
        void processPrReviewDeliveryFollowup(
          followupId,
          paths,
          dependencies,
        ).catch((error) => {
          console.error(
            '[neondeck] failed to start submitted-review delivery follow-up',
            error,
          );
        });
      },
    );
    return okResult(
      'github_pr_review_post',
      true,
      `Submitted PR review for ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        draft: result.draft as unknown as JsonValue,
        review: result.review as unknown as JsonValue,
      },
    );
  } catch (error) {
    if (error instanceof GitHubPrReviewSubmitError) {
      const uncertain = error.failure.code === 'submission-uncertain';
      return {
        ok: false,
        action: 'github_pr_review_post',
        changed: uncertain,
        message: error.failure.message,
        data: {
          code: error.failure.code,
          failingCommentIds: error.failure.failingCommentIds ?? [],
        },
        ...(error.failure.requires ? { requires: error.failure.requires } : {}),
      };
    }
    return failResult('github_pr_review_post', 'Could not submit PR review.', {
      errors: [errorMessage(error)],
    });
  }
}

type SubmittedDeliveryFollowupPayload = {
  target: PullRequestTarget;
  result: {
    draft: GitHubPrReviewDraft | null;
    review: GitHubPullRequestReview;
  };
  commentIds?: string[];
  verifyByReviewIdentityOnly?: boolean;
};

export function enqueueRecoveredPrReviewDeliveryFollowup(
  input: {
    target: PullRequestTarget;
    draft: GitHubPrReviewDraft | null;
    review: GitHubPullRequestReview;
    token: string;
    fetchPullRequestReviewComments?: typeof fetchPullRequestReviewComments;
  },
  paths: RuntimePaths,
) {
  const id = submittedDeliveryFollowupId(
    input.target.repoFullName,
    input.target.number,
    input.review.id,
  );
  enqueuePrReviewSubmissionFollowup(
    {
      id,
      kind: 'delivery',
      payload: {
        target: input.target,
        result: { draft: input.draft, review: input.review },
        // The original local selection is unavailable after a lost response.
        // GitHub's exact review-comments endpoint is authoritative here.
        verifyByReviewIdentityOnly: true,
      } satisfies SubmittedDeliveryFollowupPayload,
    },
    paths,
  );
  void processPrReviewDeliveryFollowup(id, paths, {
    token: input.token,
    fetchPullRequestReviewComments: input.fetchPullRequestReviewComments,
  }).catch((error) => {
    console.error(
      '[neondeck] failed to start recovered-review delivery follow-up',
      error,
    );
  });
  return id;
}

export async function recoverPrReviewDeliveryFollowups(
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies = {},
) {
  recoverProcessingPrReviewSubmissionFollowups(paths);
  const ids = listPendingPrReviewSubmissionFollowupIds('delivery', paths);
  return Promise.all(
    ids.map((id) => processPrReviewDeliveryFollowup(id, paths, dependencies)),
  );
}

async function processPrReviewDeliveryFollowup(
  id: string,
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
) {
  const followup = claimPrReviewSubmissionFollowup('delivery', paths, id);
  if (!followup) return false;
  try {
    const payload = followup.payload as SubmittedDeliveryFollowupPayload;
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not configured.');
    await verifyAndRecordSubmittedReviewDelivery(
      payload.target,
      payload.result,
      payload.commentIds,
      payload.verifyByReviewIdentityOnly === true,
      token,
      paths,
      dependencies,
      followup.id,
    );
    return true;
  } catch (error) {
    const retryDelayMs = retryPrReviewSubmissionFollowup(
      followup.id,
      error,
      paths,
    );
    scheduleDeliveryFollowupRetry(
      followup.id,
      paths,
      dependencies,
      retryDelayMs,
    );
    return false;
  }
}

function scheduleDeliveryFollowupRetry(
  id: string,
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
  retryDelayMs: number,
) {
  const timer = setTimeout(() => {
    void processPrReviewDeliveryFollowup(id, paths, dependencies).catch(
      (error) => {
        console.error(
          '[neondeck] failed to retry submitted-review delivery follow-up',
          error,
        );
      },
    );
  }, retryDelayMs);
  timer.unref?.();
}

function submittedDeliveryFollowupId(
  repo: string,
  prNumber: number,
  reviewId: number,
) {
  return `pr-review-delivery:${repo.toLowerCase()}#${prNumber}:${reviewId}`;
}

async function verifyAndRecordSubmittedReviewDelivery(
  target: PullRequestTarget,
  result: SubmittedDeliveryFollowupPayload['result'],
  commentIds: string[] | undefined,
  verifyByReviewIdentityOnly: boolean,
  token: string,
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
  followupId: string,
) {
  const selectedCommentIds = commentIds ? new Set(commentIds) : null;
  const submittedDraftComments = (result.draft?.comments ?? []).filter(
    (comment) =>
      selectedCommentIds === null || selectedCommentIds.has(comment.id),
  );
  const deliveredComments = await (
    dependencies.fetchPullRequestReviewComments ??
    fetchPullRequestReviewComments
  )({
    token,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    reviewId: result.review.id,
  });
  const deliveryIdentityError = verifyByReviewIdentityOnly
    ? submittedReviewCommentIdsError(result.review.id, deliveredComments)
    : submittedReviewDeliveryIdentityError(
        result.review.id,
        submittedDraftComments,
        deliveredComments,
      );
  if (deliveryIdentityError) throw new Error(deliveryIdentityError);
  recordNeondeckPrDeliveriesAndCompleteFollowup(
    [
      {
        repoFullName: target.repoFullName,
        prNumber: target.number,
        itemKind: 'review' as const,
        itemId: result.review.id,
        itemFingerprint: requestedChangesReviewDeliveryFingerprint(
          result.review,
        ),
      },
      ...deliveredComments.map((comment) => ({
        repoFullName: target.repoFullName,
        prNumber: target.number,
        itemKind: 'review-comment' as const,
        itemId: comment.databaseId ?? comment.id,
        itemFingerprint: reviewThreadCommentDeliveryFingerprint(comment),
      })),
    ],
    followupId,
    paths,
  );
}

function submittedReviewDeliveryIdentityError(
  reviewId: number,
  expected: GitHubPrReviewDraft['comments'],
  delivered: GitHubPullRequestReviewThreadComment[],
) {
  const commentIdsError = submittedReviewCommentIdsError(reviewId, delivered);
  if (commentIdsError) return commentIdsError;
  const expectedSignatures = expected
    .map(submittedDraftCommentSignature)
    .sort();
  const deliveredSignatures = delivered
    .map(submittedReviewCommentSignature)
    .sort();
  if (
    expectedSignatures.length !== deliveredSignatures.length ||
    expectedSignatures.some(
      (signature, index) => signature !== deliveredSignatures[index],
    )
  ) {
    return `GitHub comments for submitted review ${reviewId} do not exactly match the submitted draft comments.`;
  }
  return null;
}

function submittedReviewCommentIdsError(
  reviewId: number,
  delivered: GitHubPullRequestReviewThreadComment[],
) {
  if (
    delivered.some(
      (comment) => comment.databaseId === null || comment.reviewId !== reviewId,
    )
  ) {
    return `GitHub returned a comment without an exact database id for submitted review ${reviewId}.`;
  }
  const deliveredIds = delivered.map((comment) => comment.databaseId!);
  if (new Set(deliveredIds).size !== deliveredIds.length) {
    return `GitHub returned duplicate comment ids for submitted review ${reviewId}.`;
  }
  return null;
}

function submittedDraftCommentSignature(
  comment: GitHubPrReviewDraft['comments'][number],
) {
  return JSON.stringify([
    comment.path,
    comment.side,
    comment.line,
    comment.startLine,
    comment.startSide,
    comment.body,
  ]);
}

function submittedReviewCommentSignature(
  comment: GitHubPullRequestReviewThreadComment,
) {
  return JSON.stringify([
    comment.path,
    comment.side,
    comment.line,
    comment.startLine,
    comment.startSide,
    comment.body,
  ]);
}
