import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { createFactoryDeliveryRoutes } from './factory-delivery';
let home: string;
let paths: ReturnType<typeof runtimePaths>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-routes-'));
  paths = runtimePaths(home);
  mkdirSync(join(home, 'data'));
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
it('returns typed empty state and does not authorize any candidate on reads', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  const response = await app.request('/state');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deliveries: [] });
});
it('rejects incomplete grant and malformed JSON before touching execution', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  for (const body of ['{', '{}', '{"confirm":false}']) {
    const response = await app.request(
      '/deliveries/missing/publication-grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(response.status).toBe(400);
  }
});
it('has no arbitrary effect, merge or budget reset endpoint', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  for (const path of [
    '/grants',
    '/validation-grants',
    '/deliveries/x/merge',
    '/deliveries/x/effects',
    '/deliveries/x/reset-budget',
  ])
    expect((await app.request(path, { method: 'POST' })).status).toBe(404);
});
it('validates delivery pagination instead of accepting unbounded ranges', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  expect((await app.request('/deliveries?limit=101')).status).toBe(400);
  expect((await app.request('/deliveries?after=-1')).status).toBe(400);
});

it('evidence reader rejects arbitrary receipt paths', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  expect(
    (await app.request('/deliveries/invalid/evidence/invalid')).status,
  ).toBe(404);
});

it('rejects malformed workflow selection before resolving a validation policy', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  for (const query of [
    'workflowId=../other',
    'workflowId=',
    'workflowId=web&unbounded=true',
  ]) {
    expect((await app.request(`/validation-policy/demo?${query}`)).status).toBe(
      400,
    );
  }
});

it('validates explicit environment retry on the existing delivery route', async () => {
  const app = createFactoryDeliveryRoutes(paths);
  const response = await app.request('/deliveries/missing/environment/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(400);
});
