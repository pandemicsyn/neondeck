import { resumeFactoryPlanning } from './planning-dispatch';
import { updatePlanningIntent } from './planning-store';
import { LinearApiError } from '../linear';
import { runFactoryLinearWriteback } from './linear-writeback';
import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { fixture } from './testing/github-fixture';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../shared/factory-linear';
import { dbRun, getFactoryWork } from './service';
import { reconcileLinearSource } from './linear-source';
import {
  acceptLinearDelivery,
  linearRecordSchema,
  linearRecords,
  putLinearRecord,
} from './linear-store';
import { linearFingerprint } from './linear-config';
import { linearContentFingerprint } from './linear-source';
import { runFactoryLinearSync } from './linear-reconcile';
const connection: LinearConnection = {
  id: 'linear',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: null,
  repoId: 'fixture',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  admission: { mode: 'state', value: 'todo' },
  writeback: { enabled: false, states: {} },
};
const issue: LinearIssue = {
  id: 'issue',
  identifier: 'PRO-1',
  url: 'https://linear.app/example/issue/PRO-1',
  title: 'Task',
  description: 'Body',
  updatedAt: '2026-09-07T00:00:00Z',
  archivedAt: null,
  team: { id: 'team' },
  project: null,
  state: { id: 'todo', type: 'unstarted' },
  labels: [],
};
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
function setup(connections = [connection]) {
  const f = fixture();
  fixtures.push(f);
  writeFileSync(
    f.paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true, linear: connections },
      models: { default: 'faux/faux-1' },
    }),
  );
  return f;
}
it('durably deduplicates delivery IDs and rejects conflicting reuse', () => {
  const { paths } = setup();
  const input = {
    id: 'delivery',
    connectionId: 'linear',
    connectionFingerprint: linearFingerprint(connection),
    issueId: issue.id,
    action: 'update' as const,
    digest: 'abc',
    createdAt: issue.updatedAt,
  };
  expect(acceptLinearDelivery(input, paths).duplicate).toBe(false);
  expect(acceptLinearDelivery(input, paths).duplicate).toBe(true);
  expect(() =>
    acceptLinearDelivery({ ...input, digest: 'different' }, paths),
  ).toThrow('identity conflict');
  expect(dbRun(paths, (db) => linearRecords(db, 'delivery'))).toHaveLength(1);
});
it('retains stable identity, ignores reordered reads, and closes loss of admission', () => {
  const { paths } = setup();
  const first = dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, issue, issue.id, paths),
  )!;
  const newer = {
    ...issue,
    title: 'New title',
    updatedAt: '2026-09-07T01:00:00Z',
  };
  dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, newer, issue.id, paths),
  );
  dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, issue, issue.id, paths),
  );
  expect(getFactoryWork(first.work.id, paths).source.title).toBe('New title');
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      connection,
      {
        ...newer,
        state: { id: 'other', type: 'started' },
        updatedAt: '2026-09-07T02:00:00Z',
      },
      issue.id,
      paths,
    ),
  );
  expect(getFactoryWork(first.work.id, paths).source.status).toBe('closed');
});
it('does not admit ambiguous repository mappings', () => {
  const { paths } = setup([connection, { ...connection, id: 'other' }]);
  expect(
    dbRun(paths, (db) =>
      reconcileLinearSource(db, connection, issue, issue.id, paths),
    ),
  ).toBeNull();
});
it('suppresses only a current exact writeback echo and preserves independent title edits', () => {
  const { paths } = setup();
  const first = dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, issue, issue.id, paths),
  )!;
  const echo = {
    ...issue,
    state: { id: 'started', type: 'started' },
    updatedAt: '2026-09-07T01:00:00Z',
  };
  dbRun(paths, (db) =>
    putLinearRecord(
      db,
      v.parse(linearRecordSchema, {
        id: 'effect',
        kind: 'writeback',
        connectionId: connection.id,
        connectionFingerprint: linearFingerprint(connection),
        issueId: issue.id,
        workId: first.work.id,
        sourceVersion: first.source.version,
        stateId: 'started',
        baseline: linearContentFingerprint(issue),
        updatedAt: echo.updatedAt,
        state: 'complete',
        error: null,
        retryAt: 0,
        attempts: 1,
      }),
    ),
  );
  dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, echo, issue.id, paths),
  );
  expect(getFactoryWork(first.work.id, paths).source.version).toBe(1);
  expect(getFactoryWork(first.work.id, paths).source.status).toBe('open');
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      connection,
      { ...echo, title: 'Human edit', updatedAt: '2026-09-07T02:00:00Z' },
      issue.id,
      paths,
    ),
  );
  expect(getFactoryWork(first.work.id, paths).source.version).toBe(2);
  expect(getFactoryWork(first.work.id, paths).source.title).toBe('Human edit');
});
it('persists discovery pagination for the next worker invocation', async () => {
  const { paths } = setup();
  const cursors: (string | null)[] = [];
  const io = {
    readIssue: async () => issue,
    readPage: async (_c: LinearConnection, cursor: string | null) => {
      cursors.push(cursor);
      return { items: [issue], cursor: cursor ? null : 'page2' };
    },
  };
  await runFactoryLinearSync(paths, undefined, io);
  await runFactoryLinearSync(paths, undefined, io);
  expect(cursors).toEqual([null, 'page2']);
});

it('shares durable provider cooldown across discovery, retained reads and writeback', async () => {
  const configured: LinearConnection = {
    ...connection,
    writeback: { enabled: true, states: { inbox: 'started' } },
  };
  const { paths } = setup([configured]);
  dbRun(paths, (db) =>
    reconcileLinearSource(db, configured, issue, issue.id, paths),
  );
  let pageCalls = 0;
  let reads = 0;
  let updates = 0;
  const retryAt = Date.now() + 120000;
  const io = {
    readIssue: async () => {
      reads++;
      return issue;
    },
    readPage: async () => {
      pageCalls++;
      if (pageCalls === 1)
        throw new LinearApiError('provider details', 429, retryAt, true);
      return { items: [], cursor: null };
    },
  };
  await runFactoryLinearSync(paths, undefined, io);
  expect(reads).toBe(0);
  const cooldown = dbRun(
    paths,
    (db) => linearRecords(db, 'sync', { id: 'cooldown:linear' })[0],
  );
  expect(cooldown.retryAt).toBe(retryAt);
  expect(cooldown.error).not.toContain('provider details');
  await runFactoryLinearSync(paths, undefined, io);
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: io.readIssue,
    updateState: async () => {
      updates++;
      return {
        id: issue.id,
        state: { id: 'started' },
        updatedAt: issue.updatedAt,
      };
    },
  });
  expect(pageCalls).toBe(1);
  expect(reads).toBe(0);
  expect(updates).toBe(0);
  dbRun(paths, (db) => putLinearRecord(db, { ...cooldown, retryAt: 0 }));
  await runFactoryLinearSync(paths, undefined, io);
  expect(pageCalls).toBe(2);
  expect(reads).toBe(1);
});

it('stops remaining writeback requests when a mutation is rate limited', async () => {
  const configured: LinearConnection = {
    ...connection,
    writeback: { enabled: true, states: { inbox: 'started' } },
  };
  const { paths } = setup([configured]);
  dbRun(paths, (db) => {
    reconcileLinearSource(db, configured, issue, issue.id, paths);
    reconcileLinearSource(
      db,
      configured,
      { ...issue, id: 'issue2' },
      'issue2',
      paths,
    );
  });
  let reads = 0;
  let mutations = 0;
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async (_connection, id) => {
      reads++;
      return { ...issue, id };
    },
    updateState: async () => {
      mutations++;
      throw new LinearApiError('rate limit', 429, Date.now() + 120000, true);
    },
  });
  expect(reads).toBe(1);
  expect(mutations).toBe(1);
  expect(
    dbRun(
      paths,
      (db) => linearRecords(db, 'sync', { id: 'cooldown:linear' })[0],
    ).state,
  ).toBe('attention');
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback'))[0].state).toBe(
    'pending',
  );
});

it('dispatches existing durable triage once for duplicate intake and never for removal', async () => {
  const { paths } = setup();
  const input = {
    connectionId: connection.id,
    connectionFingerprint: linearFingerprint(connection),
    issueId: issue.id,
    action: 'update' as const,
    digest: 'same',
    createdAt: issue.updatedAt,
  };
  acceptLinearDelivery({ ...input, id: 'intake1' }, paths);
  acceptLinearDelivery({ ...input, id: 'intake2' }, paths);
  const dispatches: string[] = [];
  const completions: Promise<void>[] = [];
  const planning: typeof resumeFactoryPlanning = (id, runtime) => {
    const promise = resumeFactoryPlanning(id, runtime, {
      dispatch: async (intent) => {
        dispatches.push(intent.id);
        return { submissionId: 'synthetic-submission' };
      },
      abort: async () => {},
      read: async (intent) => {
        updatePlanningIntent(
          intent.id,
          (row) => {
            row.stage = 'completed';
          },
          paths,
        );
      },
    });
    completions.push(promise);
    return promise;
  };
  const io = {
    readIssue: async () => issue,
    readPage: async () => ({ items: [issue], cursor: null }),
    planning,
  };
  await runFactoryLinearSync(paths, undefined, io);
  await Promise.all(completions);
  await runFactoryLinearSync(paths, undefined, io);
  await Promise.all(completions);
  expect(dispatches).toHaveLength(1);
  expect(
    dbRun(paths, (db) =>
      Number(
        db
          .prepare('SELECT count(*) AS count FROM factory_planning_intents')
          .get()!.count,
      ),
    ),
  ).toBe(1);
  acceptLinearDelivery(
    {
      ...input,
      id: 'remove',
      action: 'remove',
      digest: 'removed',
      createdAt: '2026-09-07T02:00:00Z',
    },
    paths,
  );
  await runFactoryLinearSync(paths, undefined, io);
  await Promise.all(completions);
  expect(dispatches).toHaveLength(1);
});
