import * as v from 'valibot';
import {
  fetchPullRequestReviewComments,
  GitHubPrReviewSubmitError,
  invalidatePullRequestReviewSurfaceThreadCache,
  submitPullRequestReview,
  type GitHubPrReviewDraft,
  type GitHubPullRequestReviewThreadComment,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  parsePrEventJsonValue,
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
import { recordNeondeckPrDeliveries } from './deliveries';
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
      commentIds: parsedReview.output.commentIds,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
    });
    invalidatePullRequestReviewSurfaceThreadCache({
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
    });
    const selectedCommentIds = parsedReview.output.commentIds
      ? new Set(parsedReview.output.commentIds)
      : null;
    const submittedDraftComments = result.draft.comments.filter(
      (comment) =>
        selectedCommentIds === null || selectedCommentIds.has(comment.id),
    );
    let deliveredComments: GitHubPullRequestReviewThreadComment[];
    try {
      deliveredComments = await (
        dependencies.fetchPullRequestReviewComments ??
        fetchPullRequestReviewComments
      )({
        token,
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
        reviewId: result.review.id,
      });
    } catch (error) {
      return unverifiedSubmittedReviewResult(
        resolved.target,
        result,
        `Could not fetch the submitted review comments: ${errorMessage(error)}`,
      );
    }
    const deliveryIdentityError = submittedReviewDeliveryIdentityError(
      result.review.id,
      submittedDraftComments,
      deliveredComments,
    );
    if (deliveryIdentityError) {
      return unverifiedSubmittedReviewResult(
        resolved.target,
        result,
        deliveryIdentityError,
      );
    }
    recordNeondeckPrDeliveries(
      [
        {
          repoFullName: resolved.target.repoFullName,
          prNumber: resolved.target.number,
          itemKind: 'review' as const,
          itemId: result.review.id,
          itemFingerprint: requestedChangesReviewDeliveryFingerprint(
            result.review,
          ),
        },
        ...deliveredComments.map((comment) => ({
          repoFullName: resolved.target.repoFullName,
          prNumber: resolved.target.number,
          itemKind: 'review-comment' as const,
          itemId: comment.databaseId ?? comment.id,
          itemFingerprint: reviewThreadCommentDeliveryFingerprint(comment),
        })),
      ],
      paths,
    );
    return okResult(
      'github_pr_review_post',
      true,
      `Submitted PR review for ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        draft: parsePrEventJsonValue(result.draft),
        review: parsePrEventJsonValue(result.review),
      },
    );
  } catch (error) {
    if (error instanceof GitHubPrReviewSubmitError) {
      const failureResult: PrEventActionResult = {
        ok: false,
        action: 'github_pr_review_post',
        changed: false,
        message: error.failure.message,
        data: {
          code: error.failure.code,
          failingCommentIds: error.failure.failingCommentIds ?? [],
        },
      };
      if (error.failure.requires) {
        failureResult.requires = error.failure.requires;
      }
      return failureResult;
    }
    return failResult('github_pr_review_post', 'Could not submit PR review.', {
      errors: [errorMessage(error)],
    });
  }
}

function unverifiedSubmittedReviewResult(
  target: PullRequestTarget,
  result: Awaited<ReturnType<typeof submitPullRequestReview>>,
  deliveryIdentityError: string,
): PrEventActionResult {
  return {
    ok: false,
    action: 'github_pr_review_post',
    changed: true,
    message:
      'Submitted PR review but could not uniquely verify its durable delivery identity.',
    data: {
      target: eventTargetJson(target),
      draft: parsePrEventJsonValue(result.draft),
      review: parsePrEventJsonValue(result.review),
      deliveryIdentityVerified: false,
    },
    requires: ['deliveryIdentity'],
    errors: [deliveryIdentityError],
  };
}

function submittedReviewDeliveryIdentityError(
  reviewId: number,
  expected: GitHubPrReviewDraft['comments'],
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
