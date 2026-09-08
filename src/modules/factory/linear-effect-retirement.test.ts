import { expect, it } from 'vitest';
import { setup, issue } from './testing/linear-fixture';
import { runFactoryLinearWriteback } from './linear-writeback';
import { dbRun, detail, putWork } from './service';
import { linearRecords, putLinearRecord } from './linear-store';
import { retireLinearPendingEffects } from './linear-effect-retirement';
import { reconcileLinearSource } from './linear-source';
import { linearWritebackTarget } from './linear-writeback-target';

it('rejects stale work and source versions before changing desired metadata', async () => {
  const { paths } = setup(true);
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async () => {
      throw new Error('preflight unavailable');
    },
  });
  dbRun(paths, (db) => {
    const effect = linearRecords(db, 'writeback')[0];
    const current = detail(db, effect.workId, paths);
    const before = linearRecords(db, 'writeback-target');
    expect(
      linearWritebackTarget(
        db,
        effect.workId,
        current.work.version,
        current.source.version + 1,
        'other',
      ),
    ).toBeNull();
    putWork(db, { ...current.work, version: current.work.version + 1 });
    expect(
      linearWritebackTarget(
        db,
        effect.workId,
        current.work.version,
        current.source.version,
        'other',
      ),
    ).toBeNull();
    expect(linearRecords(db, 'writeback-target')).toEqual(before);
    expect(linearRecords(db, 'writeback', { id: effect.id })[0].state).toBe(
      'pending',
    );
  });
});

it('does not let a stale connection snapshot replace a newer worker desired target', async () => {
  const { paths, c, config } = setup(true);
  dbRun(paths, (db) =>
    reconcileLinearSource(db, c, { ...issue, id: 'second' }, 'second', paths),
  );
  let newerTargets: unknown;
  let reads = 0;
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async (_c, id) => {
      reads++;
      config({
        ...c,
        writeback: { enabled: true, states: { inbox: 'new-target' } },
      });
      const newerIO = {
        readIssue: async (_next, nextId) => ({ ...issue, id: nextId }),
        updateState: async () => {
          throw new Error('preflight unavailable');
        },
      } satisfies Parameters<typeof runFactoryLinearWriteback>[2];
      await runFactoryLinearWriteback(paths, undefined, newerIO);
      await runFactoryLinearWriteback(paths, undefined, newerIO);
      newerTargets = dbRun(paths, (db) =>
        linearRecords(db, 'writeback-target'),
      );
      return { ...issue, id };
    },
    updateState: async () => {
      throw new Error('stale worker must not reach preflight');
    },
  });
  expect(reads).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback-target'))).toEqual(
    newerTargets,
  );
  const effects = dbRun(paths, (db) => linearRecords(db, 'writeback'));
  expect(effects).toHaveLength(2);
  expect(
    effects.every(
      (effect) => effect.state === 'pending' && effect.stateId === 'new-target',
    ),
  ).toBe(true);
});

it('writes completed target cycles once per renewed desired target without work churn', async () => {
  const { paths, c, config } = setup(true);
  let remote = issue;
  const targets: string[] = [];
  const versions: number[] = [];
  for (const target of ['started', 'review', 'started', 'review', 'started']) {
    config({ ...c, writeback: { enabled: true, states: { inbox: target } } });
    const io = {
      readIssue: async () => remote,
      updateState: async (
        ...args: Parameters<typeof import('../linear').updateLinearIssueState>
      ) => {
        args[4]!();
        targets.push(args[2]);
        remote = {
          ...remote,
          state: { id: args[2], type: 'started' },
          updatedAt: new Date(
            Date.parse(issue.updatedAt) + targets.length * 1000,
          ).toISOString(),
        };
        return {
          id: args[1],
          state: remote.state,
          updatedAt: remote.updatedAt,
        };
      },
    };
    await runFactoryLinearWriteback(paths, undefined, io);
    await runFactoryLinearWriteback(paths, undefined, io);
    const effects = dbRun(paths, (db) => linearRecords(db, 'writeback'));
    versions.push(
      dbRun(paths, (db) => detail(db, effects[0].workId, paths)).work.version,
    );
  }
  expect(targets).toEqual([
    'started',
    'review',
    'started',
    'review',
    'started',
  ]);
  expect(new Set(versions).size).toBe(1);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'writeback')).filter(
      (effect) => effect.state === 'complete',
    ),
  ).toHaveLength(5);
});

it('requires capacity to reactivate a superseded intent and retries when a slot is freed', async () => {
  const { paths, c, config } = setup(true);
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async () => {
      throw new Error('preflight unavailable');
    },
  });
  const original = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
  config({ ...c, enabled: false });
  retireLinearPendingEffects(paths);
  config(c);
  dbRun(paths, (db) => {
    for (let index = 0; index < 1000; index++)
      putLinearRecord(db, {
        ...original,
        id: `uncertain:${index}`,
        workId: `other:${index}`,
        state: 'uncertain',
      });
  });
  let sends = 0;
  const io = {
    readIssue: async () => issue,
    updateState: async (
      ...args: Parameters<typeof import('../linear').updateLinearIssueState>
    ) => {
      args[4]!();
      sends++;
      return {
        id: args[1],
        state: { id: args[2] },
        updatedAt: issue.updatedAt,
      };
    },
  };
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(sends).toBe(0);
  expect(
    dbRun(paths, (db) => linearRecords(db, 'writeback', { id: original.id })[0])
      .state,
  ).toBe('superseded');
  dbRun(paths, (db) =>
    putLinearRecord(db, {
      ...linearRecords(db, 'writeback', { id: 'uncertain:0' })[0],
      state: 'complete',
    }),
  );
  await runFactoryLinearWriteback(paths, undefined, io);
  expect(sends).toBe(1);
});

it('fences an old preflight across disable/re-enable and replacement intent', async () => {
  const { paths, c, config } = setup(true);
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let sends = 0;
  const old = runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async (_c, id, stateId, _s, dispatch) => {
      arrived();
      await gate;
      dispatch!();
      sends++;
      return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
    },
  });
  await waiting;
  config({ ...c, enabled: false });
  retireLinearPendingEffects(paths);
  config(c);
  await runFactoryLinearWriteback(paths, undefined, {
    readIssue: async () => issue,
    updateState: async (_c, id, stateId, _s, dispatch) => {
      dispatch!();
      sends++;
      return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
    },
  });
  resume();
  await old;
  expect(sends).toBe(1);
  expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
    'complete',
  );
});

it.each(['disable', 'remap'] as const)(
  'creates a fresh unsent intent after %s and restoration without lifecycle churn',
  async (change) => {
    const { paths, c, config } = setup(true);
    await runFactoryLinearWriteback(paths, undefined, {
      readIssue: async () => issue,
      updateState: async () => {
        throw new Error('preflight unavailable');
      },
    });
    const original = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
    config({
      ...c,
      writeback:
        change === 'disable'
          ? { ...c.writeback, enabled: false }
          : { enabled: true, states: { inbox: 'other' } },
    });
    retireLinearPendingEffects(paths);
    expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
      'superseded',
    );
    config(c);
    let sends = 0;
    await runFactoryLinearWriteback(paths, undefined, {
      readIssue: async () => issue,
      updateState: async (_c, id, stateId, _s, dispatch) => {
        dispatch!();
        sends++;
        return { id, state: { id: stateId }, updatedAt: issue.updatedAt };
      },
    });
    const completed = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
    expect(sends).toBe(1);
    expect(completed.id).toBe(original.id);
    expect(completed.intentId).not.toBe(original.intentId);
    expect(completed.state).toBe('complete');
  },
);

it.each([
  'remap',
  'unmap',
  'disable',
  'remove-connection',
  'source-change',
  'closed',
  'work-version',
  'lifecycle',
] as const)(
  'retires an unsent intent after %s without requiring credentials',
  async (change) => {
    const { paths, c, config } = setup(true);
    await runFactoryLinearWriteback(paths, undefined, {
      readIssue: async () => issue,
      updateState: async () => {
        throw new Error('preflight unavailable');
      },
    });
    expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
      'pending',
    );
    if (change === 'remap')
      config({
        ...c,
        writeback: { enabled: true, states: { inbox: 'different' } },
      });
    if (change === 'unmap')
      config({ ...c, writeback: { enabled: true, states: {} } });
    if (change === 'disable')
      config({ ...c, writeback: { ...c.writeback, enabled: false } });
    if (change === 'remove-connection') config({ ...c, id: 'replacement' });
    if (change === 'work-version' || change === 'lifecycle')
      dbRun(paths, (db) => {
        const effect = linearRecords(db, 'writeback')[0];
        const current = detail(db, effect.workId, paths);
        putWork(db, {
          ...current.work,
          version: current.work.version + 1,
          ...(change === 'lifecycle' ? { lifecycle: 'paused' as const } : {}),
        });
      });
    if (change === 'source-change' || change === 'closed')
      dbRun(paths, (db) =>
        reconcileLinearSource(
          db,
          c,
          {
            ...issue,
            title: 'Changed',
            updatedAt: '2026-09-07T02:00:00Z',
            ...(change === 'closed'
              ? { state: { id: 'done', type: 'completed' } }
              : {}),
          },
          issue.id,
          paths,
        ),
      );
    delete process.env[c.tokenEnv];
    retireLinearPendingEffects(paths);
    const retired = dbRun(paths, (db) => linearRecords(db, 'writeback')[0]);
    expect(retired.state).toBe('superseded');
    expect(retired.attempts).toBe(0);
    expect(retired.error).toContain('Unsent');
  },
);

it.each(['sending', 'uncertain'] as const)(
  'preserves %s evidence when writeback is disabled',
  async (state) => {
    const { paths, c, config } = setup(true);
    await runFactoryLinearWriteback(paths, undefined, {
      readIssue: async () => issue,
      updateState: async () => {
        throw new Error('preflight unavailable');
      },
    });
    dbRun(paths, (db) =>
      putLinearRecord(db, { ...linearRecords(db, 'writeback')[0], state }),
    );
    config({ ...c, enabled: false });
    retireLinearPendingEffects(paths);
    expect(dbRun(paths, (db) => linearRecords(db, 'writeback')[0]).state).toBe(
      state,
    );
  },
);
