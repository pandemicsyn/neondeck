import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture, connection, issue } from './testing/github-fixture';
import {
  factoryGitHubState,
  factoryGitHubComments,
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
  submitFactoryWork,
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
  let rows = factoryGitHubComments(
    current().work.id,
    undefined,
    setup.paths,
  ).comments;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    author: 'external-author',
    intentId: null,
    deleted: false,
  });
  expect(current().releases).toHaveLength(0);
  vi.mocked(io.comments).mockResolvedValue({ items: [], hasNext: true });
  await tick();
  expect(
    factoryGitHubComments(current().work.id, undefined, setup.paths).comments[0]
      .deleted,
  ).toBe(false);
  expect(io.comment).not.toHaveBeenCalled();
  vi.mocked(io.comments).mockResolvedValue({ items: [], hasNext: false });
  await tick();
  await tick();
  await tick();
  await tick();
  expect(
    factoryGitHubComments(current().work.id, undefined, setup.paths).comments[0]
      .deleted,
  ).toBe(true);
  vi.mocked(io.comments).mockResolvedValue({
    items: [comment],
    hasNext: false,
  });
  await tick();
  await tick();
  expect(
    factoryGitHubComments(current().work.id, undefined, setup.paths).comments[0]
      .deleted,
  ).toBe(true);
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
    factoryGitHubState(setup.paths).deliveries.find((d) => d.issueNumber === 1)
      ?.error,
  ).toBeTruthy();
});

it.each([
  new Error('network failure'),
  new DOMException('deadline', 'TimeoutError'),
  new DOMException('shutdown', 'AbortError'),
  new GitHubApiError(403, null, 'limited', {
    rateLimited: true,
    retryAt: Date.now() + 90000,
  }),
  new GitHubApiError(503, null, 'unavailable'),
])(
  'keeps released source authority unchanged after transient read failure: %s',
  async (error) => {
    await tick();
    save();
    release();
    const before = current();
    vi.mocked(io.issue).mockRejectedValue(error);
    requestFactoryGitHubSync(before.work.id, setup.paths);
    await tick();
    expect(current().source).toMatchObject(before.source);
    expect(current().releases).toEqual(before.releases);
    expect(current().eligible).toBe(true);
    expect(
      factoryGitHubState(setup.paths).deliveries.some((d) => d.error),
    ).toBe(true);
    vi.mocked(io.issue).mockResolvedValue(issue);
    dbRun(setup.paths, (db) =>
      db.exec(
        "UPDATE factory_github_sync SET record=json_set(record,'$.retryAt',0)",
      ),
    );
    requestFactoryGitHubSync(before.work.id, setup.paths);
    await tick();
    expect(current().source).toMatchObject(before.source);
    expect(current().releases).toEqual(before.releases);
    expect(current().eligible).toBe(true);
  },
);
it.each([404, 410])(
  'still withdraws release for an unavailable source (%s)',
  async (status) => {
    await tick();
    save();
    release();
    vi.mocked(io.issue).mockRejectedValue(
      new GitHubApiError(status, null, 'gone'),
    );
    await tick();
    expect(current().eligible).toBe(false);
    expect(current().releases[0].withdrawnAt).not.toBeNull();
  },
);
it('isolates oversized content and continues to valid issues and later pages', async () => {
  vi.mocked(io.issues).mockImplementation(async (_, _since, page) => ({
    items:
      page === 1
        ? [issue, { ...issue, id: 102, number: 2 }]
        : [{ ...issue, id: 103, number: 3 }],
    hasNext: page === 1,
  }));
  vi.mocked(io.issue).mockImplementation(async (_, number) => ({
    ...issue,
    id: 100 + number,
    number,
    body: number === 1 ? 'x'.repeat(65537) : 'valid',
  }));
  await tick();
  expect(
    factoryGitHubState(setup.paths).sync.find(
      (s) => s.id === 'connection:synthetic',
    )?.page,
  ).toBe(2);
  expect(factoryGitHubState(setup.paths).deliveries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ issueNumber: 1, state: 'attention' }),
    ]),
  );
  await tick();
  expect(factoryState(setup.paths).items).toHaveLength(2);
});
it('pages only the requested task comments and rejects invalid cursors', async () => {
  const { putComment } = await import('./github-store');
  await tick();
  const workId = current().work.id;
  const other = submitFactoryWork(
    { requestKey: 'other', title: 'Other task', body: '', repoId: null },
    human,
    setup.paths,
  );
  dbRun(setup.paths, (db) => {
    for (let n = 1; n <= 23; n++)
      putComment(db, {
        id: `page-${n}`,
        workId,
        remoteId: String(n),
        body: 'body',
        author: 'synthetic',
        remoteUpdatedAt: issue.updated_at,
        fingerprint: String(n),
        version: 1,
        deleted: false,
        seenScan: '',
        intentId: null,
      });
    // An unrelated malformed record proves it is neither decoded nor transferred.
    db.prepare(
      'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?)',
    ).run('unrelated', other.work.id, 'invalid-json');
  });
  expect(factoryGitHubState(setup.paths)).not.toHaveProperty('comments');
  const first = factoryGitHubComments(workId, undefined, setup.paths);
  expect(first.comments).toHaveLength(10);
  expect(first.comments[0].remoteId).toBe('23');
  const second = factoryGitHubComments(workId, first.nextCursor!, setup.paths);
  const third = factoryGitHubComments(workId, second.nextCursor!, setup.paths);
  expect(third.comments).toHaveLength(3);
  expect(third.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.comments, ...second.comments, ...third.comments].map(
        (c) => c.id,
      ),
    ).size,
  ).toBe(23);
  expect(() => factoryGitHubComments(workId, '-1', setup.paths)).toThrow(
    'cursor',
  );
  expect(() =>
    factoryGitHubComments('missing', undefined, setup.paths),
  ).toThrow();
});

it('integrated pause/reopen preserves GitHub source and requires a fresh release', async () => {
  await tick();
  save();
  const before = release();
  const paused = transitionFactoryWork(
    before.work.id,
    { expectedVersion: before.work.version, action: 'pause' },
    human,
    setup.paths,
  );
  const reopened = transitionFactoryWork(
    before.work.id,
    { expectedVersion: paused.work.version, action: 'reopen' },
    human,
    setup.paths,
  );
  expect(reopened.source).toEqual(before.source);
  expect(reopened.revisions).toEqual(before.revisions);
  expect(reopened.eligible).toBe(false);
  expect(reopened.releases[0].withdrawnAt).not.toBeNull();
  expect(release().eligible).toBe(true);
});
