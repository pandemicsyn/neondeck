import { expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { setup, releasedFixture, issue } from './testing/linear-fixture';
import { dbRun, getFactoryWork } from './service';
import { getCodingRun } from '../coding-runs';
import { updateFactoryConfig } from '../config';
import { runFactoryLinearSync } from './linear-reconcile';
import { runFactoryLinearWriteback } from './linear-writeback';
import { reconcileLinearSource } from './linear-source';
import {
  linearRecords,
  linearSyncSchema,
  putLinearRecord,
} from './linear-store';
import { linearFingerprint } from './linear-config';
import { scheduledLinearConnections } from './linear-scheduling';

it.each(['closed', 'archived'] as const)(
  'refreshes %s provider state without a webhook secret',
  async (state) => {
    const { paths, c, current, run } = releasedFixture();
    delete process.env[c.webhookSecretEnv];
    const changed = {
      ...issue,
      updatedAt: '2026-09-07T03:00:00Z',
      ...(state === 'closed'
        ? { state: { id: 'done', type: 'completed' } }
        : { archivedAt: '2026-09-07T03:00:00Z' }),
    };
    const readIssue = vi.fn(async () => changed);
    await runFactoryLinearSync(paths, undefined, {
      readIssue,
      readPage: async () => ({ items: [], cursor: null }),
    });
    expect(readIssue).toHaveBeenCalled();
    expect(
      getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
    ).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  },
);

it('writes configured state without a webhook secret and normalizes a stale item cursor', async () => {
  const { paths, c } = setup(true);
  delete process.env[c.webhookSecretEnv];
  dbRun(paths, (db) =>
    putLinearRecord(
      db,
      v.parse(linearSyncSchema, {
        id: `writeback-cursor:${c.id}`,
        kind: 'sync',
        connectionId: c.id,
        connectionFingerprint: linearFingerprint(c),
        offset: 9999,
        state: 'pending',
        error: null,
        retryAt: 0,
        attempts: 0,
      }),
    ),
  );
  let sends = 0;
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async (_connection, id, stateId, _signal, beforeMutation) => {
      beforeMutation!();
      sends++;
      return { id, state: { id: stateId }, updatedAt: '2026-09-07T03:00:00Z' };
    },
  });
  expect(sends).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
    'complete',
  );
});

it('rotates writeback connections independently after an aborted tick', async () => {
  const { paths, c } = setup(true);
  const later = { ...c, id: 'later', teamId: 'later-team' };
  updateFactoryConfig({ linear: [c, later] }, paths);
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      later,
      { ...issue, id: 'later-issue', team: { id: later.teamId } },
      'later-issue',
      paths,
    ),
  );
  scheduledLinearConnections([c, later], paths);
  const calls: string[] = [];
  const sent: string[] = [];
  for (let tick = 0; tick < 2; tick++) {
    const deadline = new AbortController();
    await runFactoryLinearWriteback(paths, deadline.signal, {
      readIssue: async (connection, id) => {
        calls.push(connection.id);
        if (tick === 0) {
          deadline.abort();
          throw new DOMException('tick deadline', 'AbortError');
        }
        return { ...issue, id, team: { id: connection.teamId } };
      },
      updateState: async (connection, id, stateId, _signal, beforeMutation) => {
        beforeMutation!();
        sent.push(connection.id);
        return {
          id,
          state: { id: stateId },
          updatedAt: '2026-09-07T03:00:00Z',
        };
      },
    });
  }
  expect(calls.slice(0, 2)).toEqual([c.id, later.id]);
  expect(sent).toContain(later.id);
});

it('advances the writeback item cursor before a slow read', async () => {
  const { paths, c } = setup(true);
  dbRun(paths, (db) =>
    reconcileLinearSource(db, c, { ...issue, id: 'second' }, 'second', paths),
  );
  const ordered = dbRun(paths, (db) =>
    db
      .prepare(
        'SELECT s.record FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id ORDER BY w.id',
      )
      .all()
      .map((row) => JSON.parse(String(row.record)).linear.issueId as string),
  );
  const reads: string[] = [];
  const sends: string[] = [];
  for (let tick = 0; tick < 2; tick++) {
    const deadline = new AbortController();
    await runFactoryLinearWriteback(paths, deadline.signal, {
      readIssue: async (_connection, id) => {
        reads.push(id);
        if (tick === 0) {
          deadline.abort();
          throw new DOMException('tick deadline', 'AbortError');
        }
        return { ...issue, id };
      },
      updateState: async (
        _connection,
        id,
        stateId,
        _signal,
        beforeMutation,
      ) => {
        beforeMutation!();
        sends.push(id);
        return {
          id,
          state: { id: stateId },
          updatedAt: '2026-09-07T03:00:00Z',
        };
      },
    });
  }
  expect(reads).toEqual(ordered);
  expect(sends).toEqual([ordered[1]]);
});

it.each(['after-read', 'before-mutation'] as const)(
  'prevents a provider send when cancelled %s',
  async (stage) => {
    const { paths } = setup(true);
    const deadline = new AbortController();
    let sends = 0;
    await runFactoryLinearWriteback(paths, deadline.signal, {
      readIssue: async () => {
        if (stage === 'after-read') deadline.abort();
        return issue;
      },
      updateState: async (
        _connection,
        id,
        stateId,
        _signal,
        beforeMutation,
      ) => {
        deadline.abort();
        beforeMutation!();
        sends++;
        return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
      },
    });
    expect(sends).toBe(0);
  },
);

it('requires the API credential for provider work', async () => {
  const { paths, c } = setup(true);
  delete process.env[c.tokenEnv];
  const readIssue = vi.fn(async () => issue);
  const readPage = vi.fn(async () => ({ items: [], cursor: null }));
  const updateState = vi.fn(async () => ({
    id: issue.id,
    state: issue.state,
    updatedAt: issue.updatedAt,
  }));
  await runFactoryLinearSync(paths, undefined, { readIssue, readPage });
  await runFactoryLinearWriteback(paths, undefined, { readIssue, updateState });
  expect(readIssue).not.toHaveBeenCalled();
  expect(readPage).not.toHaveBeenCalled();
  expect(updateState).not.toHaveBeenCalled();
});
