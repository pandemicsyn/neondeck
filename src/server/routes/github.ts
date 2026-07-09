import { Hono } from 'hono';
import { getGitHubPullRequest, listGitHubPrQueue } from '../../modules/github';
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
import { queryNumber, safeJsonBody } from '../http';

export function createGitHubRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/prs', async (c) => {
    const result = await listGitHubPrQueue(paths);
    const queue =
      result.ok && result.data && typeof result.data === 'object'
        ? (result.data as { queue?: unknown }).queue
        : undefined;
    if (queue && typeof queue === 'object') {
      return c.json(queue);
    }

    return c.json(
      {
        error: result.message,
        items: [],
        issues: (result.errors ?? [result.message]).map((message) => ({
          type: 'search-error',
          message,
        })),
      },
      result.requires?.includes('GITHUB_TOKEN') ? 503 : 502,
    );
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
    return c.json(result, result.ok ? 200 : 400);
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
    return c.json(result, result.ok ? 200 : 400);
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
      return c.json(result, result.ok ? 200 : 400);
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
      );
      return c.json(result, result.ok ? 200 : 400);
    },
  );

  routes.delete('/prs/:owner/:repo/:number/review-draft', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await deleteGitHubPrReviewDraft(target.input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prs/:owner/:repo/:number/reviews', async (c) => {
    const target = prTargetFromParams(
      c.req.param('owner'),
      c.req.param('repo'),
      c.req.param('number'),
    );
    if (!target.ok) return c.json(target.result, 400);
    const result = await postGitHubPrReview(
      target.input,
      (await safeJsonBody(c)) as Parameters<typeof postGitHubPrReview>[1],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
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
