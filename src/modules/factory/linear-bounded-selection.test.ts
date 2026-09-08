import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { fixture } from './testing/github-fixture';
import type { LinearConnection } from '../../../shared/factory-linear';
import { dbRun } from './service';
import { linearFingerprint } from './linear-config';
import {
  acceptLinearDelivery,
  linearRecords,
  linearRecordSchema,
  putLinearRecord,
} from './linear-store';
import {
  requestFactoryLinearSync,
  runFactoryLinearSync,
} from './linear-reconcile';
import { processLinearRemovals } from './linear-removals';
import { reconcileLinearSource } from './linear-source';

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
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
function setup() {
  const f = fixture();
  fixtures.push(f);
  writeFileSync(
    f.paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true, linear: [connection] },
      models: { default: 'faux/faux-1' },
    }),
  );
  return f;
}
function delivery(index: number, action: 'update' | 'remove' = 'update') {
  const row = v.parse(linearRecordSchema, {
    id: `delivery:${index}`,
    kind: 'delivery',
    connectionId: connection.id,
    connectionFingerprint: linearFingerprint(connection),
    issueId: `issue-${index}`,
    action,
    createdAt: '2026-09-07T00:00:00Z',
    digest: String(index),
    state: 'pending',
    retryAt: 0,
    attempts: 0,
    error: null,
  });
  if (row.kind !== 'delivery') throw new Error('Expected delivery fixture.');
  return row;
}
it('selects oldest due deliveries before parsing unrelated or deferred history', async () => {
  const { paths } = setup();
  dbRun(paths, (db) => {
    // Deliberately invalid payloads outside the query must never be decoded by a worker.
    const insert = db.prepare(
      "INSERT INTO factory_linear_records(id,kind,record) VALUES(?,'delivery',?)",
    );
    for (const row of [
      {
        id: 'foreign',
        connectionId: 'other',
        action: 'update',
        state: 'complete',
        retryAt: 0,
      },
      {
        id: 'completed',
        connectionId: connection.id,
        action: 'update',
        state: 'complete',
        retryAt: 0,
      },
      {
        id: 'deferred',
        connectionId: connection.id,
        connectionFingerprint: linearFingerprint(connection),
        action: 'update',
        state: 'pending',
        retryAt: Date.now() + 600000,
      },
    ])
      insert.run(row.id, JSON.stringify(row));
    for (let index = 0; index < 26; index++)
      putLinearRecord(db, delivery(index));
  });
  const seen: string[] = [];
  const io = {
    readIssue: async (_c: LinearConnection, id: string) => {
      seen.push(id);
      return null;
    },
    readPage: async () => ({ items: [], cursor: null }),
  };
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen).toEqual(
    Array.from({ length: 25 }, (_, index) => `issue-${index}`),
  );
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen.at(-1)).toBe('issue-25');
  expect(seen).toHaveLength(26);
});

function seedDeliveries(
  paths: ReturnType<typeof setup>['paths'],
  count: number,
  state: 'pending' | 'attention',
) {
  dbRun(paths, (db) => {
    const insert = db.prepare(
      "INSERT INTO factory_linear_records(id,kind,record) VALUES(?,'delivery',?)",
    );
    for (let index = 0; index < count; index++) {
      const row = { ...delivery(index), state };
      insert.run(row.id, JSON.stringify(row));
    }
  });
}
const incoming = {
  id: 'fresh',
  connectionId: connection.id,
  connectionFingerprint: linearFingerprint(connection),
  issueId: 'fresh-issue',
  action: 'update' as const,
  digest: 'fresh-digest',
  createdAt: '2026-09-07T00:00:00Z',
};
it('admits fresh deliveries after failures while keeping attention history bounded and deduplicated', () => {
  const { paths } = setup();
  seedDeliveries(paths, 10001, 'attention');
  expect(acceptLinearDelivery(incoming, paths).duplicate).toBe(false);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'attention' })),
  ).toHaveLength(10000);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { id: 'delivery:0' })),
  ).toEqual([]);
  expect(
    acceptLinearDelivery(
      { ...incoming, id: '10000', issueId: 'issue-10000', digest: '10000' },
      paths,
    ).duplicate,
  ).toBe(true);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'delivery', { id: 'delivery:10000' }),
    )[0].state,
  ).toBe('attention');
});
it('caps active deliveries for webhook and manual sync while permitting an existing pending retry refresh', () => {
  const { paths } = setup();
  const current = dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      connection,
      {
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
      },
      'issue',
      paths,
    ),
  )!;
  seedDeliveries(paths, 5000, 'pending');
  expect(() => acceptLinearDelivery(incoming, paths)).toThrow('queue is full');
  expect(() => requestFactoryLinearSync(current.work.id, paths)).toThrow(
    'queue is full',
  );
  dbRun(paths, (db) => {
    db.prepare(
      "DELETE FROM factory_linear_records WHERE id='delivery:0'",
    ).run();
  });
  expect(requestFactoryLinearSync(current.work.id, paths).accepted).toBe(true);
  expect(requestFactoryLinearSync(current.work.id, paths).accepted).toBe(true);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'pending' })),
  ).toHaveLength(5000);
});

it('does not charge authenticated removal backlog against provider-read capacity', () => {
  const { paths } = setup();
  dbRun(paths, (db) => {
    const insert = db.prepare(
      "INSERT INTO factory_linear_records(id,kind,record) VALUES(?,'delivery',?)",
    );
    for (let index = 0; index < 5000; index++) {
      const row = delivery(index, 'remove');
      insert.run(row.id, JSON.stringify(row));
    }
  });
  expect(acceptLinearDelivery(incoming, paths).duplicate).toBe(false);
  expect(acceptLinearDelivery(incoming, paths).duplicate).toBe(true);
  expect(() =>
    acceptLinearDelivery({ ...incoming, digest: 'conflicting' }, paths),
  ).toThrow('identity conflict');
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'delivery', { action: 'remove', state: 'pending' }),
    ),
  ).toHaveLength(5000);
});

it('removal batches use oldest due rows and eventually process the tail', () => {
  const { paths } = setup();
  dbRun(paths, (db) => {
    for (let index = 0; index < 26; index++)
      putLinearRecord(db, delivery(index, 'remove'));
    putLinearRecord(db, {
      ...delivery(99, 'remove'),
      retryAt: Date.now() + 600000,
    });
  });
  processLinearRemovals([connection], paths);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'complete' })),
  ).toHaveLength(25);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'delivery', { id: 'delivery:25' }),
    )[0].state,
  ).toBe('pending');
  processLinearRemovals([connection], paths);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'complete' })),
  ).toHaveLength(26);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'delivery', { id: 'delivery:99' }),
    )[0].state,
  ).toBe('pending');
});

it.each(['removed', 'disabled'] as const)(
  'recovers full pending capacity locally when a connection is %s',
  async (mode) => {
    const { paths } = setup();
    seedDeliveries(paths, 5000, 'pending');
    dbRun(paths, (db) => {
      db.prepare(
        "UPDATE factory_linear_records SET record=json_set(record,'$.action',CASE WHEN rowid%3=0 THEN 'create' WHEN rowid%3=1 THEN 'update' ELSE 'retry' END) WHERE kind='delivery'",
      ).run();
    });
    writeFileSync(
      paths.config,
      JSON.stringify({
        version: 1,
        factory: {
          enabled: true,
          linear: mode === 'removed' ? [] : [{ ...connection, enabled: false }],
        },
        models: { default: 'faux/faux-1' },
      }),
    );
    delete process.env.FACTORY_TEST_TOKEN;
    let providerCalls = 0;
    await runFactoryLinearSync(paths, undefined, {
      readIssue: async () => {
        providerCalls++;
        return null;
      },
      readPage: async () => {
        providerCalls++;
        return { items: [], cursor: null };
      },
    });
    expect(providerCalls).toBe(0);
    expect(
      dbRun(paths, (db) =>
        linearRecords(db, 'delivery', { state: 'attention' }),
      ),
    ).toHaveLength(25);
    expect(
      dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'pending' })),
    ).toHaveLength(4975);
    expect(
      acceptLinearDelivery(
        { ...incoming, connectionId: 'new-enabled-connection' },
        paths,
      ).accepted,
    ).toBe(true);
  },
);

it('quarantines stale bindings past valid pending rows without requiring provider credentials', async () => {
  const { paths } = setup();
  seedDeliveries(paths, 30, 'pending');
  dbRun(paths, (db) =>
    putLinearRecord(db, {
      ...delivery(31),
      connectionFingerprint: 'obsolete-binding',
    }),
  );
  delete process.env.FACTORY_TEST_TOKEN;
  let providerCalls = 0;
  await runFactoryLinearSync(paths, undefined, {
    readIssue: async () => {
      providerCalls++;
      return null;
    },
    readPage: async () => {
      providerCalls++;
      return { items: [], cursor: null };
    },
  });
  expect(providerCalls).toBe(0);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { state: 'pending' })),
  ).toHaveLength(30);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'delivery', { id: 'delivery:31' }),
    )[0].state,
  ).toBe('attention');
});
