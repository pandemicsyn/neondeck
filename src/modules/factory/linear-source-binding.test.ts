import { expect, it } from 'vitest';
import { releasedFixture, issue } from './testing/linear-fixture';
import { dbRun, getFactoryWork } from './service';
import { getCodingRun } from '../coding-runs';
import { updateFactoryConfig } from '../config';
import { linearFingerprint } from './linear-config';
import {
  acceptLinearDelivery,
  linearRecords,
  putLinearRecord,
  linearRecordSchema,
} from './linear-store';
import { processLinearRemovals } from './linear-removals';
import {
  reconcileLinearSource,
  linearContentFingerprint,
} from './linear-source';
import {
  bindLegacyLinearSourceRecords,
  linearSourceFingerprint,
  matchesLinearSourceBinding,
} from './linear-authority';
import * as v from 'valibot';
import { runFactoryLinearSync } from './linear-reconcile';
import { runFactoryLinearWriteback } from './linear-writeback';
import { assertCodingAuthoritySnapshot } from './coding-context';

it.each(['current', 'legacy'] as const)(
  'keeps a %s queued removal valid across writeback edits without credentials',
  (kind) => {
    const { paths, c, current, run } = releasedFixture();
    const input = {
      id: 'queued',
      connectionId: c.id,
      connectionFingerprint: linearFingerprint(c),
      issueId: issue.id,
      action: 'remove' as const,
      digest: 'digest',
      createdAt: '2026-09-07T03:00:00Z',
    };
    if (kind === 'current')
      acceptLinearDelivery(
        { ...input, sourceFingerprint: linearSourceFingerprint(c) },
        paths,
      );
    else
      dbRun(paths, (db) =>
        putLinearRecord(
          db,
          v.parse(linearRecordSchema, {
            ...input,
            kind: 'delivery',
            state: 'pending',
            error: null,
            retryAt: 0,
            attempts: 0,
          }),
        ),
      );
    const captured = dbRun(paths, (db) => linearRecords(db, 'delivery')[0]);
    const changed = {
      ...c,
      writeback: { enabled: true, states: { queued: 'different' } },
    };
    updateFactoryConfig({ linear: [changed] }, paths);
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).toBeNull();
    // A retry holding the pre-config legacy object cannot erase the proven upgrade.
    dbRun(paths, (db) =>
      putLinearRecord(db, { ...captured, state: 'pending' }),
    );
    const upgraded = dbRun(paths, (db) => linearRecords(db, 'delivery')[0]);
    expect(upgraded.connectionFingerprint).toBe(linearFingerprint(c));
    expect(upgraded.sourceFingerprint).toBe(linearSourceFingerprint(c));
    delete process.env[c.tokenEnv];
    delete process.env[c.webhookSecretEnv];
    processLinearRemovals([changed], paths);
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
    expect(dbRun(paths, (db) => linearRecords(db, 'delivery')[0]).state).toBe(
      'complete',
    );
  },
);

it.each(['toggle', 'state-map'] as const)(
  'preserves a legacy authorized echo after writeback %s changes',
  (change) => {
    const { paths, c, current, run } = releasedFixture(true);
    const echo = {
      ...issue,
      state: { id: 'started', type: 'started' },
      updatedAt: '2026-09-07T01:00:00Z',
    };
    dbRun(paths, (db) =>
      putLinearRecord(
        db,
        v.parse(linearRecordSchema, {
          id: 'echo',
          kind: 'writeback',
          connectionId: c.id,
          connectionFingerprint: linearFingerprint(c),
          issueId: issue.id,
          workId: current.work.id,
          sourceVersion: current.source.version,
          stateId: echo.state.id,
          baseline: linearContentFingerprint(issue),
          updatedAt: echo.updatedAt,
          state: 'complete',
          error: null,
          retryAt: 0,
          attempts: 1,
        }),
      ),
    );
    const changed = {
      ...c,
      writeback:
        change === 'toggle'
          ? { ...c.writeback, enabled: false }
          : { enabled: true, states: { queued: 'other-state' } },
    };
    updateFactoryConfig({ linear: [changed] }, paths);
    dbRun(paths, (db) =>
      reconcileLinearSource(db, changed, echo, issue.id, paths),
    );
    const latest = getFactoryWork(current.work.id, paths);
    expect(latest.source.version).toBe(current.source.version);
    expect(latest.releases[0].withdrawnAt).toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
    expect(() =>
      assertCodingAuthoritySnapshot(run.snapshot, paths),
    ).not.toThrow();
    const effect = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
    expect(matchesLinearSourceBinding(effect, changed)).toBe(true);
    expect(effect.connectionFingerprint).not.toBe(linearFingerprint(changed));
  },
);

it('preserves source authority but rejects an outbound write after a writeback-only race', async () => {
  const { paths, c, current, run } = releasedFixture(true);
  const mapped = {
    ...c,
    writeback: { enabled: true, states: { queued: 'started' } },
  };
  updateFactoryConfig({ linear: [mapped] }, paths);
  let providerSends = 0;
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async (_connection, id, stateId, _signal, beforeMutation) => {
      updateFactoryConfig(
        {
          linear: [
            { ...mapped, writeback: { ...mapped.writeback, enabled: false } },
          ],
        },
        paths,
      );
      expect(() =>
        assertCodingAuthoritySnapshot(run.snapshot, paths),
      ).not.toThrow();
      beforeMutation!();
      providerSends++;
      return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
    },
  });
  expect(providerSends).toBe(0);
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  expect(() =>
    assertCodingAuthoritySnapshot(run.snapshot, paths),
  ).not.toThrow();
  expect(
    dbRun(paths, (db) => linearRecords(db, 'writeback')[0])
      .connectionFingerprint,
  ).toBe(linearFingerprint(mapped));
});

it('does not upgrade unproven legacy records or accept changed source bindings', () => {
  const { paths, c, current, run } = releasedFixture();
  acceptLinearDelivery(
    {
      id: 'source',
      connectionId: c.id,
      connectionFingerprint: linearFingerprint(c),
      issueId: issue.id,
      action: 'remove',
      digest: 'source',
      createdAt: issue.updatedAt,
    },
    paths,
  );
  dbRun(paths, (db) => {
    putLinearRecord(
      db,
      v.parse(linearRecordSchema, {
        id: 'unproven',
        kind: 'delivery',
        connectionId: c.id,
        connectionFingerprint: 'untrusted',
        issueId: 'other',
        action: 'remove',
        state: 'pending',
        error: null,
        retryAt: 0,
        attempts: 0,
      }),
    );
    bindLegacyLinearSourceRecords(db, [c]);
  });
  expect(
    dbRun(paths, (db) => linearRecords(db, 'delivery', { id: 'unproven' })[0])
      .sourceFingerprint,
  ).toBeUndefined();
  const changed = { ...c, tokenEnv: 'DIFFERENT_TOKEN_REFERENCE' };
  updateFactoryConfig({ linear: [changed] }, paths);
  const accepted = dbRun(
    paths,
    (db) => linearRecords(db, 'delivery', { id: 'delivery:source' })[0],
  );
  expect(matchesLinearSourceBinding(accepted, changed)).toBe(false);
  processLinearRemovals([changed], paths);
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).not.toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  expect(
    dbRun(
      paths,
      (db) => linearRecords(db, 'delivery', { id: 'delivery:source' })[0],
    ).state,
  ).toBe('attention');
});

it.each(['success', 'retry'] as const)(
  'preserves upgraded legacy binding across an in-flight %s after writeback edits',
  async (outcome) => {
    const { paths, c, current, run } = releasedFixture();
    dbRun(paths, (db) =>
      putLinearRecord(
        db,
        v.parse(linearRecordSchema, {
          id: 'in-flight',
          kind: 'delivery',
          connectionId: c.id,
          connectionFingerprint: linearFingerprint(c),
          issueId: issue.id,
          action: 'update',
          state: 'pending',
          error: null,
          retryAt: 0,
          attempts: 0,
        }),
      ),
    );
    let edited = false;
    await runFactoryLinearSync(paths, undefined, {
      readPage: async () => ({ items: [], cursor: null }),
      readIssue: async () => {
        if (!edited) {
          edited = true;
          updateFactoryConfig(
            {
              linear: [
                {
                  ...c,
                  writeback: {
                    enabled: true,
                    states: { queued: 'other-state' },
                  },
                },
              ],
            },
            paths,
          );
        }
        if (outcome === 'retry') throw new Error('temporary provider failure');
        return issue;
      },
    });
    const record = dbRun(
      paths,
      (db) => linearRecords(db, 'delivery', { id: 'in-flight' })[0],
    );
    expect(record.state).toBe(outcome === 'success' ? 'complete' : 'pending');
    expect(record.sourceFingerprint).toBe(linearSourceFingerprint(c));
    expect(record.connectionFingerprint).toBe(linearFingerprint(c));
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  },
);
