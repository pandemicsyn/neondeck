import { factoryValidationPolicy } from './validation-policy';
import { LinearApiError } from '../linear';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { reconcileLinearSource } from './linear-source';
import { linearFingerprint } from './linear-config';
import { acceptLinearDelivery, linearRecords } from './linear-store';
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
function releasedFixture() {
  const { paths, c } = setup();
  updateFactoryConfig({ coding: { enabled: true, model: 'synthetic' } }, paths);
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
      expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
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
  return { paths, c, current, run };
}

it.each(['network', 'server', 'abort'] as const)(
  'preserves released/run authority after %s retained failure',
  async (mode) => {
    const { paths, c, current, run } = releasedFixture();
    const controller = new AbortController();
    let calls = 0;
    await runFactoryLinearSync(paths, controller.signal, {
      readPage: async () => ({ items: [], cursor: null }),
      readIssue: async () => {
        calls++;
        if (mode === 'abort') {
          controller.abort();
          throw new DOMException('cancelled', 'AbortError');
        }
        throw mode === 'server'
          ? new LinearApiError('temporary', 503)
          : new Error('network');
      },
    });
    const latest = getFactoryWork(current.work.id, paths);
    expect(latest.source.version).toBe(current.source.version);
    expect(latest.source.attention).toBeFalsy();
    expect(latest.releases[0].withdrawnAt).toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
    expect(calls).toBe(1);
    const failed = dbRun(paths, (db) => linearRecords(db, 'read-failure')[0]);
    expect(failed.issueId).toBe(issue.id);
    expect(failed.error).toContain('without changing task authority');
    expect(failed.attempts).toBe(mode === 'abort' ? 0 : 1);
    // A successful current source snapshot clears this failure regardless of worker path.
    dbRun(paths, (db) => reconcileLinearSource(db, c, issue, issue.id, paths));
    expect(dbRun(paths, (db) => linearRecords(db, 'read-failure'))).toEqual([]);
  },
);

it('processes later removals before slow I/O and resumes later connection discovery after restart', async () => {
  const { paths, c, current, run } = releasedFixture();
  const slow = { ...c, id: 'slow', teamId: 'slow-team' };
  const config = JSON.parse(readFileSync(paths.config, 'utf8'));
  config.factory.linear = [slow, c];
  writeFileSync(paths.config, JSON.stringify(config));
  acceptLinearDelivery(
    {
      id: 'later-remove',
      connectionId: c.id,
      connectionFingerprint: linearFingerprint(c),
      issueId: issue.id,
      action: 'remove',
      digest: 'remove',
      createdAt: '2026-09-07T02:00:00Z',
    },
    paths,
  );
  const first = new AbortController();
  const calls: string[] = [];
  await runFactoryLinearSync(paths, first.signal, {
    readIssue: async () => {
      throw new Error('unexpected read');
    },
    readPage: async (connection) => {
      calls.push(connection.id);
      first.abort();
      throw new DOMException('tick expired', 'AbortError');
    },
  });
  expect(calls).toEqual(['slow']);
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).not.toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  const second = new AbortController();
  await runFactoryLinearSync(paths, second.signal, {
    readIssue: async () => issue,
    readPage: async (connection) => {
      calls.push(connection.id);
      second.abort();
      throw new DOMException('tick expired', 'AbortError');
    },
  });
  expect(calls).toEqual(['slow', c.id]);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'schedule', { id: 'connection-schedule' }),
    ),
  ).toHaveLength(1);
});

it('advances retained cursor before a cancelled read so the next tick reaches later sources', async () => {
  const { paths, c } = setup();
  dbRun(paths, (db) =>
    reconcileLinearSource(db, c, { ...issue, id: 'second' }, 'second', paths),
  );
  const ordered = dbRun(paths, (db) =>
    db
      .prepare('SELECT record FROM factory_sources ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.record)).linear.issueId as string),
  );
  const controller = new AbortController();
  const calls: string[] = [];
  await runFactoryLinearSync(paths, controller.signal, {
    readPage: async () => ({ items: [], cursor: null }),
    readIssue: async (_connection, id) => {
      calls.push(id);
      controller.abort();
      throw new DOMException('tick expired', 'AbortError');
    },
  });
  await runFactoryLinearSync(paths, undefined, {
    readPage: async () => ({ items: [], cursor: null }),
    readIssue: async (_connection, id) => {
      calls.push(id);
      return { ...issue, id };
    },
  });
  expect(calls).toEqual(ordered);
});

it('uses a ten-second connection budget without aborting later connections', async () => {
  const { paths, c } = setup();
  const later = { ...c, id: 'later', teamId: 'later-team' };
  const config = JSON.parse(readFileSync(paths.config, 'utf8'));
  config.factory.linear = [c, later];
  writeFileSync(paths.config, JSON.stringify(config));
  const budgets: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    budgets.push(controller);
    return controller.signal;
  });
  const seen: string[] = [];
  try {
    await runFactoryLinearSync(paths, undefined, {
      readIssue: async () => issue,
      readPage: async (connection) => {
        seen.push(connection.id);
        if (connection.id === c.id) {
          budgets[0].abort(new DOMException('timeout', 'TimeoutError'));
          throw new DOMException('timeout', 'TimeoutError');
        }
        return { items: [], cursor: null };
      },
    });
    expect(seen).toEqual([c.id, later.id]);
    expect(timeout).toHaveBeenCalledWith(10000);
    const failed = dbRun(
      paths,
      (db) => linearRecords(db, 'sync', { id: `sync:${c.id}` })[0],
    );
    expect(failed.attempts).toBe(0);
  } finally {
    timeout.mockRestore();
  }
});

it('rotates provider phases so continuous intake backlog cannot starve retained authority checks', async () => {
  const { paths, c, current, run } = releasedFixture();
  for (let i = 0; i < 50; i++)
    acceptLinearDelivery(
      {
        id: `backlog-${i}`,
        connectionId: c.id,
        connectionFingerprint: linearFingerprint(c),
        issueId: `backlog-${i}`,
        action: 'update',
        digest: `backlog-${i}`,
        createdAt: issue.updatedAt,
      },
      paths,
    );
  const seen: string[] = [];
  for (let tick = 0; tick < 3; tick++) {
    const deadline = new AbortController();
    await runFactoryLinearSync(paths, deadline.signal, {
      readPage: async () => {
        seen.push('discovery');
        deadline.abort();
        throw new DOMException('budget spent', 'AbortError');
      },
      readIssue: async (_connection, id) => {
        if (id !== issue.id) {
          seen.push('delivery');
          deadline.abort();
          throw new DOMException('budget spent', 'AbortError');
        }
        seen.push('retained');
        return {
          ...issue,
          state: { id: 'done', type: 'completed' },
          updatedAt: '2026-09-07T03:00:00Z',
        };
      },
    });
    expect(
      dbRun(
        paths,
        (db) =>
          linearRecords(db, 'delivery').filter((row) => row.state === 'pending')
            .length,
      ),
    ).toBe(50);
  }
  expect(seen.slice(0, 3)).toEqual(['delivery', 'discovery', 'retained']);
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).not.toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
});

it('rotates the starting mapping when five busy connections exceed the global deadline', async () => {
  const { paths, c } = setup();
  const connections = Array.from({ length: 5 }, (_, index) => ({
    ...c,
    id: `connection-${index}`,
    teamId: `team-${index}`,
  }));
  const config = JSON.parse(readFileSync(paths.config, 'utf8'));
  config.factory.linear = connections;
  writeFileSync(paths.config, JSON.stringify(config));
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budgets: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    budgets.push(controller);
    return controller.signal;
  });
  const starts: string[] = [];
  try {
    for (let tick = 0; tick < 2; tick++) {
      now += 60001;
      let spent = 0;
      const globalDeadline = new AbortController();
      await runFactoryLinearSync(paths, globalDeadline.signal, {
        readPage: async (connection) => {
          starts.push(connection.id);
          // A valid discovery takes seven seconds; the fifth mapping has only
          // five seconds left after four ten-second connection budgets.
          if (spent + 7000 > 45000) {
            globalDeadline.abort();
            throw new DOMException('global deadline', 'AbortError');
          }
          spent += 7000;
          return {
            items: [
              {
                ...issue,
                id: `task-${connection.id}`,
                team: { id: connection.teamId },
              },
            ],
            cursor: null,
          };
        },
        readIssue: async () => {
          spent += 3000;
          budgets.at(-1)!.abort();
          throw new DOMException('connection deadline', 'TimeoutError');
        },
      });
      if (tick === 0)
        expect(
          dbRun(paths, (db) =>
            db
              .prepare('SELECT id FROM factory_sources WHERE request_key=?')
              .get('linear:org:task-connection-4'),
          ),
        ).toBeUndefined();
    }
    expect(starts.slice(0, 5)).toEqual(
      connections.map((connection) => connection.id),
    );
    expect(starts[5]).toBe('connection-1');
    expect(
      dbRun(paths, (db) =>
        db
          .prepare('SELECT id FROM factory_sources WHERE request_key=?')
          .get('linear:org:task-connection-4'),
      ),
    ).toBeDefined();
  } finally {
    timeout.mockRestore();
    clock.mockRestore();
  }
});
