import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { FactoryError } from '../../modules/factory';
import { RepoWorkflowError } from '../../modules/repo-workflows';
import {
  startRepoWorkflowRun,
  getRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from '../../modules/repo-workflow-runs';
const services = {
  startRepoWorkflowRun,
  getRepoWorkflowRun,
  cancelRepoWorkflowRun,
};
export function createRepoWorkflowRunsRoutes(
  paths: RuntimePaths,
  io: typeof services = services,
) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 8192 }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof FactoryError || error instanceof RepoWorkflowError)
      return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json({ error: 'Invalid workflow test request.' }, 400);
    return c.json(
      {
        error:
          'Workflow test could not complete. Inspect retained test status.',
      },
      500,
    );
  });
  app.post('/repos/:repoId/factory-workflow-runs', async (c) =>
    c.json(
      await io.startRepoWorkflowRun(
        c.req.param('repoId'),
        await c.req.json(),
        paths,
      ),
      202,
    ),
  );
  app.get('/repos/:repoId/factory-workflow-runs/:runId', async (c) =>
    c.json(
      await io.getRepoWorkflowRun(
        c.req.param('repoId'),
        c.req.param('runId'),
        paths,
      ),
    ),
  );
  app.post('/repos/:repoId/factory-workflow-runs/:runId/cancel', async (c) =>
    c.json(
      await io.cancelRepoWorkflowRun(
        c.req.param('repoId'),
        c.req.param('runId'),
        paths,
      ),
    ),
  );
  return app;
}
