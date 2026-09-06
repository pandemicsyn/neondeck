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
  app.route('/api/factory', createFactoryRoutes(paths));
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
