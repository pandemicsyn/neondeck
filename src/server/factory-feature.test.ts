import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import { getMcpRegistry } from '../domains/mcp';
import * as factory from '../modules/factory';
import { createApp, recoverFlueRuntimeServices } from './create-app';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map(async (home) => {
      await getMcpRegistry(runtimePaths(home)).stop();
      await rm(home, { recursive: true, force: true });
    }),
  );
});
async function fixture(enabled: boolean) {
  const home = await mkdtemp(join(tmpdir(), 'factory-feature-app-'));
  homes.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const config = JSON.parse(await readFile(paths.config, 'utf8'));
  await writeFile(
    paths.config,
    JSON.stringify({
      ...config,
      features: { factory: enabled },
      factory: { enabled: true },
    }),
  );
  return { paths, config };
}
it('does not expose factory APIs and keeps feature state fixed until restart', async () => {
  const { paths, config } = await fixture(false);
  const app = await createApp({ paths, runtimeServices: false });
  const headers = {
    host: 'localhost',
    'x-neondeck-api-token': config.localApi.token,
  };
  expect(
    await (await app.request('/api/features', { headers })).json(),
  ).toEqual({ factory: false });
  for (const [path, method] of [
    ['/api/factory/state', 'GET'],
    ['/api/factory/config', 'POST'],
    ['/api/factory/work', 'POST'],
    ['/api/factory/coding/state', 'GET'],
    ['/api/factory/diagnostics/health', 'GET'],
    ['/api/factory-delivery/state', 'GET'],
    ['/api/flue/agents/factory-planner/any', 'POST'],
    ['/api/repos/any/factory-workflows', 'GET'],
    ['/api/repos/any/factory-workflow-runs', 'POST'],
  ]) {
    const response = await app.request(path, { method, headers });
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }
  expect((await app.request('/api/health', { headers })).status).toBe(200);
  await writeFile(
    paths.config,
    JSON.stringify({ ...config, features: { factory: true } }),
  );
  expect(
    await (await app.request('/api/features', { headers })).json(),
  ).toEqual({ factory: false });
  expect((await app.request('/api/factory/state', { headers })).status).toBe(
    404,
  );
  const restarted = await createApp({ paths, runtimeServices: false });
  expect(
    await (await restarted.request('/api/features', { headers })).json(),
  ).toEqual({ factory: true });
  expect(
    (await restarted.request('/api/factory/state', { headers })).status,
  ).toBe(200);
});
it('skips factory planning recovery even with intake enabled', async () => {
  const { paths } = await fixture(false);
  const recover = vi
    .spyOn(factory, 'recoverFactoryPlanning')
    .mockRejectedValue(new Error('must not run'));
  await recoverFlueRuntimeServices({
    paths,
    scheduler: false,
    readBriefingConversationHistory: async () => null,
  });
  expect(recover).not.toHaveBeenCalled();
});
