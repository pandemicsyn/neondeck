import { Hono } from 'hono';
import {
  listRepoEditEvents,
  patchRepoFiles,
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  searchRepoFiles,
  writeRepoFile,
} from '../../repo-edit';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createRepoEditRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/repo-edits', async (c) => {
    return c.json(await listRepoEditEvents(paths));
  });

  routes.get('/repos/:repoId/status', async (c) => {
    const result = await readRepoCheckoutStatus(
      { repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/read', async (c) => {
    const result = await readRepoFile(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/search', async (c) => {
    const result = await searchRepoFiles(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/write/preview', async (c) => {
    const result = await writeRepoFile(
      {
        ...(await safeJsonObject(c)),
        repoId: c.req.param('repoId'),
        dryRun: true,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/write', async (c) => {
    const result = await writeRepoFile(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/replace/preview', async (c) => {
    const result = await replaceRepoFile(
      {
        ...(await safeJsonObject(c)),
        repoId: c.req.param('repoId'),
        dryRun: true,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/replace', async (c) => {
    const result = await replaceRepoFile(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/patch/preview', async (c) => {
    const result = await patchRepoFiles(
      {
        ...(await safeJsonObject(c)),
        repoId: c.req.param('repoId'),
        dryRun: true,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/files/patch', async (c) => {
    const result = await patchRepoFiles(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/diff', async (c) => {
    const result = await readRepoDiff(
      { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
