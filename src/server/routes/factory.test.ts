import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { requireLocalApiAccess } from '../middleware';
import { createFactoryRoutes } from './factory';
let paths: RuntimePaths;
let app: Hono;
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-api-')));
  mkdirSync(paths.data);
  writeFileSync(paths.config, JSON.stringify({ version: 1 }));
  writeFileSync(paths.repos, JSON.stringify({ version: 1, repos: [] }));
  initializeAppDatabase(paths.neondeckDatabase);
  app = new Hono();
  app.use('/api/*', requireLocalApiAccess());
  app.route(
    '/api/factory',
    createFactoryRoutes(paths, () => {}),
  );
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
const request = (
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(`http://localhost/api/factory${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
it('keeps mutation paths private and rejects cross-origin requests before persistence', async () => {
  expect(
    (await request('/state', undefined, { host: 'example.invalid' })).status,
  ).toBe(404);
  expect(
    (
      await request(
        '/config',
        { enabled: true },
        { origin: 'https://example.invalid' },
      )
    ).status,
  ).toBe(404);
  expect((await request('/state')).status).toBe(200);
  expect((await (await request('/state')).json()).enabled).toBe(false);
});
it('supports disabled setup, typed manual intake, retry, detail and input errors', async () => {
  const input = {
    requestKey: 'api-1',
    title: 'A local task',
    body: 'Synthetic source https://example.test/task',
    repoId: null,
  };
  expect((await request('/work', input)).status).toBe(403);
  expect(
    (
      await request('/config', {
        enabled: true,
        codingPolicy: 'isolated-local-v1',
      })
    ).status,
  ).toBe(200);
  const first = await (await request('/work', input)).json();
  expect((await (await request('/work', input)).json()).work.id).toBe(
    first.work.id,
  );
  expect((await request(`/work/${first.work.id}`)).status).toBe(200);
  expect(
    (await request('/work', { ...input, requestKey: 'bad', actor: 'admin' }))
      .status,
  ).toBe(400);
  expect(
    (
      await request('/work', {
        ...input,
        requestKey: 'bad',
        repoId: 'unregistered',
      })
    ).status,
  ).toBe(400);
  expect((await request('/work/missing')).status).toBe(404);
  expect(
    (
      await request(`/work/${first.work.id}/transition`, {
        expectedVersion: 10,
        action: 'pause',
      })
    ).status,
  ).toBe(409);
  const malformed = await app.request('http://localhost/api/factory/work', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect(
    (await request('/work', { ...input, body: 'x'.repeat(600000) })).status,
  ).toBe(413);
});
it('invokes the reusable triage admission entrypoint after successful persisted intake only', async () => {
  const calls: string[] = [];
  const routes = createFactoryRoutes(paths, (id) => {
    calls.push(id);
  });
  await routes.request('/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const input = {
    requestKey: 'auto-triage',
    title: 'Public fixture',
    body: 'Classify this',
    repoId: null,
  };
  const admitted = await routes.request('/work', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const work = await admitted.json();
  expect(admitted.status).toBe(200);
  expect(calls).toEqual([work.work.id]);
  const rejected = await routes.request('/work', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, unexpected: true }),
  });
  expect(rejected.status).toBe(400);
  expect(calls).toHaveLength(1);
});

it('returns 400 for malformed planning input before creating a planning intent', async () => {
  await request('/config', { enabled: true });
  const created = await (
    await request('/work', {
      requestKey: 'planning-input',
      title: 'Fixture',
      body: 'Plan',
      repoId: null,
    })
  ).json();
  for (const body of [
    { expectedVersion: 1, message: 'Plan' },
    { requestKey: 'bad-version', expectedVersion: '1', message: 'Plan' },
    null,
  ]) {
    const response = await request(`/work/${created.work.id}/planning`, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  }
  const state = await (
    await request(`/work/${created.work.id}/planning`)
  ).json();
  expect(state.sessionId).toBeNull();
});
