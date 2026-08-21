import { Hono } from 'hono';
import {
  getGitHubPullRequest,
  readLivePrReviewDraft,
  readPrReviewDraft,
  readGitHubQueueSnapshot,
} from '../../modules/github';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrEventState,
  getGitHubPrFileDiff,
  getGitHubPrFiles,
  getGitHubPrReviewDraft,
  getGitHubPrRequestedChanges,
  getGitHubPrReviewThreads,
  deleteGitHubPrReviewDraft,
  deleteGitHubPrReviewDraftComment,
  patchGitHubPrReviewDraftComment,
  postGitHubPrComment,
  postGitHubPrReview,
  postGitHubPrReviewDraftComment,
  postGitHubPrThreadReply,
  postGitHubPrThreadResolution,
  putGitHubPrReviewDraft,
} from '../../modules/pr-events';
import type { RuntimePaths } from '../../runtime-home';
import {
  beginPrReviewSubmissionAttempt,
  releasePrReviewSubmission,
  readPrReviewForTarget,
  reservePrReviewSubmission,
  submitPrReview,
} from '../../modules/pr-reviews';
import { queryNumber, safeJsonBody } from '../http';
import { recordHumanReviewSubmittedApiEvidence } from '../learning-hooks';
import { schedulePrReviewEvidenceFollowup } from '../pr-review-submission-followups';

export function createGitHubRoutes(
  paths: RuntimePaths,
  dependencies: {
    postGitHubPrReview?: typeof postGitHubPrReview;
    putGitHubPrReviewDraft?: typeof putGitHubPrReviewDraft;
    recordHumanReviewSubmittedApiEvidence?: typeof recordHumanReviewSubmittedApiEvidence;
  } = {},
) {
  const routes = new Hono();

  routes.get('/prs', (c) => {
    const snapshot = readGitHubQueueSnapshot(paths);
    return c.json(snapshot, snapshot.status === 'unavailable' ? 503 : 200);
  });

  routes.get('/prs/:owner/:repo/:number', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await getGitHubPullRequest(
      { repo: target.input.repo, number: target.input.prNumber },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/prs/:owner/:repo/:number/files/diff', async (c) => {
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');
    const number = Number(c.req.param('number'));
    if (!Number.isInteger(number) || number <= 0) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_file_diff_get',
          changed: false,
          message: 'Invalid PR number.',
          requires: ['prNumber'],
        },
        400,
      );
    }

    const result = await getGitHubPrFileDiff(
      {
        repo: `${owner}/${repo}`,
        prNumber: number,
        path: c.req.query('path') ?? '',
        headSha: c.req.query('head')?.trim() || undefined,
        baseSha: c.req.query('base')?.trim() || undefined,
        baseRef: c.req.query('baseRef')?.trim() || undefined,
        source: sourceQuery(c.req.query('source')),
        maxPatchBytes: queryNumber(c.req.query('maxPatchBytes')),
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/prs/:owner/:repo/:number/files', async (c) => {
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');
    const number = Number(c.req.param('number'));
    if (!Number.isInteger(number) || number <= 0) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_files_get',
          changed: false,
          message: 'Invalid PR number.',
          requires: ['prNumber'],
        },
        400,
      );
    }

    const result = await getGitHubPrFiles(
      {
        repo: `${owner}/${repo}`,
        prNumber: number,
        headSha: c.req.query('head')?.trim() || undefined,
        baseSha: c.req.query('base')?.trim() || undefined,
        baseRef: c.req.query('baseRef')?.trim() || undefined,
        patches: patchesQuery(c.req.query('patches')),
        source: sourceQuery(c.req.query('source')),
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/prs/:owner/:repo/:number/review-draft', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await getGitHubPrReviewDraft(target.input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.put('/prs/:owner/:repo/:number/review-draft', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await putGitHubPrReviewDraft(
      target.input,
      (await safeJsonBody(c)) as Parameters<typeof putGitHubPrReviewDraft>[1],
      paths,
    );
    return c.json(
      withCurrentDraftOnConflict(result, target.input, paths),
      result.ok ? 200 : result.requires?.includes('currentDraft') ? 409 : 400,
    );
  });

  routes.post('/prs/:owner/:repo/:number/review-draft/comments', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await postGitHubPrReviewDraftComment(
      target.input,
      (await safeJsonBody(c)) as Parameters<
        typeof postGitHubPrReviewDraftComment
      >[1],
      paths,
    );
    return c.json(
      withCurrentDraftOnConflict(result, target.input, paths),
      result.ok ? 200 : result.requires?.includes('currentDraft') ? 409 : 400,
    );
  });

  routes.patch(
    '/prs/:owner/:repo/:number/review-draft/comments/:id',
    async (c) => {
      const target = prTargetFromParams(
        c.req.param('owner'),
        c.req.param('repo'),
        c.req.param('number'),
      );
      if (!target.ok) return c.json(target.result, 400);
      const result = await patchGitHubPrReviewDraftComment(
        target.input,
        c.req.param('id'),
        (await safeJsonBody(c)) as Parameters<
          typeof patchGitHubPrReviewDraftComment
        >[2],
        paths,
      );
      return c.json(
        withCurrentDraftOnConflict(result, target.input, paths),
        result.ok ? 200 : result.requires?.includes('currentDraft') ? 409 : 400,
      );
    },
  );

  routes.delete(
    '/prs/:owner/:repo/:number/review-draft/comments/:id',
    async (c) => {
      const target = prTargetFromParams(
        c.req.param('owner'),
        c.req.param('repo'),
        c.req.param('number'),
      );
      if (!target.ok) return c.json(target.result, 400);
      const result = await deleteGitHubPrReviewDraftComment(
        target.input,
        c.req.param('id'),
        paths,
        {
          draftId: c.req.query('draftId'),
          expectedRevision: queryInteger(c.req.query('expectedRevision')),
        },
      );
      return c.json(
        withCurrentDraftOnConflict(result, target.input, paths),
        result.ok ? 200 : result.requires?.includes('currentDraft') ? 409 : 400,
      );
    },
  );

  routes.delete('/prs/:owner/:repo/:number/review-draft', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await deleteGitHubPrReviewDraft(
      target.input,
      {
        draftId: c.req.query('draftId') ?? '',
        expectedRevision:
          queryInteger(c.req.query('expectedRevision')) ?? Number.NaN,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/:owner/:repo/:number/reviews', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const reviewInput = await safeJsonBody(c);
    const reviewInputObject = objectField(reviewInput);
    const requestedHeadSha =
      typeof reviewInputObject.headSha === 'string'
        ? reviewInputObject.headSha
        : null;
    const requestedDraftId =
      typeof reviewInputObject.draftId === 'string'
        ? reviewInputObject.draftId
        : null;
    const expectedDraftRevision =
      typeof reviewInputObject.expectedDraftRevision === 'number'
        ? reviewInputObject.expectedDraftRevision
        : null;
    if (!requestedDraftId || !expectedDraftRevision) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message: 'An exact review draft identity is required.',
        },
        400,
      );
    }
    const exactDraft = readPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      draftId: requestedDraftId,
    });
    if (
      !exactDraft ||
      exactDraft.status !== 'draft' ||
      exactDraft.repo.toLowerCase() !== target.input.repo.toLowerCase() ||
      exactDraft.prNumber !== target.input.prNumber ||
      exactDraft.revision !== expectedDraftRevision ||
      exactDraft.headSha !== requestedHeadSha
    ) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message: 'The exact review draft changed before submission.',
        },
        409,
      );
    }
    const durableReview = readPrReviewForTarget(
      target.input.repo,
      target.input.prNumber,
      paths,
    );
    if (!durableReview) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message:
            'Start and finish the durable Neon review before submitting.',
        },
        409,
      );
    }
    if (
      durableReview.status !== 'ready' ||
      !requestedHeadSha ||
      durableReview.headSha !== requestedHeadSha
    ) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message:
            durableReview.status !== 'ready'
              ? 'The durable review must be ready before it can be submitted.'
              : 'The durable review does not match the pull request head being submitted.',
          data: { reviewId: durableReview.id },
        },
        409,
      );
    }
    const verdict = reviewInputObject.verdict;
    if (
      verdict !== 'comment' &&
      verdict !== 'approve' &&
      verdict !== 'request-changes'
    ) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message: 'A review verdict is required.',
        },
        400,
      );
    }
    const draftVerdict = exactDraft.verdict ?? 'comment';
    if (draftVerdict !== verdict) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message: 'The submitted verdict does not match the exact draft.',
        },
        409,
      );
    }

    const reserved = reservePrReviewSubmission(
      {
        repoFullName: target.input.repo,
        prNumber: target.input.prNumber,
        headSha: requestedHeadSha ?? '',
        verdict: draftVerdict,
        draftId: exactDraft.id,
        draftRevision: exactDraft.revision,
      },
      paths,
    );
    if (!reserved) {
      return c.json(
        {
          ok: false,
          action: 'github_pr_review_post',
          changed: false,
          message:
            'The durable review changed before submission could be reserved. Refresh and try again.',
          data: { reviewId: durableReview.id },
        },
        409,
      );
    }

    const releaseReservation = () => {
      if (reserved) {
        releasePrReviewSubmission(
          { reviewId: reserved.id, headSha: reserved.headSha },
          paths,
        );
      }
    };
    const endSubmissionAttempt = reserved
      ? beginPrReviewSubmissionAttempt(reserved.id)
      : () => {};
    const scheduleSubmittedReviewEvidence = (
      submittedVerdict: 'comment' | 'approve' | 'request-changes',
      review: Record<string, unknown>,
    ) => {
      const githubReviewId = identifier(review.id);
      schedulePrReviewEvidenceFollowup(
        {
          id: `pr-review-evidence:${reserved.id}:${githubReviewId ?? 'unknown'}`,
          evidence: {
            origin: 'submission',
            repoFullName: target.input.repo,
            prNumber: target.input.prNumber,
            headSha: requestedHeadSha ?? '',
            reviewId: githubReviewId,
            reviewUrl: typeof review.url === 'string' ? review.url : null,
            verdict: submittedVerdict,
          },
        },
        paths,
        dependencies.recordHumanReviewSubmittedApiEvidence ??
          recordHumanReviewSubmittedApiEvidence,
      );
    };

    let githubAccepted = false;
    try {
      const result = await (
        dependencies.postGitHubPrReview ?? postGitHubPrReview
      )(
        target.input,
        {
          draftId: requestedDraftId,
          headSha: requestedHeadSha ?? '',
          expectedDraftRevision,
          commentIds: Array.isArray(reviewInputObject.commentIds)
            ? reviewInputObject.commentIds.filter(
                (id): id is string => typeof id === 'string',
              )
            : undefined,
        },
        paths,
      );
      if (!result.ok) {
        if (objectField(result.data).code === 'submission-uncertain') {
          return c.json(result, 409);
        }
        const acceptedReview = unverifiedAcceptedReview(result);
        if (acceptedReview) {
          githubAccepted = true;
          const submittedVerdict =
            prReviewVerdict(acceptedReview.draft.verdict) ?? verdict;
          const submitted = submitPrReview(
            {
              reviewId: reserved.id,
              verdict: submittedVerdict,
              githubReviewUrl:
                typeof acceptedReview.review.url === 'string'
                  ? acceptedReview.review.url
                  : null,
            },
            paths,
          );
          scheduleSubmittedReviewEvidence(
            submittedVerdict,
            acceptedReview.review,
          );
          return c.json(
            reserved && !submitted
              ? {
                  ...result,
                  message:
                    'GitHub accepted the review, but Neondeck could not verify its delivery identity or settle its durable review record.',
                }
              : result,
            409,
          );
        }
        releaseReservation();
        return c.json(result, 400);
      }
      githubAccepted = true;

      const data = objectField(result.data);
      const draft = objectField(data.draft);
      const review = objectField(data.review);
      const submittedVerdict = prReviewVerdict(draft.verdict) ?? verdict;
      const submitted = submitPrReview(
        {
          reviewId: reserved.id,
          verdict: submittedVerdict,
          githubReviewUrl: typeof review.url === 'string' ? review.url : null,
        },
        paths,
      );
      scheduleSubmittedReviewEvidence(submittedVerdict, review);
      if (!submitted) {
        return c.json(
          {
            ok: false,
            action: 'github_pr_review_post',
            changed: true,
            message:
              'GitHub accepted the review, but Neondeck could not settle its reserved durable review record.',
            data: result.data,
          },
          409,
        );
      }
      return c.json(result, 200);
    } catch (error) {
      if (!githubAccepted) releaseReservation();
      throw error;
    } finally {
      endSubmissionAttempt();
    }
  });

  routes.post(
    '/prs/:owner/:repo/:number/review-threads/:threadId/reply',
    async (c) => {
      const target = prTargetFromParams(
        c.req.param('owner'),
        c.req.param('repo'),
        c.req.param('number'),
      );
      if (!target.ok) return c.json(target.result, 400);
      const result = await postGitHubPrThreadReply(
        target.input,
        c.req.param('threadId'),
        (await safeJsonBody(c)) as Parameters<
          typeof postGitHubPrThreadReply
        >[2],
        paths,
      );
      return c.json(result, result.ok ? 200 : 400);
    },
  );

  routes.post(
    '/prs/:owner/:repo/:number/review-threads/:threadId/resolve',
    async (c) => {
      const target = prTargetFromParams(
        c.req.param('owner'),
        c.req.param('repo'),
        c.req.param('number'),
      );
      if (!target.ok) return c.json(target.result, 400);
      const result = await postGitHubPrThreadResolution(
        target.input,
        c.req.param('threadId'),
        true,
        paths,
      );
      return c.json(result, result.ok ? 200 : 400);
    },
  );

  routes.post(
    '/prs/:owner/:repo/:number/review-threads/:threadId/unresolve',
    async (c) => {
      const target = prTargetFromParams(
        c.req.param('owner'),
        c.req.param('repo'),
        c.req.param('number'),
      );
      if (!target.ok) return c.json(target.result, 400);
      const result = await postGitHubPrThreadResolution(
        target.input,
        c.req.param('threadId'),
        false,
        paths,
      );
      return c.json(result, result.ok ? 200 : 400);
    },
  );

  routes.post('/prs/event-state', async (c) => {
    const result = await getGitHubPrEventState(
      (await safeJsonBody(c)) as Parameters<typeof getGitHubPrEventState>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/review-threads', async (c) => {
    const result = await getGitHubPrReviewThreads(
      (await safeJsonBody(c)) as Parameters<typeof getGitHubPrReviewThreads>[0],
      paths,
      {},
      { signal: c.req.raw.signal, surface: true },
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/requested-changes', async (c) => {
    const result = await getGitHubPrRequestedChanges(
      (await safeJsonBody(c)) as Parameters<
        typeof getGitHubPrRequestedChanges
      >[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/branch-permissions', async (c) => {
    const result = await getGitHubPrBranchPermissions(
      (await safeJsonBody(c)) as Parameters<
        typeof getGitHubPrBranchPermissions
      >[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/comment', async (c) => {
    const result = await postGitHubPrComment(
      (await safeJsonBody(c)) as Parameters<typeof postGitHubPrComment>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}

function withCurrentDraftOnConflict<
  T extends { data?: unknown; requires?: string[] },
>(result: T, target: { repo: string; prNumber: number }, paths: RuntimePaths) {
  if (!result.requires?.includes('currentDraft')) return result;
  const currentDraft = readLivePrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: target.repo,
    prNumber: target.prNumber,
  });
  const data =
    result.data &&
    typeof result.data === 'object' &&
    !Array.isArray(result.data)
      ? result.data
      : {};
  return { ...result, data: { ...data, currentDraft } };
}

function unverifiedAcceptedReview(result: {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: unknown;
  requires?: string[];
  errors?: string[];
}) {
  if (
    result.ok ||
    !result.changed ||
    !result.requires?.includes('deliveryIdentity')
  ) {
    return null;
  }
  const data = objectField(result.data);
  const draft = objectField(data.draft);
  const review = objectField(data.review);
  if (
    (typeof review.id !== 'string' && typeof review.id !== 'number') ||
    (typeof draft.verdict !== 'string' && draft.verdict !== null)
  ) {
    return null;
  }
  return {
    draft,
    review,
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function prReviewVerdict(value: unknown) {
  return value === 'comment' ||
    value === 'approve' ||
    value === 'request-changes'
    ? value
    : null;
}

function identifier(value: unknown) {
  return typeof value === 'string' && value
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : '';
}

function queryInteger(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function prTargetFromParams(owner: string, repo: string, numberText: string) {
  const number = Number(numberText);
  if (!Number.isInteger(number) || number <= 0) {
    return {
      ok: false as const,
      result: {
        ok: false,
        action: 'github_pr_review_target',
        changed: false,
        message: 'Invalid PR number.',
        requires: ['prNumber'],
      },
    };
  }

  return {
    ok: true as const,
    input: { repo: `${owner}/${repo}`, prNumber: number },
  };
}

function patchesQuery(value: string | undefined) {
  return value === 'none' || value === 'all' ? value : undefined;
}

function sourceQuery(value: string | undefined) {
  return value === 'local' || value === 'github' || value === 'auto'
    ? value
    : undefined;
}
