import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import * as v from 'valibot';
import {
  readRepoWorkflows,
  saveRepoWorkflows,
  proposeRepoWorkflows,
  RepoWorkflowError,
  type RepoWorkflowProposalModel,
} from '../../modules/repo-workflows';
import { FactoryMutationLockError } from '../../modules/config';
import type { RuntimePaths } from '../../runtime-home';
export function createRepoWorkflowsRoutes(
  paths: RuntimePaths,
  model?: RepoWorkflowProposalModel,
) {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof FactoryMutationLockError)
      return c.json({ error: error.message }, 409);
    if (error instanceof RepoWorkflowError)
      return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json({ error: 'Invalid repository workflow request.' }, 400);
    return c.json({ error: 'Repository workflow request failed.' }, 500);
  });
  routes.get('/repos/:repoId/factory-workflows', (c) =>
    c.json(readRepoWorkflows(c.req.param('repoId'), paths)),
  );
  routes.put('/repos/:repoId/factory-workflows', async (c) =>
    c.json(saveRepoWorkflows(c.req.param('repoId'), await c.req.json(), paths)),
  );
  routes.post('/repos/:repoId/factory-workflows/propose', async (c) =>
    c.json(
      await proposeRepoWorkflows(
        c.req.param('repoId'),
        await c.req.json(),
        paths,
        model,
      ),
    ),
  );
  return routes;
}
