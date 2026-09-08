import { afterEach, expect, it } from 'vitest';
import { fixture } from '../../modules/factory/testing/github-fixture';
import { createFactoryRoutes } from './factory';
import type { LinearConnection } from '../../../shared/factory-linear';
import { linearConnections } from '../../modules/factory/linear-config';
import { linearFingerprint } from '../../modules/factory/linear-config';
import { dbRun } from '../../modules/factory/service';
import {
  acceptLinearDelivery,
  linearRecordSchema,
  putLinearRecord,
} from '../../modules/factory/linear-store';
import { factoryLinearStateSchema } from '../../../shared/factory-linear';
import * as v from 'valibot';

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

it('serves durable state with composite IDs built from maximum-length configured IDs', async () => {
  const { app, paths, save } = setup();
  const configured = {
    ...connection,
    id: 'c'.repeat(240),
    writeback: { enabled: true, states: { queued: 's'.repeat(240) } },
  };
  const initial = await (await app.request('http://localhost/linear')).json();
  expect(
    (
      await save({
        expectedFingerprint: initial.configFingerprint,
        connections: [configured],
      })
    ).status,
  ).toBe(200);
  const fingerprint = linearFingerprint(configured);
  const common = {
    connectionId: configured.id,
    connectionFingerprint: fingerprint,
    state: 'pending',
    error: null,
    retryAt: 0,
    attempts: 0,
  };
  const workId = '11111111-1111-4111-8111-111111111111';
  const syncId = `sync:${configured.id}`;
  const readFailureId = `read-failure:${configured.id}:${workId}`;
  const effectId = `writeback:${workId}:1:${configured.writeback.states.queued}`;
  const deliveryId = 'd'.repeat(240);
  dbRun(paths, (db) => {
    for (const row of [
      { ...common, id: syncId, kind: 'sync', cursor: null },
      { ...common, id: readFailureId, kind: 'read-failure', issueId: 'issue' },
      {
        ...common,
        id: effectId,
        kind: 'writeback',
        issueId: 'issue',
        workId,
        stateId: configured.writeback.states.queued,
        sourceVersion: 1,
        baseline: 'baseline',
      },
    ])
      putLinearRecord(db, v.parse(linearRecordSchema, row));
  });
  acceptLinearDelivery(
    {
      id: deliveryId,
      connectionId: configured.id,
      connectionFingerprint: fingerprint,
      issueId: 'issue',
      action: 'update',
      digest: 'digest',
      createdAt: '2026-09-07T00:00:00Z',
    },
    paths,
  );
  const response = await app.request('http://localhost/linear');
  expect(response.status).toBe(200);
  const state = v.parse(factoryLinearStateSchema, await response.json());
  expect(state.sync.map((row) => row.id)).toEqual([syncId, readFailureId]);
  expect(state.deliveries[0].id).toBe(`delivery:${deliveryId}`);
  expect(state.writebacks[0].id).toBe(effectId);
  expect(state.writebacks[0].stateId).toHaveLength(240);
  expect(
    v.safeParse(factoryLinearStateSchema, {
      ...state,
      sync: [{ ...state.sync[0], id: 'x'.repeat(2001) }],
    }).success,
  ).toBe(false);
});
