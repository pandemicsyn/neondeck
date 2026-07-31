import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upsertMemory } from './modules/memory';
import { runtimePaths } from './runtime-home';
import { createMemoryRoutes } from './server/routes/memory';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('memory mutation routes', () => {
  it('returns a client error when a memory write is rejected', async () => {
    const paths = runtimePaths(await tempHome());
    const routes = createMemoryRoutes(paths);
    const response = await routes.request('/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'invalid',
        key: 'checks',
        value: 'npm run check',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      changed: false,
    });
  });

  it('returns conflict when a dashboard edit has a stale revision', async () => {
    const paths = runtimePaths(await tempHome());
    await upsertMemory(
      { scope: 'project', key: 'checks', value: 'npm run check' },
      paths,
    );
    const routes = createMemoryRoutes(paths);
    const response = await routes.request('/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        key: 'checks',
        value: 'npm run verify',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['memory-revision'],
    });
  });
});

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-memory-routes-'));
  tempRoots.push(root);
  return root;
}
