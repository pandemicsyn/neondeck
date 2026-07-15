import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import {
  fetchGitHubLogin,
  fetchPullRequestDetail,
  fetchPullRequestReviews,
  type GitHubPullRequestReview,
  type GitHubPullRequestDetail,
} from '../github';
import { resolvePullRequestTarget, type PullRequestTarget } from '../pr-events';
import { publishPrReviewEvent } from './events';
import {
  listPrReviews,
  readPrReview,
  readPrReviewByRunId,
  readPrReviewForTarget,
} from './store';
import {
  prReviewTrustBoundary,
  type PrReviewOrigin,
  type PrReviewRecord,
  type PrReviewReportOnlyFinding,
  type PrReviewVerdict,
} from './types';

export type StartPrReviewDependencies = {
  resolveTarget?: (
    ref: string,
    paths: RuntimePaths,
  ) => Promise<PullRequestTarget>;
  fetchDetail?: (target: PullRequestTarget) => Promise<GitHubPullRequestDetail>;
  invokeWorkflow?: (input: {
    ref: string;
    reviewId: string;
    attemptId: string;
  }) => Promise<{ runId: string }>;
};

export type ReconcilePrReviewSubmissionDependencies = {
  token?: string;
  now?: () => number;
  fetchLogin?: (token: string) => Promise<string>;
  fetchReviews?: (input: {
    token: string;
    owner: string;
    repo: string;
    number: number;
  }) => Promise<GitHubPullRequestReview[]>;
};

const submissionReconcileGraceMs = 30_000;
const activeSubmissionAttempts = new Set<string>();

export async function startPrReview(
  input: { ref: string; origin: PrReviewOrigin },
  paths = runtimePaths(),
  dependencies: StartPrReviewDependencies = {},
) {
  await ensureRuntimeHome(paths);
  const ref = input.ref.trim();
  if (!ref) throw new Error('A pull request reference is required.');

  const target = await (dependencies.resolveTarget ?? defaultResolveTarget)(
    ref,
    paths,
  );
  const detail = await (dependencies.fetchDetail ?? defaultFetchDetail)(target);
  const attemptId = randomUUID();
  const review = upsertReviewingRecord(
    { ref, origin: input.origin, target, detail, attemptId },
    paths,
  );
  publish(
    review,
    review.createdAt === review.updatedAt ? 'created' : 'changed',
  );

  try {
    const admission = await (
      dependencies.invokeWorkflow ?? invokeReviewPrWorkflow
    )({
      ref: `${target.repoFullName}#${target.number}`,
      reviewId: review.id,
      attemptId,
    });
    const attached = attachPrReviewAttemptRun(
      review.id,
      attemptId,
      admission.runId,
      paths,
    );
    if (!attached) {
      throw new Error('This review attempt was superseded by a newer start.');
    }
    return { review: attached, reviewId: attached.id, runId: admission.runId };
  } catch (error) {
    failPrReview(
      { reviewId: review.id, attemptId, message: errorMessage(error) },
      paths,
    );
    throw error;
  }
}

export async function invokeReviewPrWorkflow(input: {
  ref: string;
  reviewId: string;
  attemptId: string;
}) {
  const { invoke } = await import('@flue/runtime');
  const workflow = await import('../../workflows/review-pr-for-human');
  return invoke(workflow.default, { input });
}

export function completePrReview(
  input: {
    reviewId?: string;
    attemptId?: string;
    runId?: string;
    headSha: string;
    reportIds: string[];
    reviewUrl: string;
    findingCount: number;
    seededCount: number;
    reportOnlyCount: number;
    reportOnlyFindings: PrReviewReportOnlyFinding[];
  },
  paths = runtimePaths(),
) {
  const transition = findReviewTransition(input, paths);
  if (!transition) return null;
  const { current, column, value } = transition;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews
         SET status = 'ready',
             run_id = COALESCE(?, run_id),
             head_sha = ?,
             report_ids_json = ?,
             review_url = ?,
             finding_count = ?,
             seeded_count = ?,
             report_only_count = ?,
             report_only_findings_json = ?,
             failure_message = NULL,
             failed_at = NULL,
             ready_at = ?,
             updated_at = ?
         WHERE id = ? AND ${column} = ? AND status = 'reviewing';`,
      )
      .run(
        input.runId ?? null,
        input.headSha,
        JSON.stringify(input.reportIds),
        input.reviewUrl,
        input.findingCount,
        input.seededCount,
        input.reportOnlyCount,
        JSON.stringify(input.reportOnlyFindings),
        now,
        now,
        current.id,
        value,
      );
    changed = result.changes === 1;
  } finally {
    database.close();
  }
  if (!changed) return null;
  const updated = requireReview(current.id, paths);
  publish(updated, 'changed');
  return updated;
}

export function failPrReview(
  input: {
    reviewId?: string;
    attemptId?: string;
    runId?: string;
    allowReady?: boolean;
    message: string;
  },
  paths = runtimePaths(),
) {
  const transition = findReviewTransition(input, paths);
  if (!transition) return null;
  const { current, column, value } = transition;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews
         SET status = 'failed', run_id = COALESCE(?, run_id),
             failure_message = ?, failed_at = ?, updated_at = ?
         WHERE id = ? AND ${column} = ?
           AND (status = 'reviewing' OR (? = 1 AND status = 'ready'));`,
      )
      .run(
        input.runId ?? null,
        input.message.trim(),
        now,
        now,
        current.id,
        value,
        input.allowReady ? 1 : 0,
      );
    changed = result.changes === 1;
  } finally {
    database.close();
  }
  if (!changed) return null;
  const updated = requireReview(current.id, paths);
  publish(updated, 'changed');
  return updated;
}

export function reservePrReviewSubmission(
  input: {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    verdict: PrReviewVerdict;
  },
  paths = runtimePaths(),
) {
  const current = readPrReviewForTarget(
    input.repoFullName,
    input.prNumber,
    paths,
  );
  if (!current) return null;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews
         SET status = 'submitting', verdict = ?, updated_at = ?
         WHERE id = ? AND status = 'ready' AND head_sha = ?;`,
      )
      .run(input.verdict, now, current.id, input.headSha);
    changed = result.changes === 1;
  } finally {
    database.close();
  }
  if (!changed) return null;
  const updated = requireReview(current.id, paths);
  publish(updated, 'changed');
  return updated;
}

export function releasePrReviewSubmission(
  input: { reviewId: string; headSha: string },
  paths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews
         SET status = 'ready', verdict = NULL, updated_at = ?
         WHERE id = ? AND status = 'submitting' AND head_sha = ?;`,
      )
      .run(now, input.reviewId, input.headSha);
    changed = result.changes === 1;
  } finally {
    database.close();
  }
  if (!changed) return null;
  const updated = requireReview(input.reviewId, paths);
  publish(updated, 'changed');
  return updated;
}

export function beginPrReviewSubmissionAttempt(reviewId: string) {
  activeSubmissionAttempts.add(reviewId);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeSubmissionAttempts.delete(reviewId);
  };
}

export function submitPrReview(
  input: {
    reviewId: string;
    verdict: PrReviewVerdict;
    githubReviewUrl: string | null;
  },
  paths = runtimePaths(),
) {
  const current = readPrReview(input.reviewId, paths);
  if (!current) return null;
  if (current.status === 'submitted') return current;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews
         SET status = 'submitted', verdict = ?, github_review_url = ?,
             submitted_at = ?, updated_at = ?
         WHERE id = ? AND status = 'submitting';`,
      )
      .run(input.verdict, input.githubReviewUrl, now, now, current.id);
    changed = result.changes === 1;
  } finally {
    database.close();
  }
  if (!changed) return null;
  const updated = requireReview(current.id, paths);
  publish(updated, 'changed');
  return updated;
}

export async function reconcilePrReviewSubmission(
  input: { reviewId: string },
  paths = runtimePaths(),
  dependencies: ReconcilePrReviewSubmissionDependencies = {},
) {
  await ensureRuntimeHome(paths);
  const current = readPrReview(input.reviewId, paths);
  if (!current) throw new Error('PR review not found.');
  if (current.status !== 'submitting') {
    return { outcome: 'unchanged' as const, review: current };
  }
  if (activeSubmissionAttempts.has(current.id)) {
    return { outcome: 'pending' as const, review: current };
  }
  if (!current.verdict) {
    throw new Error('The reserved review is missing its submission verdict.');
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  const [owner, repo] = splitRepoFullName(current.repoFullName);
  const [login, reviews] = await Promise.all([
    (dependencies.fetchLogin ?? fetchGitHubLogin)(token),
    (dependencies.fetchReviews ?? fetchPullRequestReviews)({
      token,
      owner,
      repo,
      number: current.prNumber,
    }),
  ]);
  const submittedReview = matchingSubmittedReview(current, login, reviews);
  if (submittedReview) {
    const submitted = submitPrReview(
      {
        reviewId: current.id,
        verdict: current.verdict,
        githubReviewUrl: submittedReview.url,
      },
      paths,
    );
    if (submitted) {
      return { outcome: 'submitted' as const, review: submitted };
    }
    const settled = readPrReview(current.id, paths);
    if (settled?.status === 'submitted') {
      return { outcome: 'submitted' as const, review: settled };
    }
    throw new Error('Could not settle the recovered GitHub review locally.');
  }

  const now = (dependencies.now ?? Date.now)();
  const reservedAt = Date.parse(current.updatedAt);
  if (
    Number.isFinite(reservedAt) &&
    now - reservedAt < submissionReconcileGraceMs
  ) {
    return { outcome: 'pending' as const, review: current };
  }

  const released = releasePrReviewSubmission(
    { reviewId: current.id, headSha: current.headSha },
    paths,
  );
  if (released) return { outcome: 'ready' as const, review: released };
  const settled = readPrReview(current.id, paths);
  if (settled) return { outcome: 'unchanged' as const, review: settled };
  throw new Error('Could not release the interrupted submission locally.');
}

export function recentPrReviews(paths = runtimePaths()) {
  const submittedSince = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  return listPrReviews(paths, { submittedSince });
}

function matchingSubmittedReview(
  current: PrReviewRecord,
  login: string,
  reviews: GitHubPullRequestReview[],
) {
  const reservedAt = Date.parse(current.updatedAt);
  const earliestSubmittedAt = Number.isFinite(reservedAt)
    ? Math.floor(reservedAt / 1_000) * 1_000
    : 0;
  const expectedState = githubReviewState(current.verdict);
  return reviews
    .filter((review) => {
      const submittedAt = review.submittedAt
        ? Date.parse(review.submittedAt)
        : Number.NaN;
      return (
        review.authorLogin?.toLowerCase() === login.toLowerCase() &&
        review.commitId === current.headSha &&
        review.state === expectedState &&
        Number.isFinite(submittedAt) &&
        submittedAt >= earliestSubmittedAt
      );
    })
    .sort(
      (left, right) =>
        Date.parse(right.submittedAt ?? '') -
        Date.parse(left.submittedAt ?? ''),
    )[0];
}

function githubReviewState(verdict: PrReviewVerdict | null) {
  if (verdict === 'approve') return 'APPROVED';
  if (verdict === 'request-changes') return 'CHANGES_REQUESTED';
  return 'COMMENTED';
}

function splitRepoFullName(repoFullName: string): [string, string] {
  const [owner, repo, ...rest] = repoFullName.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository name: ${repoFullName}`);
  }
  return [owner, repo];
}

function upsertReviewingRecord(
  input: {
    ref: string;
    origin: PrReviewOrigin;
    target: PullRequestTarget;
    detail: GitHubPullRequestDetail;
    attemptId: string;
  },
  paths: RuntimePaths,
) {
  const repoFullName = input.target.repoFullName.toLowerCase();
  const existing = readPrReviewForTarget(
    repoFullName,
    input.target.number,
    paths,
  );
  if (existing?.status === 'reviewing' || existing?.status === 'submitting') {
    throw new Error(
      `A review is already ${existing.status === 'submitting' ? 'being submitted' : 'in progress'} for ${repoFullName}#${input.target.number}.`,
    );
  }
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  const reviewUrl = reviewSurfaceUrl(repoFullName, input.target.number);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO pr_reviews (
           id, ref, repo_full_name, pr_number, title, author, pr_url, status,
           attempt_id, run_id, head_sha, origin, review_url, report_ids_json,
           finding_count, seeded_count, report_only_count,
           report_only_findings_json, trust_boundary, verdict,
           previous_verdict, github_review_url, failure_message,
           created_at, updated_at, ready_at, submitted_at, failed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewing', ?, NULL, ?, ?, ?, '[]',
                   0, 0, 0, '[]', ?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)
         ON CONFLICT(repo_full_name, pr_number) DO UPDATE SET
           ref = excluded.ref,
           title = excluded.title,
           author = excluded.author,
           pr_url = excluded.pr_url,
           status = 'reviewing',
           attempt_id = excluded.attempt_id,
           run_id = NULL,
           head_sha = excluded.head_sha,
           origin = excluded.origin,
           review_url = excluded.review_url,
           report_ids_json = '[]',
           finding_count = 0,
           seeded_count = 0,
           report_only_count = 0,
           report_only_findings_json = '[]',
           verdict = NULL,
           previous_verdict = CASE
             WHEN pr_reviews.verdict IS NOT NULL THEN pr_reviews.verdict
             ELSE pr_reviews.previous_verdict
           END,
           github_review_url = NULL,
           failure_message = NULL,
           ready_at = NULL,
           submitted_at = NULL,
           failed_at = NULL,
           updated_at = excluded.updated_at;`,
      )
      .run(
        id,
        input.ref,
        repoFullName,
        input.target.number,
        input.detail.title,
        input.detail.author ?? null,
        input.detail.url,
        input.attemptId,
        input.detail.headSha,
        input.origin,
        reviewUrl,
        prReviewTrustBoundary,
        existing?.verdict ?? existing?.previousVerdict ?? null,
        existing?.createdAt ?? now,
        now,
      );
  } finally {
    database.close();
  }
  return requireReview(id, paths);
}

export function attachPrReviewAttemptRun(
  id: string,
  attemptId: string,
  runId: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const result = database
      .prepare(
        `UPDATE pr_reviews SET run_id = ?, updated_at = ?
         WHERE id = ? AND attempt_id = ? AND run_id IS NULL;`,
      )
      .run(runId, now, id, attemptId);
    if (result.changes === 1) {
      const updated = requireReview(id, paths);
      publish(updated, 'changed');
      return updated;
    }
    const row = database
      .prepare(
        `SELECT run_id FROM pr_reviews
         WHERE id = ? AND attempt_id = ? LIMIT 1;`,
      )
      .get(id, attemptId) as { run_id?: unknown } | undefined;
    if (row?.run_id !== runId) return null;
  } finally {
    database.close();
  }
  return requireReview(id, paths);
}

async function defaultResolveTarget(ref: string, paths: RuntimePaths) {
  const resolved = await resolvePullRequestTarget(
    { ref },
    paths,
    'pr_review_start',
  );
  if (!resolved.ok) throw new Error(resolved.result.message);
  return resolved.target;
}

async function defaultFetchDetail(target: PullRequestTarget) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  return fetchPullRequestDetail({
    token,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
  });
}

function findReviewTransition(
  input: { reviewId?: string; attemptId?: string; runId?: string },
  paths: RuntimePaths,
) {
  if (input.attemptId && input.reviewId) {
    const current = readPrReview(input.reviewId, paths);
    return current
      ? { current, column: 'attempt_id' as const, value: input.attemptId }
      : null;
  }
  if (input.runId) {
    const current = readPrReviewByRunId(input.runId, paths);
    return current
      ? { current, column: 'run_id' as const, value: input.runId }
      : null;
  }
  return null;
}

function requireReview(id: string, paths: RuntimePaths) {
  const review = readPrReview(id, paths);
  if (!review) throw new Error(`PR review record ${id} was not found.`);
  return review;
}

function publish(review: PrReviewRecord, action: 'created' | 'changed') {
  publishPrReviewEvent({
    id: review.id,
    action,
    review,
    changedAt: review.updatedAt,
  });
}

function reviewSurfaceUrl(repoFullName: string, prNumber: number) {
  const params = new URLSearchParams({
    repo: repoFullName,
    number: String(prNumber),
  });
  return `/review?${params.toString()}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
