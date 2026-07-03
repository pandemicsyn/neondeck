import { Hono } from 'hono';
import { listGitHubPrQueue } from '../../github-actions';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrEventState,
  getGitHubPrRequestedChanges,
  getGitHubPrReviewThreads,
  postGitHubPrComment,
} from '../../pr-event-state';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonBody } from '../http';

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
