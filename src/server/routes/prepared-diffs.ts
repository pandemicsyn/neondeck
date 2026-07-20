import { Hono } from 'hono';
import {
  listPreparedDiffs,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
} from '../../modules/prepared-diffs';
import type { RuntimePaths } from '../../runtime-home';
import { preparedDiffHttpStatus, queryBoolean, queryNumber } from '../http';

export function createPreparedDiffRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/prepared-diffs', async (c) => {
    const result = await listPreparedDiffs(
      {
        status: c.req.query('status') || undefined,
        includeTerminal: queryBoolean(c.req.query('includeTerminal')),
        repoId: c.req.query('repoId') || undefined,
      },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/summary', async (c) => {
    const result = await readPreparedDiffSummary(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/files', async (c) => {
    const result = await readPreparedDiffChangedFiles(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/files/diff', async (c) => {
    const result = await readPreparedDiffFileDiff(
      {
        preparedDiffId: c.req.param('id'),
        path: c.req.query('path'),
        expectedRevisionKey: c.req.query('expectedRevisionKey'),
        maxPatchBytes: queryNumber(c.req.query('maxPatchBytes')),
      },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  return routes;
}
