import { expect, it } from 'vitest';
import { releasedFixture, issue } from './testing/linear-fixture';
import { dbRun } from './service';
import { linearRecords, putLinearRecord } from './linear-store';
import { runFactoryLinearWriteback } from './linear-writeback';
import { updateFactoryConfig } from '../config';
import { assertCodingAuthoritySnapshot } from './coding-context';

it('retries an unsent preflight after restart and a writeback-only edit', async () => {
  const { paths, c, run } = releasedFixture(true);
  const mapped = {
    ...c,
    writeback: { enabled: true, states: { queued: 'started' } },
  };
  updateFactoryConfig({ linear: [mapped] }, paths);
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async () => {
      throw new Error('preflight unavailable');
    },
  });
  const pending = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
  expect(pending.state).toBe('pending');
  expect(pending.attempts).toBe(0);
  updateFactoryConfig(
    {
      linear: [
        {
          ...mapped,
          writeback: {
            ...mapped.writeback,
            states: { queued: 'started', paused: 'paused' },
          },
        },
      ],
    },
    paths,
  );
  dbRun(paths, (db) =>
    putLinearRecord(db, { ...linearRecords(db, 'writeback')[0], retryAt: 0 }),
  );
  let sends = 0;
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async (_c, id, stateId, _s, dispatch) => {
      dispatch!();
      sends++;
      return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
    },
  });
  expect(sends).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
    'complete',
  );
  expect(() =>
    assertCodingAuthoritySnapshot(run.snapshot, paths),
  ).not.toThrow();
});

it('never retries an ambiguous dispatched mutation', async () => {
  const { paths, c } = releasedFixture(true);
  updateFactoryConfig(
    {
      linear: [
        { ...c, writeback: { enabled: true, states: { queued: 'started' } } },
      ],
    },
    paths,
  );
  let sends = 0;
  const io = {
    readIssue: async () => issue,
    updateState: async (
      ...args: Parameters<typeof import('../linear').updateLinearIssueState>
    ) => {
      args[4]!();
      sends++;
      throw new Error('response lost');
    },
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
    'uncertain',
  );
  dbRun(paths, (db) =>
    putLinearRecord(db, { ...linearRecords(db, 'writeback')[0], retryAt: 0 }),
  );
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(sends).toBe(1);
});

it('allows only one concurrent preflight to claim the pending intent', async () => {
  const { paths, c } = releasedFixture(true);
  updateFactoryConfig(
    {
      linear: [
        { ...c, writeback: { enabled: true, states: { queued: 'started' } } },
      ],
    },
    paths,
  );
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preflights = 0;
  let firstArrive!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    firstArrive = resolve;
  });
  let sends = 0;
  const io = {
    readIssue: async () => issue,
    updateState: async (
      ...args: Parameters<typeof import('../linear').updateLinearIssueState>
    ) => {
      if (++preflights === 1) firstArrive();
      else arrive();
      await gate;
      args[4]!();
      sends++;
      return {
        id: args[1],
        state: { id: args[2] },
        updatedAt: issue.updatedAt,
      };
    },
  };
  const first = runFactoryLinearWriteback(paths, undefined, io);
  await firstArrived;
  const second = runFactoryLinearWriteback(paths, undefined, io);
  await arrived;
  release();
  await Promise.all([first, second]);
  expect(sends).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
    'complete',
  );
});
