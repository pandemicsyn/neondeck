import { expect, it, vi } from 'vitest';
import type { LinearConnection } from '../../../shared/factory-linear';
import { setup, releasedFixture, issue } from './testing/linear-fixture';
import { dbRun, getFactoryWork } from './service';
import { getCodingRun } from '../coding-runs';
import { updateFactoryConfig } from '../config';
import { linearFingerprint } from './linear-config';
import { acceptLinearDelivery, linearRecords } from './linear-store';
import { reconcileLinearSource } from './linear-source';
import { runFactoryLinearSync } from './linear-reconcile';

import { processLinearRemovals } from './linear-removals';

function enqueueRemoval(
  paths: ReturnType<typeof setup>['paths'],
  c: LinearConnection,
  fingerprint = linearFingerprint(c),
  issueId = issue.id,
) {
  acceptLinearDelivery(
    {
      id: 'accepted-remove',
      connectionId: c.id,
      connectionFingerprint: fingerprint,
      issueId,
      action: 'remove',
      digest: 'accepted-digest',
      createdAt: '2026-09-07T03:00:00Z',
    },
    paths,
  );
}

it.each(['token', 'webhook', 'both'] as const)(
  'applies an accepted removal after losing %s credentials',
  async (missing) => {
    const { paths, c, current, run } = releasedFixture();
    enqueueRemoval(paths, c);
    if (missing !== 'webhook') delete process.env[c.tokenEnv];
    if (missing !== 'token') delete process.env[c.webhookSecretEnv];
    const assertRevokedBeforeProviderCall = () => {
      expect(
        getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
      ).not.toBeNull();
      expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
    };
    const io = {
      readIssue: vi.fn(async () => {
        assertRevokedBeforeProviderCall();
        return issue;
      }),
      readPage: vi.fn(async () => {
        assertRevokedBeforeProviderCall();
        return { items: [], cursor: null };
      }),
      planning: vi.fn(async () => {}),
    };
    await runFactoryLinearSync(paths, undefined, io);
    expect(io.readIssue).toHaveBeenCalledTimes(missing === 'webhook' ? 1 : 0);
    expect(io.readPage).toHaveBeenCalledTimes(missing === 'webhook' ? 1 : 0);
    expect(io.planning).not.toHaveBeenCalled();
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
    expect(dbRun(paths, (db) => linearRecords(db, 'delivery')[0]).state).toBe(
      'complete',
    );
  },
);

it('quarantines a stale connection fingerprint without applying its removal', () => {
  const { paths, c, current, run } = releasedFixture();
  enqueueRemoval(
    paths,
    c,
    linearFingerprint({ ...c, repoId: 'different-repository' }),
  );
  processLinearRemovals([c], paths);
  expect(getFactoryWork(current.work.id, paths).source.status).toBe('open');
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  expect(dbRun(paths, (db) => linearRecords(db, 'delivery')[0]).state).toBe(
    'attention',
  );
});

it.each(['disabled', 'removed'] as const)(
  'quarantines accepted removals when the mapping is %s',
  (mode) => {
    const { paths, c, current, run } = releasedFixture();
    enqueueRemoval(paths, c);
    const connections = mode === 'removed' ? [] : [{ ...c, enabled: false }];
    updateFactoryConfig({ linear: connections }, paths);
    processLinearRemovals(connections, paths);
    expect(dbRun(paths, (db) => linearRecords(db, 'delivery')[0]).state).toBe(
      'attention',
    );
    // Typed configuration invalidation already revokes authority; a stale delivery
    // cannot rebind or rewrite the source after the mapping is disabled or removed.
    expect(getFactoryWork(current.work.id, paths).source.status).toBe('open');
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  },
);

it('retains a before-admission removal tombstone without credential readiness', () => {
  const { paths, c } = setup();
  enqueueRemoval(paths, c, linearFingerprint(c), 'never-admitted');
  delete process.env[c.tokenEnv];
  delete process.env[c.webhookSecretEnv];
  processLinearRemovals([c], paths);
  expect(
    dbRun(paths, (db) =>
      linearRecords(db, 'removal').find(
        (row) => row.issueId === 'never-admitted',
      ),
    ),
  ).toBeDefined();
  expect(
    dbRun(paths, (db) =>
      reconcileLinearSource(
        db,
        c,
        { ...issue, id: 'never-admitted' },
        'never-admitted',
        paths,
      ),
    ),
  ).toBeNull();
});
