import { factoryValidationPolicy } from './validation-policy';
import { retainLinearRateLimit } from './linear-cooldown';
import { LinearApiError } from '../linear';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fixture } from './testing/github-fixture';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../shared/factory-linear';
import {
  dbRun,
  getFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
} from './service';
import { emptyFactorySpec } from '../../../shared/factory';
import { updateFactoryConfig } from '../config';
import { reserveCodingRun, getCodingRun } from '../coding-runs';
import {
  codingAuthority,
  codingConfig,
  codingDigest,
  assertCodingAuthoritySnapshot,
} from './coding-context';
import {
  reconcileLinearSource,
  linearContentFingerprint,
} from './linear-source';
import { linearFingerprint } from './linear-config';
import {
  acceptLinearDelivery,
  linearRecords,
  putLinearRecord,
} from './linear-store';
import { runFactoryLinearSync } from './linear-reconcile';
import { runFactoryLinearWriteback } from './linear-writeback';
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
  writeback: { enabled: false, states: { inbox: 'started' } },
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
function setup(enabled = false) {
  const f = fixture();
  fixtures.push(f);
  const c = { ...connection, writeback: { ...connection.writeback, enabled } };
  const config = (next = c) =>
    writeFileSync(
      f.paths.config,
      JSON.stringify({
        version: 1,
        factory: { enabled: true, linear: [next] },
        models: { default: 'faux/faux-1', prReview: 'faux/faux-1' },
        guardrails: { requiredChecks: ['npm test'] },
      }),
    );
  config();
  dbRun(f.paths, (db) =>
    reconcileLinearSource(db, c, issue, issue.id, f.paths),
  );
  return { ...f, c, config };
}
it('never reads or mutates the provider when writeback consent is off', async () => {
  const { paths } = setup();
  const io = {
    readIssue: vi.fn(async () => issue),
    updateState: vi.fn(async () => issue),
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(io.readIssue).not.toHaveBeenCalled();
  expect(io.updateState).not.toHaveBeenCalled();
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback'))).toEqual([]);
});
it('does not repeat an uncertain mutation when the provider still differs', async () => {
  const { paths } = setup(true);
  const io = {
    readIssue: vi.fn(async () => issue),
    updateState: vi.fn(
      async (
        ...args: Parameters<typeof import('../linear').updateLinearIssueState>
      ) => {
        args[4]!();
        throw new Error('Lost response');
      },
    ),
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  const uncertain = dbRun(paths, (db) => linearRecords(db, 'writeback'));
  expect(uncertain).toHaveLength(1);
  expect(uncertain[0].state).toBe('uncertain');
  dbRun(paths, (db) => putLinearRecord(db, { ...uncertain[0], retryAt: 0 }));
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(io.updateState).toHaveBeenCalledTimes(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback'))[0].state).toBe(
    'attention',
  );
});
it('rechecks operator consent after the provider read before mutation', async () => {
  const { paths, c, config } = setup(true);
  const io = {
    readIssue: vi.fn(async () => {
      config({ ...c, writeback: { ...c.writeback, enabled: false } });
      return issue;
    }),
    updateState: vi.fn(async () => issue),
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(io.updateState).not.toHaveBeenCalled();
});
it('advances retained-source checks beyond the first batch across worker invocations', async () => {
  const { paths, c } = setup();
  for (let i = 0; i < 30; i++)
    dbRun(paths, (db) =>
      reconcileLinearSource(
        db,
        c,
        { ...issue, id: `retained-${i}` },
        `retained-${i}`,
        paths,
      ),
    );
  const seen = new Set<string>();
  const io = {
    readIssue: async (_c: LinearConnection, id: string) => {
      seen.add(id);
      return { ...issue, id };
    },
    readPage: async () => ({ items: [], cursor: null }),
  };
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen.size).toBe(25);
  dbRun(paths, (db) => {
    for (const row of linearRecords(db, 'sync'))
      putLinearRecord(db, { ...row, retryAt: 0 });
  });
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen.size).toBe(31);
});
it('recovers an uncertain exact echo durably without source-version churn on later reads', async () => {
  const { paths, c } = setup(true);
  let remote = issue;
  const io = {
    readIssue: async () => remote,
    updateState: vi.fn(
      async (
        ...args: Parameters<typeof import('../linear').updateLinearIssueState>
      ) => {
        args[4]!();
        remote = {
          ...issue,
          state: { id: 'started', type: 'started' },
          updatedAt: '2026-09-07T01:00:00Z',
        };
        throw new Error('Response lost after provider commit');
      },
    ),
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  const recovered = dbRun(paths, (db) =>
    reconcileLinearSource(db, c, remote, issue.id, paths),
  )!;
  expect(recovered.source.version).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback'))[0].state).toBe(
    'complete',
  );
  const replayed = dbRun(paths, (db) =>
    reconcileLinearSource(db, c, remote, issue.id, paths),
  )!;
  expect(replayed.source.version).toBe(1);
  expect(replayed.source.status).toBe('open');
  const timestampOnly = dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      c,
      { ...remote, updatedAt: '2026-09-07T01:30:00Z' },
      issue.id,
      paths,
    ),
  )!;
  expect(timestampOnly.source.version).toBe(1);
  expect(timestampOnly.source.status).toBe('open');
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(io.updateState).toHaveBeenCalledTimes(1);
  const edited = dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      c,
      {
        ...remote,
        title: 'Independent edit',
        updatedAt: '2026-09-07T02:00:00Z',
      },
      issue.id,
      paths,
    ),
  )!;
  expect(edited.source.version).toBe(2);
  expect(edited.source.title).toBe('Independent edit');
});
it('never reflects a paused lifecycle back onto an independently completed issue', async () => {
  const { paths, c, config } = setup(true);
  const mapped = {
    ...c,
    writeback: { enabled: true, states: { paused: 'todo' } },
  };
  config(mapped);
  const terminal = {
    ...issue,
    state: { id: 'done', type: 'completed' },
    updatedAt: '2026-09-07T01:00:00Z',
  };
  const closed = dbRun(paths, (db) =>
    reconcileLinearSource(db, mapped, terminal, issue.id, paths),
  )!;
  expect(closed.source.status).toBe('closed');
  expect(closed.work.lifecycle).toBe('paused');
  const io = {
    readIssue: vi.fn(async () => terminal),
    updateState: vi.fn(async () => issue),
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(io.updateState).not.toHaveBeenCalled();
});

it.each(['remove', 'closed', 'config', 'echo', 'cooldown-remove'] as const)(
  'withdraws released authority and cancels a reserved run on %s',
  async (mode) => {
    const { paths, c } = setup();
    updateFactoryConfig(
      { coding: { enabled: true, model: 'synthetic' } },
      paths,
    );
    const initial = dbRun(paths, (db) =>
      reconcileLinearSource(db, c, issue, issue.id, paths),
    )!;
    const human = { kind: 'human' as const, id: 'operator' };
    const saved = saveFactorySpec(
      initial.work.id,
      {
        expectedVersion: initial.work.version,
        expectedSpecVersion: initial.work.specVersion,
        expectedRepoFingerprint: initial.repoFingerprint,
        spec: {
          ...emptyFactorySpec(),
          outcome: 'Outcome',
          scope: 'Scope',
          approach: 'Approach',
          acceptanceCriteria: [{ id: 'ac1', text: 'Criterion' }],
        },
      },
      human,
      paths,
    );
    const revision = saved.revisions.at(-1)!;
    const released = releaseFactoryWork(
      saved.work.id,
      {
        requestKey: 'release',
        expectedVersion: saved.work.version,
        specVersion: revision.version,
        specHash: revision.hash,
        sourceVersion: saved.source.version,
        repoFingerprint: saved.repoFingerprint,
        policyVersion: 'isolated-local-v1',
        validationPolicy: factoryValidationPolicy('fixture', paths),
        expectedCodingConfigFingerprint: codingDigest(
          codingConfig(paths).coding,
        ),
      },
      human,
      paths,
    );
    const { current, release, repo, coding } = codingAuthority(
      released.work.id,
      paths,
    );
    const snapshot = {
      requestId: `factory:${release.id}`,
      workItemId: current.work.id,
      releaseId: release.id,
      specVersion: revision.version,
      specHash: revision.hash,
      specSnapshot: JSON.stringify(revision.spec),
      sourceId: current.source.id,
      sourceSnapshot: JSON.stringify(current.source),
      repoId: repo.id,
      repoSnapshot: JSON.stringify(repo),
      policySnapshot: JSON.stringify({ release: release.policy, coding }),
      contextSnapshot: '{}',
      baseSha: 'b'.repeat(40),
      harness: { provider: 'codex', version: 'synthetic', model: 'synthetic' },
      sessionMode: 'fresh' as const,
    };
    expect(() => assertCodingAuthoritySnapshot(snapshot, paths)).not.toThrow();
    const run = reserveCodingRun(snapshot, paths);
    expect(() =>
      assertCodingAuthoritySnapshot(run.snapshot, paths),
    ).not.toThrow();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
    if (mode === 'echo') {
      const echoed = {
        ...issue,
        state: { id: 'started', type: 'started' },
        updatedAt: '2026-09-07T01:00:00Z',
      };
      dbRun(paths, (db) =>
        putLinearRecord(db, {
          id: 'synthetic-echo',
          kind: 'writeback',
          connectionId: c.id,
          connectionFingerprint: linearFingerprint(c),
          issueId: issue.id,
          workId: current.work.id,
          sourceVersion: current.source.version,
          stateId: echoed.state.id,
          baseline: linearContentFingerprint(issue),
          state: 'complete',
          error: null,
          retryAt: 0,
          attempts: 1,
          createdAt: issue.updatedAt,
          updatedAt: echoed.updatedAt,
        }),
      );
      expect(() =>
        assertCodingAuthoritySnapshot(snapshot, paths),
      ).not.toThrow();
      dbRun(paths, (db) =>
        reconcileLinearSource(db, c, echoed, issue.id, paths),
      );
      dbRun(paths, (db) =>
        reconcileLinearSource(db, c, echoed, issue.id, paths),
      );
      expect(
        getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
      ).toBeNull();
      expect(() =>
        assertCodingAuthoritySnapshot(snapshot, paths),
      ).not.toThrow();
      expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
      expect(() =>
        assertCodingAuthoritySnapshot(snapshot, paths),
      ).not.toThrow();
      return;
    }
    if (mode === 'cooldown-remove') {
      retainLinearRateLimit(
        new LinearApiError('rate limited', 429, Date.now() + 86400000, true),
        c,
        paths,
      );
      for (let i = 0; i < 30; i++)
        acceptLinearDelivery(
          {
            id: `queued-update-${i}`,
            connectionId: c.id,
            connectionFingerprint: linearFingerprint(c),
            issueId: `other-${i}`,
            action: 'update',
            digest: `update-${i}`,
            createdAt: issue.updatedAt,
          },
          paths,
        );
      acceptLinearDelivery(
        {
          id: 'signed-remove',
          connectionId: c.id,
          connectionFingerprint: linearFingerprint(c),
          issueId: issue.id,
          action: 'remove',
          digest: 'remove',
          createdAt: '2026-09-07T02:00:00Z',
        },
        paths,
      );
      const io = {
        readIssue: vi.fn(async () => issue),
        readPage: vi.fn(async () => ({ items: [], cursor: null })),
      };
      await runFactoryLinearSync(paths, undefined, io);
      expect(io.readIssue).not.toHaveBeenCalled();
      expect(io.readPage).not.toHaveBeenCalled();
      expect(
        getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
      ).not.toBeNull();
      expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
      return;
    }
    if (mode === 'config')
      updateFactoryConfig({ linear: [{ ...c, enabled: false }] }, paths);
    else
      dbRun(paths, (db) =>
        reconcileLinearSource(
          db,
          c,
          mode === 'remove'
            ? null
            : {
                ...issue,
                state: { id: 'done', type: 'completed' },
                updatedAt: '2026-09-07T01:00:00Z',
              },
          issue.id,
          paths,
        ),
      );
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  },
);

it('continues retained checks and cursor progress after one inaccessible issue', async () => {
  const { paths, c } = setup();
  for (let i = 0; i < 30; i++)
    dbRun(paths, (db) =>
      reconcileLinearSource(
        db,
        c,
        { ...issue, id: `retained-${i}` },
        `retained-${i}`,
        paths,
      ),
    );
  const ordered = dbRun(paths, (db) =>
    db
      .prepare('SELECT record FROM factory_sources ORDER BY id')
      .all()
      .map(
        (row) =>
          JSON.parse(String(row.record)) as { linear: { issueId: string } },
      ),
  );
  const inaccessible = ordered[0].linear.issueId;
  const transferred = ordered[26].linear.issueId;
  const seen = new Set<string>();
  const io = {
    readIssue: async (_c: LinearConnection, id: string) => {
      seen.add(id);
      if (id === inaccessible) throw new Error('Provider denies access');
      return {
        ...issue,
        id,
        team: { id: id === transferred ? 'other-team' : 'team' },
        updatedAt: '2026-09-07T01:00:00Z',
      };
    },
    readPage: async () => ({ items: [], cursor: null }),
  };
  await runFactoryLinearSync(paths, undefined, io);
  dbRun(paths, (db) => {
    for (const row of linearRecords(db, 'sync'))
      putLinearRecord(db, { ...row, retryAt: 0 });
  });
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen.size).toBe(31);
  const closed = dbRun(paths, (db) =>
    db
      .prepare('SELECT record FROM factory_sources WHERE request_key=?')
      .get(`linear:org:${transferred}`),
  );
  expect(JSON.parse(String(closed!.record)).status).toBe('closed');
});

it('refreshes retained authority during discovery failure and its backoff', async () => {
  const { paths, c } = setup();
  for (let i = 0; i < 30; i++)
    dbRun(paths, (db) =>
      reconcileLinearSource(
        db,
        c,
        { ...issue, id: `retained-${i}` },
        `retained-${i}`,
        paths,
      ),
    );
  const rows = dbRun(paths, (db) =>
    db
      .prepare(
        'SELECT s.record,w.id AS work_id FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id ORDER BY s.id',
      )
      .all(),
  );
  const targetId = String(rows[26].work_id);
  const targetIssue = (
    JSON.parse(String(rows[26].record)) as { linear: { issueId: string } }
  ).linear.issueId;
  const initial = getFactoryWork(targetId, paths);
  const human = { kind: 'human' as const, id: 'operator' };
  const saved = saveFactorySpec(
    targetId,
    {
      expectedVersion: initial.work.version,
      expectedSpecVersion: initial.work.specVersion,
      expectedRepoFingerprint: initial.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Outcome',
        scope: 'Scope',
        approach: 'Approach',
        acceptanceCriteria: [{ id: 'ac1', text: 'Criterion' }],
      },
    },
    human,
    paths,
  );
  const revision = saved.revisions.at(-1)!;
  releaseFactoryWork(
    targetId,
    {
      requestKey: 'release',
      expectedVersion: saved.work.version,
      specVersion: revision.version,
      specHash: revision.hash,
      sourceVersion: saved.source.version,
      repoFingerprint: saved.repoFingerprint,
      policyVersion: 'isolated-local-v1',
      validationPolicy: factoryValidationPolicy('fixture', paths),
      expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
    },
    human,
    paths,
  );
  const seen = new Set<string>();
  let discoveryCalls = 0;
  const io = {
    readIssue: async (_c: LinearConnection, id: string) => {
      seen.add(id);
      return {
        ...issue,
        id,
        state:
          id === targetIssue ? { id: 'done', type: 'completed' } : issue.state,
        updatedAt: '2026-09-07T01:00:00Z',
      };
    },
    readPage: async () => {
      discoveryCalls++;
      throw new Error('Discovery temporarily unavailable');
    },
  };
  await runFactoryLinearSync(paths, undefined, io);
  expect(seen.size).toBe(25);
  expect(getFactoryWork(targetId, paths).releases[0].withdrawnAt).toBeNull();
  expect(dbRun(paths, (db) => linearRecords(db, 'sync'))[0].offset).toBe(25);
  await runFactoryLinearSync(paths, undefined, io);
  expect(discoveryCalls).toBe(1);
  expect(seen.size).toBe(31);
  expect(dbRun(paths, (db) => linearRecords(db, 'sync'))[0].offset).toBe(0);
  expect(getFactoryWork(targetId, paths).source.status).toBe('closed');
  expect(
    getFactoryWork(targetId, paths).releases[0].withdrawnAt,
  ).not.toBeNull();
});
