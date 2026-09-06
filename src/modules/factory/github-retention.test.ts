import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture, issue } from './testing/github-fixture';
import { dbRun, factoryState, getFactoryWork } from './service';
import {
  runFactoryGitHubSync,
  type GitHubReconcileIO,
} from './github-reconcile';
import {
  githubDigest,
  putComment,
  putDelivery,
  acceptGitHubDelivery,
  type GitHubDelivery,
} from './github-store';
import {
  prepareFactoryPlanning,
  prepareGitHubContext,
  updatePlanningIntent,
} from './planning-store';
import {
  githubRetentionBatch,
  retainFactoryGitHubHistory,
} from './github-retention';

let setup: ReturnType<typeof fixture>;
let io: GitHubReconcileIO;
let workId: string;
const day = 86400000;
const start = Date.parse('2026-10-01T00:00:00Z');
beforeEach(async () => {
  setup = fixture();
  io = {
    repository: vi.fn(async () => ({
      id: 42,
      name: 'fixture',
      owner: { login: 'example' },
    })),
    issue: vi.fn(async () => ({ ...issue })),
    issues: vi.fn(async () => ({ items: [{ ...issue }], hasNext: false })),
    comments: vi.fn(async () => ({ items: [], hasNext: false })),
    comment: vi.fn(async () => {
      throw new Error('Unexpected comment lookup');
    }),
    planning: vi.fn(async () => {}),
  };
  await runFactoryGitHubSync(setup.paths, io);
  workId = factoryState(setup.paths).items[0].id;
  const ids = dbRun(setup.paths, (db) =>
    db.prepare('SELECT id FROM factory_planning_intents').all(),
  );
  for (const row of ids)
    updatePlanningIntent(
      String(row.id),
      (i) => {
        i.stage = 'completed';
      },
      setup.paths,
    );
  const human = prepareFactoryPlanning(
    workId,
    {
      requestKey: 'human',
      message: 'Plan',
      expectedVersion: getFactoryWork(workId, setup.paths).work.version,
    },
    setup.paths,
  );
  updatePlanningIntent(
    human.id,
    (i) => {
      i.stage = 'completed';
    },
    setup.paths,
  );
});
afterEach(() => {
  setup.dispose();
  vi.restoreAllMocks();
});
function delivery(
  id: string,
  state: GitHubDelivery['state'] = 'complete',
): GitHubDelivery {
  return {
    id,
    connectionId: 'synthetic',
    connectionFingerprint: 'fixture',
    repositoryId: '42',
    issueNumber: 1,
    issueId: '101',
    event: 'issues',
    action: 'edited',
    digest: githubDigest(id),
    state,
    error: null,
    attempts: 1,
    retryAt: 0,
    createdAt: '2020-01-01T00:00:00Z',
  };
}
function has(
  table: 'factory_github_deliveries' | 'factory_planning_intents',
  id: string,
) {
  return dbRun(
    setup.paths,
    (db) => !!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id),
  );
}
function context(
  version: number,
  stage: 'completed' | 'failed' | 'planner' = 'completed',
) {
  const id = githubDigest([workId, 11]);
  const intent = dbRun(setup.paths, (db) =>
    prepareGitHubContext(
      db,
      workId,
      `github-comment:${id}:${version}`,
      'External context',
      setup.paths,
    ),
  );
  if (!intent) throw new Error('Expected context admission');
  updatePlanningIntent(
    intent.id,
    (row) => {
      row.stage = stage;
    },
    setup.paths,
  );
  dbRun(setup.paths, (db) =>
    putComment(db, {
      id,
      workId,
      remoteId: '11',
      body: 'Context',
      author: 'external',
      remoteUpdatedAt: issue.updated_at,
      fingerprint: githubDigest(['Context', 'external', issue.updated_at]),
      version,
      deleted: false,
      seenScan: '',
      intentId: intent.id,
    }),
  );
  return intent.id;
}
it('starts the full settlement window at observation and retains attention/pending deliveries', () => {
  dbRun(setup.paths, (db) => {
    for (const state of ['complete', 'attention', 'pending'] as const)
      putDelivery(db, delivery(state, state));
  });
  expect(retainFactoryGitHubHistory(setup.paths, start).deliveries).toBe(0);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 30 * day).deliveries,
  ).toBe(0);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).deliveries,
  ).toBe(1);
  expect(has('factory_github_deliveries', 'attention')).toBe(true);
  expect(has('factory_github_deliveries', 'pending')).toBe(true);
  // A receipt ID expires, but reconciliation still reads current remote state.
  expect(
    acceptGitHubDelivery(delivery('complete', 'pending'), setup.paths),
  ).toEqual({ duplicate: false });
  expect(
    acceptGitHubDelivery(delivery('complete', 'pending'), setup.paths),
  ).toEqual({ duplicate: true });
});
it('bounds settlement observation and deletion separately per pass', () => {
  dbRun(setup.paths, (db) => {
    for (let i = 0; i < githubRetentionBatch + 3; i++)
      putDelivery(db, delivery(`d${i}`));
  });
  retainFactoryGitHubHistory(setup.paths, start);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).deliveries,
  ).toBe(githubRetentionBatch);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 32 * day).deliveries,
  ).toBe(0);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 62 * day).deliveries,
  ).toBe(3);
});
it('prunes only superseded completed context and unchanged sync cannot regenerate it', async () => {
  const old = context(1);
  const anchor = context(2);
  retainFactoryGitHubHistory(setup.paths, start);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).intents,
  ).toBe(1);
  expect(has('factory_planning_intents', old)).toBe(false);
  expect(has('factory_planning_intents', anchor)).toBe(true);
  vi.mocked(io.comments).mockResolvedValue({
    items: [
      {
        id: 11,
        body: 'Context',
        user: { login: 'external' },
        created_at: issue.updated_at,
        updated_at: issue.updated_at,
      },
    ],
    hasNext: false,
  });
  vi.mocked(io.planning).mockClear();
  for (let i = 0; i < 4; i++) await runFactoryGitHubSync(setup.paths, io);
  expect(io.planning).not.toHaveBeenCalled();
  expect(has('factory_planning_intents', old)).toBe(false);
  expect(
    dbRun(
      setup.paths,
      (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM factory_planning_intents').get()
          ?.n,
    ),
  ).toBe(3);
});
it('preserves failed, recent, referenced and human intents, bindings, specs and audit', () => {
  const failed = context(1, 'failed');
  const referenced = context(2);
  context(3);
  dbRun(setup.paths, (db) =>
    db
      .prepare(
        'INSERT INTO factory_planning_effects(id,intent_id,record) VALUES(?,?,?)',
      )
      .run('effect', referenced, '{}'),
  );
  const retained = () =>
    dbRun(setup.paths, (db) =>
      [
        'factory_planning_bindings',
        'factory_spec_revisions',
        'factory_audit',
      ].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    );
  const before = retained();
  retainFactoryGitHubHistory(setup.paths, start);
  const recent = context(4);
  context(5);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).intents,
  ).toBe(1);
  expect(has('factory_planning_intents', failed)).toBe(true);
  expect(has('factory_planning_intents', referenced)).toBe(true);
  expect(has('factory_planning_intents', recent)).toBe(true);
  expect(retained()).toEqual(before);
});
it('retains all context history while work has active or uncertain dispatch', () => {
  const old = context(1);
  context(2, 'planner');
  retainFactoryGitHubHistory(setup.paths, start);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).intents,
  ).toBe(0);
  expect(has('factory_planning_intents', old)).toBe(true);
});

it('bounds superseded context deletion and keeps the current anchor', () => {
  for (let version = 1; version <= githubRetentionBatch + 2; version++)
    context(version);
  retainFactoryGitHubHistory(setup.paths, start);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).intents,
  ).toBe(githubRetentionBatch);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 32 * day).intents,
  ).toBe(0);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 62 * day).intents,
  ).toBe(1);
  expect(
    dbRun(
      setup.paths,
      (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM factory_planning_intents WHERE json_extract(record,'$.externalContext')=1",
          )
          .get()?.n,
    ),
  ).toBe(1);
});

it('a completed delivery rewritten for retry gets a new full settlement window', () => {
  dbRun(setup.paths, (db) => putDelivery(db, delivery('retry')));
  retainFactoryGitHubHistory(setup.paths, start);
  dbRun(setup.paths, (db) => putDelivery(db, delivery('retry', 'attention')));
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 31 * day).deliveries,
  ).toBe(0);
  dbRun(setup.paths, (db) => putDelivery(db, delivery('retry')));
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 32 * day).deliveries,
  ).toBe(0);
  expect(
    retainFactoryGitHubHistory(setup.paths, start + 63 * day).deliveries,
  ).toBe(1);
});
