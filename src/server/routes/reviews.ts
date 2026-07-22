import { Hono } from 'hono';
import {
  listGitHubPrQueue,
  type GitHubPullRequest,
} from '../../modules/github';
import {
  archivePrReview,
  readPrReview,
  readPrReviewForTarget,
  reconcilePrReviewSubmission,
  recentPrReviews,
  restorePrReview,
  startPrReview,
  type PrReviewOrigin,
  type PrReviewRecord,
} from '../../modules/pr-reviews';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonBody } from '../http';

export function createReviewRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/reviews', async (c) => {
    const repo = c.req.query('repo')?.trim();
    const prNumber = Number(c.req.query('prNumber'));
    if (repo && Number.isInteger(prNumber) && prNumber > 0) {
      const review = readPrReviewForTarget(repo, prNumber, paths);
      const items = review ? [review] : [];
      return c.json({
        ok: true,
        action: 'pr_reviews_list',
        changed: false,
        items,
        groups: groupReviews(items, []),
      });
    }

    const reviews = recentPrReviews(paths);
    const queueResult = await listGitHubPrQueue(paths);
    const queue = queueResult.ok
      ? queueFromResult(queueResult.data)
      : { items: [] as GitHubPullRequest[] };
    const awaiting = queue.items
      .filter((item) => item.relations.includes('review-requested'))
      .map((pullRequest) => ({
        pullRequest,
        review:
          reviews.find(
            (review) =>
              !review.archivedAt &&
              review.repoFullName.toLowerCase() ===
                pullRequest.repo.toLowerCase() &&
              review.prNumber === pullRequest.number,
          ) ?? null,
      }));

    return c.json({
      ok: true,
      action: 'pr_reviews_list',
      changed: false,
      items: reviews,
      groups: groupReviews(reviews, awaiting),
      queueIssues: queueResult.ok ? [] : (queueResult.errors ?? []),
    });
  });

  routes.get('/reviews/:id', (c) => {
    const review = readPrReview(c.req.param('id'), paths);
    return review
      ? c.json({
          ok: true,
          action: 'pr_review_read',
          changed: false,
          review,
        })
      : c.json(
          {
            ok: false,
            action: 'pr_review_read',
            changed: false,
            message: 'PR review not found.',
          },
          404,
        );
  });

  routes.post('/reviews', async (c) => {
    const body = objectBody(await safeJsonBody(c));
    const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
    if (!ref) {
      return c.json(
        {
          ok: false,
          action: 'pr_review_start',
          changed: false,
          message: 'A pull request reference is required.',
          requires: ['ref'],
        },
        400,
      );
    }
    try {
      const result = await startPrReview(
        { ref, origin: reviewOrigin(body.origin) },
        paths,
      );
      return c.json(
        {
          ok: true,
          action: 'pr_review_start',
          changed: true,
          message: `Started review for ${result.review.repoFullName}#${result.review.prNumber}.`,
          ...result,
        },
        202,
      );
    } catch (error) {
      return c.json(
        {
          ok: false,
          action: 'pr_review_start',
          changed: false,
          message: errorMessage(error),
        },
        400,
      );
    }
  });

  routes.post('/reviews/:id/review', async (c) => {
    const existing = readPrReview(c.req.param('id'), paths);
    if (!existing) {
      return c.json(
        {
          ok: false,
          action: 'pr_review_restart',
          changed: false,
          message: 'PR review not found.',
        },
        404,
      );
    }
    try {
      const result = await startPrReview(
        { ref: existing.ref, origin: 'panel' },
        paths,
      );
      return c.json(
        {
          ok: true,
          action: 'pr_review_restart',
          changed: true,
          message: `Re-reviewing ${existing.repoFullName}#${existing.prNumber}.`,
          ...result,
        },
        202,
      );
    } catch (error) {
      return c.json(
        {
          ok: false,
          action: 'pr_review_restart',
          changed: false,
          message: errorMessage(error),
        },
        400,
      );
    }
  });

  routes.post('/reviews/:id/reconcile', async (c) => {
    try {
      const result = await reconcilePrReviewSubmission(
        { reviewId: c.req.param('id') },
        paths,
      );
      const message =
        result.outcome === 'submitted'
          ? 'Recovered the submitted review from GitHub.'
          : result.outcome === 'ready'
            ? 'GitHub has no matching review; the local draft is ready to submit again.'
            : result.outcome === 'pending'
              ? 'GitHub has not reported the review yet. Wait a moment, then check again.'
              : `The review is already ${result.review.status}.`;
      return c.json(
        {
          ok: true,
          action: 'pr_review_submission_reconcile',
          changed: result.outcome === 'submitted' || result.outcome === 'ready',
          message,
          review: result.review,
          reviewId: result.review.id,
          runId: result.review.runId ?? '',
        },
        result.outcome === 'pending' ? 202 : 200,
      );
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          ok: false,
          action: 'pr_review_submission_reconcile',
          changed: false,
          message,
        },
        message === 'GITHUB_TOKEN is not configured.' ? 503 : 502,
      );
    }
  });

  routes.post('/reviews/:id/archive', (c) => {
    const result = reviewArchiveResult(c.req.param('id'), true, paths);
    return c.json(result.body, result.status);
  });

  routes.post('/reviews/:id/restore', (c) => {
    const result = reviewArchiveResult(c.req.param('id'), false, paths);
    return c.json(result.body, result.status);
  });

  return routes;
}

function groupReviews(
  reviews: PrReviewRecord[],
  awaiting: Array<{
    pullRequest: GitHubPullRequest;
    review: PrReviewRecord | null;
  }>,
) {
  return {
    awaiting,
    inProgress: reviews.filter(
      (review) =>
        !review.archivedAt &&
        (review.status === 'reviewing' || review.status === 'submitting'),
    ),
    needsAction: reviews.filter(
      (review) =>
        !review.archivedAt &&
        (review.status === 'ready' || review.status === 'failed'),
    ),
    submitted: reviews.filter(
      (review) => !review.archivedAt && review.status === 'submitted',
    ),
    archived: reviews.filter((review) => Boolean(review.archivedAt)),
  };
}

function reviewArchiveResult(
  reviewId: string,
  archived: boolean,
  paths: RuntimePaths,
) {
  try {
    const result = (archived ? archivePrReview : restorePrReview)(
      { reviewId },
      paths,
    );
    return {
      status: 200 as const,
      body: {
        ok: true,
        action: archived ? 'pr_review_archive' : 'pr_review_restore',
        changed: result.changed,
        message: archived ? 'Archived PR review.' : 'Restored PR review.',
        review: result.review,
        reviewId: result.review.id,
        runId: result.review.runId ?? '',
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      status: (message === 'PR review not found.' ? 404 : 400) as 400 | 404,
      body: {
        ok: false,
        action: archived ? 'pr_review_archive' : 'pr_review_restore',
        changed: false,
        message,
      },
    };
  }
}

function queueFromResult(value: unknown): { items: GitHubPullRequest[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { items: [] };
  }
  const queue = (value as { queue?: unknown }).queue;
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    return { items: [] };
  }
  const items = (queue as { items?: unknown }).items;
  return { items: Array.isArray(items) ? (items as GitHubPullRequest[]) : [] };
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function reviewOrigin(value: unknown): PrReviewOrigin {
  return value === 'chat' || value === 'panel' || value === 'api'
    ? value
    : 'api';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
