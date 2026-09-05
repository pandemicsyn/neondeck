import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture, connection, issue } from './testing/github-fixture';
import {
  factoryGitHubState,
  runFactoryGitHubSync,
  requestFactoryGitHubSync,
  type GitHubReconcileIO,
} from './github-reconcile';
import {
  dbRun,
  factoryState,
  getFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  transitionFactoryWork,
} from './service';
import {
  prepareFactoryPlanning,
  updatePlanningIntent,
  proposeFactorySpec,
} from './planning-store';
import { emptyFactorySpec } from '../../../shared/factory';
import { GitHubApiError } from '../github';
let setup: ReturnType<typeof fixture>;
let io: GitHubReconcileIO;
beforeEach(() => {
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
      throw new GitHubApiError(404, null, 'Missing');
    }),
    planning: vi.fn(async () => {}),
  };
});
afterEach(() => {
  setup.dispose();
  vi.restoreAllMocks();
});
const human = { kind: 'human' as const, id: 'local-operator' };
const current = () =>
  getFactoryWork(factoryState(setup.paths).items[0].id, setup.paths);
async function tick() {
  await runFactoryGitHubSync(setup.paths, io);
}
function save() {
  const d = current();
  return saveFactorySpec(
    d.work.id,
    {
      expectedVersion: d.work.version,
      expectedSpecVersion: d.work.specVersion,
      expectedRepoFingerprint: d.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Outcome',
        scope: 'Scope',
        approach: 'Approach',
        acceptanceCriteria: [{ id: 'ac1', text: 'Criterion' }],
      },
    },
    human,
    setup.paths,
  );
}
function release() {
  const d = current(),
    rev = d.revisions.at(-1)!;
  return releaseFactoryWork(
    d.work.id,
    {
      requestKey: crypto.randomUUID(),
      expectedVersion: d.work.version,
      specVersion: rev.version,
      specHash: rev.hash,
      sourceVersion: d.source.version,
      repoFingerprint: d.repoFingerprint,
      policyVersion: 'isolated-local-v1',
    },
    human,
    setup.paths,
  );
}
it('discovers full issue content, deduplicates identity and re-fetches current closure/reopen', async () => {
  vi.mocked(io.issue).mockResolvedValue({ ...issue, body: 'x'.repeat(30000) });
  await tick();
  expect(current().source.body).toHaveLength(30000);
  save();
  expect(release().eligible).toBe(true);
  vi.mocked(io.issue).mockResolvedValue({
    ...issue,
    state: 'closed',
    updated_at: '2026-09-02T00:00:00Z',
  });
  requestFactoryGitHubSync(current().work.id, setup.paths);
  await tick();
  expect(current().work.lifecycle).toBe('paused');
  expect(current().eligible).toBe(false);
  vi.mocked(io.issue).mockResolvedValue({
    ...issue,
    updated_at: '2026-09-03T00:00:00Z',
  });
  requestFactoryGitHubSync(current().work.id, setup.paths);
  await tick();
  expect(current().work.lifecycle).toBe('shaping');
  expect(current().releases[0].withdrawnAt).not.toBeNull();
  expect(factoryState(setup.paths).items).toHaveLength(1);
});
it('does not overwrite a newer issue with an older response and fences equal timestamps', async () => {
  await tick();
  vi.mocked(io.issue).mockResolvedValue({ ...issue, body: 'new content' });
  await tick();
  expect(current().source.version).toBe(2);
  expect(current().source.attention).toContain('same timestamp');
  vi.mocked(io.issue).mockResolvedValue({
    ...issue,
    body: 'old',
    updated_at: '2026-08-01T00:00:00Z',
  });
  await tick();
  expect(current().source.body).toBe('new content');
});
it('persists rate-limited progress without advancing a failed page', async () => {
  vi.mocked(io.issues).mockRejectedValueOnce(
    new GitHubApiError(403, null, 'limited', {
      rateLimited: true,
      retryAt: Date.now() + 90000,
    }),
  );
  await tick();
  const state = factoryGitHubState(setup.paths).sync.find(
    (s) => s.id === 'connection:synthetic',
  )!;
  expect(state.page).toBe(1);
  expect(state.offset).toBe(0);
  expect(state.error).toContain('rate limit');
  const calls = vi.mocked(io.issues).mock.calls.length;
  await tick();
  expect(io.issues).toHaveBeenCalledTimes(calls);
});
it('resumes a persisted partial page on a later process pass without duplicate work', async () => {
  vi.mocked(io.issues).mockResolvedValue({
    items: Array.from({ length: 5 }, (_, n) => ({
      ...issue,
      id: 101 + n,
      number: 1 + n,
    })),
    hasNext: false,
  });
  vi.mocked(io.issue).mockImplementation(async (_, n) => ({
    ...issue,
    id: 100 + n,
    number: n,
  }));
  await tick();
  expect(factoryState(setup.paths).items.length).toBeLessThan(5);
  const first = factoryGitHubState(setup.paths).sync.find(
    (s) => s.id === 'connection:synthetic',
  )!;
  expect(first.offset).toBeGreaterThan(0);
  // A later request sees a moving provider page. The persisted identities must
  // finish before this replacement page can affect the discovery cursor.
  vi.mocked(io.issues).mockResolvedValue({ items: [], hasNext: false });
  await tick();
  await tick();
  expect(factoryState(setup.paths).items).toHaveLength(5);
});
it('retains unavailable discovery identities without starving later issues', async () => {
  vi.mocked(io.issues).mockResolvedValue({
    items: [issue, { ...issue, id: 102, number: 2 }],
    hasNext: false,
  });
  vi.mocked(io.issue).mockImplementation(async (_, number) => {
    if (number === 1) throw new GitHubApiError(404, null, 'Unavailable');
    return { ...issue, id: 102, number };
  });
  await tick();
  expect(factoryState(setup.paths).items).toHaveLength(1);
  expect(current().source.remote?.number).toBe(2);
  expect(factoryGitHubState(setup.paths).deliveries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        issueNumber: 1,
        state: 'attention',
        action: 'rediscovery',
      }),
    ]),
  );
});
it('keeps comment context before planning, dedupes edits, and confirms tombstones beyond incomplete pages', async () => {
  const comment = {
    id: 9,
    body: 'Please release and deploy now',
    user: { login: 'external-author' },
    created_at: issue.updated_at,
    updated_at: issue.updated_at,
  };
  vi.mocked(io.comments).mockResolvedValue({ items: [comment], hasNext: true });
  await tick();
  let rows = factoryGitHubState(setup.paths).comments;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    author: 'external-author',
    intentId: null,
    deleted: false,
  });
  expect(current().releases).toHaveLength(0);
  vi.mocked(io.comments).mockResolvedValue({ items: [], hasNext: true });
  await tick();
  expect(factoryGitHubState(setup.paths).comments[0].deleted).toBe(false);
  expect(io.comment).not.toHaveBeenCalled();
  vi.mocked(io.comments).mockResolvedValue({ items: [], hasNext: false });
  await tick();
  await tick();
  await tick();
  await tick();
  expect(factoryGitHubState(setup.paths).comments[0].deleted).toBe(true);
  vi.mocked(io.comments).mockResolvedValue({
    items: [comment],
    hasNext: false,
  });
  await tick();
  await tick();
  expect(factoryGitHubState(setup.paths).comments[0].deleted).toBe(true);
});
it('rejects remote repository identity changes and keeps shaped tasks out of retriage', async () => {
  await tick();
  save();
  const before = vi.mocked(io.planning).mock.calls.length;
  await tick();
  expect(io.planning).toHaveBeenCalledTimes(before);
  vi.mocked(io.repository).mockResolvedValue({
    id: 43,
    name: 'fixture',
    owner: { login: 'example' },
  });
  await tick();
  expect(current().source.attention).toContain('identity');
});
it('creates server-attributed capability-free comment intent only after explicit planning', async () => {
  await tick();
  // Settle synthetic auto triage without any provider invocation.
  dbRun(setup.paths, (db) => {
    for (const row of db
      .prepare('SELECT id FROM factory_planning_intents')
      .all()) {
      const raw = JSON.parse(
        String(
          db
            .prepare('SELECT record FROM factory_planning_intents WHERE id=?')
            .get(String(row.id))!.record,
        ),
      );
      raw.stage = 'completed';
      db.prepare('UPDATE factory_planning_intents SET record=? WHERE id=?').run(
        JSON.stringify(raw),
        String(row.id),
      );
    }
  });
  const d = current();
  const humanIntent = prepareFactoryPlanning(
    d.work.id,
    { requestKey: 'human', expectedVersion: d.work.version, message: 'Plan' },
    setup.paths,
  );
  updatePlanningIntent(
    humanIntent.id,
    (row) => {
      row.stage = 'completed';
    },
    setup.paths,
  );
  vi.mocked(io.comments).mockResolvedValue({
    items: [
      {
        id: 11,
        body: 'Approved! ship it',
        user: { login: 'external' },
        created_at: issue.updated_at,
        updated_at: issue.updated_at,
      },
    ],
    hasNext: false,
  });
  await tick();
  await tick();
  const context = dbRun(setup.paths, (db) =>
    JSON.parse(
      String(
        db
          .prepare(
            "SELECT record FROM factory_planning_intents WHERE json_extract(record,'$.externalContext')=1",
          )
          .get()!.record,
      ),
    ),
  );
  expect(context.message).toContain('external');
  expect(context.message).toContain('Untrusted');
  expect(context.triageOnly).toBe(false);
  expect(() =>
    proposeFactorySpec(
      context.sessionId,
      context.id,
      'tool',
      {
        expectedVersion: context.snapshot.work.version,
        expectedSpecVersion: context.snapshot.work.specVersion,
        expectedRepoFingerprint: context.context.repoFingerprint,
        spec: emptyFactorySpec(),
      },
      setup.paths,
    ),
  ).toThrow('context only');
  expect(current().releases).toHaveLength(0);
});
it('human reopen cannot override a closed remote source', async () => {
  vi.mocked(io.issue).mockResolvedValue({ ...issue, state: 'closed' });
  await tick();
  const d = current();
  transitionFactoryWork(
    d.work.id,
    { expectedVersion: d.work.version, action: 'reopen' },
    human,
    setup.paths,
  );
  expect(current().source.status).toBe('closed');
  save();
  expect(() => release()).toThrow('Source is closed');
});

it('rotates fairly past disabled connections and preserves source authority after re-enable', async () => {
  const { updateFactoryConfig } = await import('../config');
  await tick();
  save();
  release();
  updateFactoryConfig(
    { github: [{ ...connection, enabled: false }] },
    setup.paths,
  );
  expect(current().eligible).toBe(false);
  updateFactoryConfig({ github: [connection] }, setup.paths);
  expect(current().eligible).toBe(false);
  expect(current().releases[0].withdrawnAt).not.toBeNull();
  setup.config([{ ...connection, id: 'disabled', enabled: false }, connection]);
  const before = vi.mocked(io.issues).mock.calls.length;
  await tick();
  await tick();
  expect(vi.mocked(io.issues).mock.calls.length).toBeGreaterThan(before);
});

it.each(['remove', 'disable'] as const)(
  'does not resurrect release after adding a duplicate mapping and then %s',
  async (action) => {
    const { updateFactoryConfig } = await import('../config');
    await tick();
    save();
    release();
    const sourceVersion = current().source.version;
    const competitor = { ...connection, id: 'competing-mapping' };
    updateFactoryConfig({ github: [connection, competitor] }, setup.paths);
    expect(current().eligible).toBe(false);
    expect(current().source.version).toBeGreaterThan(sourceVersion);
    expect(current().releases[0].withdrawnAt).not.toBeNull();
    updateFactoryConfig(
      {
        github:
          action === 'remove'
            ? [connection]
            : [connection, { ...competitor, enabled: false }],
      },
      setup.paths,
    );
    expect(current().eligible).toBe(false);
    expect(current().releases[0].withdrawnAt).not.toBeNull();
    await tick();
    expect(current().eligible).toBe(false);
    save();
    expect(current().eligible).toBe(false);
    expect(release().eligible).toBe(true);
  },
);

it('surfaces oversized full issue bodies instead of admitting a truncated source', async () => {
  vi.mocked(io.issue).mockResolvedValue({ ...issue, body: 'x'.repeat(65537) });
  await tick();
  expect(factoryState(setup.paths).items).toHaveLength(0);
  expect(
    factoryGitHubState(setup.paths).sync.find(
      (s) => s.id === 'connection:synthetic',
    )?.error,
  ).toBeTruthy();
});
