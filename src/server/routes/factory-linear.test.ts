import { afterEach, expect, it } from 'vitest';
import { fixture } from '../../modules/factory/testing/github-fixture';
import { createFactoryRoutes } from './factory';
import type { LinearConnection } from '../../../shared/factory-linear';
import { linearConnections } from '../../modules/factory/linear-config';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
const connection: LinearConnection = {
  id: 'linear',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: null,
  repoId: 'fixture',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  admission: { mode: 'all' },
  writeback: { enabled: false, states: {} },
};
function setup() {
  const f = fixture();
  fixtures.push(f);
  const app = createFactoryRoutes(f.paths, () => {});
  const save = (body: unknown) =>
    app.request('http://localhost/linear/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { ...f, app, save };
}
it('loads pre-Linear configuration and guards actual writes with the current fingerprint', async () => {
  const { app, paths, save } = setup();
  const initial = await (await app.request('http://localhost/linear')).json();
  expect(initial.connections).toEqual([]);
  expect(
    (
      await save({
        expectedFingerprint: initial.configFingerprint,
        connections: [connection],
      })
    ).status,
  ).toBe(200);
  const changed = await (await app.request('http://localhost/linear')).json();
  expect(changed.configFingerprint).not.toBe(initial.configFingerprint);
  expect(changed.connections[0].writeback.enabled).toBe(false);
  expect(
    (
      await save({
        expectedFingerprint: initial.configFingerprint,
        connections: [],
      })
    ).status,
  ).toBe(409);
  expect(linearConnections(paths)).toEqual([connection]);
});
it('rejects malformed mappings without replacing the saved connection', async () => {
  const { app, paths, save } = setup();
  const { configFingerprint } = await (
    await app.request('http://localhost/linear')
  ).json();
  expect(
    (
      await save({
        expectedFingerprint: configFingerprint,
        connections: [{ ...connection, tokenEnv: 'literal-secret' }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await save({
        expectedFingerprint: configFingerprint,
        connections: [connection],
        actor: 'admin',
      })
    ).status,
  ).toBe(400);
  expect(linearConnections(paths)).toEqual([]);
});
