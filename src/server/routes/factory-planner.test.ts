import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  ensureRuntimeHomeSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import {
  submitFactoryWork,
  prepareFactoryPlanning,
} from '../../modules/factory';
import { readChatSession, switchChatSession } from '../../modules/sessions';
import { createFactoryPlannerRoutes } from './factory-planner';
import { requireLocalApiAccess } from '../middleware';
let paths: RuntimePaths;
let app: Hono;
let sessionId: string;
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-route-')));
  ensureRuntimeHomeSync(paths);
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, factory: { enabled: true } }),
  );
  const task = submitFactoryWork(
    {
      requestKey: 'one',
      title: 'Public fixture',
      body: 'Plan it',
      repoId: null,
    },
    { kind: 'human', id: 'local-operator' },
    paths,
  );
  sessionId = prepareFactoryPlanning(
    task.work.id,
    { requestKey: 'm1', expectedVersion: 1, message: 'Plan' },
    paths,
  ).sessionId;
  app = new Hono();
  app.use('/api/*', requireLocalApiAccess());
  app.route(
    '/api/flue/agents/factory-planner',
    createFactoryPlannerRoutes(paths),
  );
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
it('checks binding on reads, direct sends, aborts and attachment requests before Flue', async () => {
  for (const [method, path] of [
    ['GET', ''],
    ['POST', ''],
    ['POST', '/abort'],
    ['GET', '/attachments/fake'],
  ] as const) {
    const response = await app.request(
      `http://localhost/api/flue/agents/factory-planner/other${path}`,
      { method, headers: { host: 'localhost' } },
    );
    expect(response.status).toBe(403);
  }
  const direct = await app.request(
    `http://localhost/api/flue/agents/factory-planner/${sessionId}`,
    {
      method: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({
        kind: 'signal',
        attributes: { intentId: 'forged' },
      }),
    },
  );
  expect(direct.status).toBe(403);
  const session = await app.request(
    `http://localhost/api/flue/agents/factory-planner/${sessionId}/session`,
    { headers: { host: 'localhost' } },
  );
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({
    agentName: 'factory-planner',
    kind: 'task',
  });
  expect(
    (
      await app.request(
        `http://localhost/api/flue/agents/factory-planner/${sessionId}/session`,
        { headers: { host: 'example.invalid' } },
      )
    ).status,
  ).toBe(404);
});
it('does not register planner sessions as selectable display-assistant sessions', async () => {
  expect(await readChatSession({ id: sessionId }, paths)).toMatchObject({
    ok: false,
  });
  expect(await switchChatSession({ id: sessionId }, paths)).toMatchObject({
    ok: false,
  });
});
