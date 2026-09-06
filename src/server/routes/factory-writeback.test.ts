import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFactoryRoutes } from './factory';
import {
  fixture,
  connection,
  issue,
} from '../../modules/factory/testing/github-fixture';
import { dbRun, reconcileGitHubSource } from '../../modules/factory/service';
import {
  getWritebackState,
  setWritebackPolicy,
} from '../../modules/factory/writeback-store';
import { connectionFingerprint } from '../../modules/factory/github-config';
let setup: ReturnType<typeof fixture>;
let id: string;
let approval: {
  requestKey: string;
  expectedVersion: number;
  specVersion: number;
  specHash: string;
  sourceVersion: number;
  issueId: string;
  decisionId: null;
};
beforeEach(() => {
  setup = fixture();
  const detail = dbRun(setup.paths, (db) =>
    reconcileGitHubSource(
      db,
      { ...connection, connectionId: connection.id, issue },
      setup.paths,
    ),
  );
  id = detail.work.id;
  const rev = detail.revisions.at(-1)!;
  approval = {
    requestKey: crypto.randomUUID(),
    expectedVersion: detail.work.version,
    specVersion: rev.version,
    specHash: rev.hash,
    sourceVersion: detail.source.version,
    issueId: String(issue.id),
    decisionId: null,
  };
  setWritebackPolicy(
    connection.id,
    {
      enabled: true,
      expectedEpoch: state().policy.epoch,
      expectedFingerprint: connectionFingerprint(connection),
    },
    { kind: 'human', id: 'local-operator' },
    setup.paths,
  );
});
afterEach(() => setup.dispose());
const state = () => getWritebackState(id, setup.paths);

it.each(['summary', 'question'] as const)(
  'rejects whitespace-only %s approval through the API without changing meaningful text',
  async (kind) => {
    const app = new Hono().route(
      '/api/factory',
      createFactoryRoutes(setup.paths, () => {}),
    );
    const send = (body: string) =>
      app.request(`http://localhost/api/factory/work/${id}/writeback/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...approval, kind, body }),
      });
    for (const body of [' ', '\t\r\n', '\u00a0\u2003']) {
      expect((await send(body)).status).toBe(400);
      expect(state().approvals).toHaveLength(0);
      expect(state().effects).toHaveLength(0);
    }
    const body = '  Approved meaningful text.\n';
    expect((await send(body)).status).toBe(200);
    expect(state().approvals[0].body).toBe(body);
  },
);
