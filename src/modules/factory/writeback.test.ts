import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as runtimeHome from '../../runtime-home';
import * as runtimeFiles from '../../runtime-home/files';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture, connection, issue } from './testing/github-fixture';
import {
  dbRun,
  reconcileGitHubSource,
  getFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  submitFactoryWork,
} from './service';
import {
  setWritebackPolicy,
  getWritebackState,
  approveWriteback,
  rows,
  put,
} from './writeback-store';
import {
  runFactoryWriteback,
  recoverWriteback,
  previewWritebackRepair,
  approveWritebackRepair,
  echoDisposition,
  type WritebackIO,
} from './writeback';
import {
  updateFactoryConfig,
  updateRepo,
  removeRepo,
  addRepo,
} from '../config';
import { runFactoryGitHubSync, factoryGitHubState } from './github-reconcile';
import { connectionFingerprint } from './github-config';
import type { GitHubComment } from '../../../shared/factory-github';
import { emptyFactorySpec } from '../../../shared/factory';
import { GitHubApiError } from '../github';
let setup: ReturnType<typeof fixture>,
  id: string,
  io: WritebackIO,
  remote: GitHubComment[];
const human = { kind: 'human' as const, id: 'local-operator' };
beforeEach(() => {
  setup = fixture();
  remote = [];
  id = dbRun(setup.paths, (db) =>
    reconcileGitHubSource(
      db,
      { ...connection, connectionId: connection.id, issue },
      setup.paths,
    ),
  ).work.id;
  io = {
    repository: vi.fn(async () => ({
      id: 42,
      name: 'fixture',
      owner: { login: 'example' },
    })),
    issue: vi.fn(async () => ({ ...issue })),
    identity: vi.fn(async () => ({ login: 'neon-bot', id: 77 })),
    comments: vi.fn(async () => ({ items: remote, hasNext: false })),
    comment: vi.fn(async (_c, commentId) => {
      const c = remote.find((c) => String(c.id) === commentId);
      if (!c) throw new GitHubApiError(404, null, 'Missing');
      return c;
    }),
    create: vi.fn(async (_c, _n, body) => {
      const c = {
        id: remote.length + 1,
        body,
        user: { login: 'neon-bot', id: 77 },
        created_at: '2026-09-05T01:00:00Z',
        updated_at: '2026-09-05T01:00:00Z',
      };
      remote.push(c);
      return c;
    }),
    update: vi.fn(async (_c, commentId, body) => {
      const c = {
        ...remote.find((c) => String(c.id) === commentId)!,
        body,
        updated_at: '2026-09-05T02:00:00Z',
      };
      remote = [c];
      return c;
    }),
  };
});
afterEach(() => {
  setup.dispose();
  vi.restoreAllMocks();
});
const state = () => getWritebackState(id, setup.paths);
function consent(enabled = true) {
  return setWritebackPolicy(
    connection.id,
    {
      enabled,
      expectedEpoch: state().policy.epoch,
      expectedFingerprint: connectionFingerprint(connection),
    },
    human,
    setup.paths,
  );
}
const tick = () => runFactoryWriteback(setup.paths, io);
function approval(
  kind: 'summary' | 'question' = 'question',
  body = 'Which behavior is expected?',
  requestKey = crypto.randomUUID(),
) {
  const d = getFactoryWork(id, setup.paths),
    rev = d.revisions.at(-1)!;
  return {
    requestKey,
    expectedVersion: d.work.version,
    specVersion: rev.version,
    specHash: rev.hash,
    sourceVersion: d.source.version,
    issueId: issue.id.toString(),
    kind,
    body,
    decisionId: null,
  };
}
function saveSpec() {
  const d = getFactoryWork(id, setup.paths);
  return saveFactorySpec(
    id,
    {
      expectedVersion: d.work.version,
      expectedSpecVersion: d.work.specVersion,
      expectedRepoFingerprint: d.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Outcome',
        scope: 'Scope',
        approach: 'Approach',
        acceptanceCriteria: [{ id: 'a', text: 'Works' }],
      },
    },
    human,
    setup.paths,
  );
}
it('off means no writes and cannot approve questions', async () => {
  await tick();
  expect(io.create).not.toHaveBeenCalled();
  expect(state().effects).toHaveLength(0);
  expect(() => approveWriteback(id, approval(), human, setup.paths)).toThrow(
    'off',
  );
});
it('maintains one status comment, coalesces updates, and does not publish unapproved draft scope', async () => {
  consent();
  await tick();
  saveSpec();
  await tick();
  expect(io.create).toHaveBeenCalledTimes(1);
  expect(remote[0].body).not.toContain('Scope');
  approveWriteback(id, approval('summary', 'Public scope'), human, setup.paths);
  await tick();
  expect(io.update).toHaveBeenCalledTimes(2);
  expect(remote[0].body).toContain('Public scope');
  saveSpec();
  await tick();
  expect(remote[0].body).not.toContain('Public scope');
});
it('binds immutable question to exact payload, actor, source and request key', async () => {
  consent();
  const input = approval();
  const a = approveWriteback(id, input, human, setup.paths);
  expect(approveWriteback(id, input, human, setup.paths)).toEqual(a);
  expect(() =>
    approveWriteback(id, { ...input, body: 'Changed' }, human, setup.paths),
  ).toThrow('different content');
  expect(() =>
    approveWriteback(
      id,
      { ...input, requestKey: 'stale', specHash: 'bad' },
      human,
      setup.paths,
    ),
  ).toThrow('changed');
  await tick();
  expect(remote[0].body).toBe(
    `${input.body}\n\n${state().effects.find((e) => e.kind === 'question')!.marker}`,
  );
});
it('opt-out while awaiting identity cancels before provider write', async () => {
  consent();
  io.identity = vi.fn(async () => {
    consent(false);
    return { login: 'neon-bot', id: 77 };
  });
  await tick();
  expect(io.create).not.toHaveBeenCalled();
  expect(state().effects[0].state).toBe('cancelled');
});
it('opt-out after dispatch records receipt but never sends another write', async () => {
  consent();
  const create = io.create;
  io.create = vi.fn(async (c, n, body, signal) => {
    consent(false);
    return create(c, n, body, signal);
  });
  await tick();
  expect(state().effects[0].state).toBe('sent');
  await tick();
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('lost create receipt reconciles after restart without another POST', async () => {
  consent();
  const create = io.create;
  io.create = vi.fn(async (c, n, body, signal) => {
    await create(c, n, body, signal);
    throw new Error('lost response');
  });
  await tick();
  expect(state().effects[0].state).toBe('uncertain');
  recoverWriteback(
    id,
    { effectId: state().effects[0].id, action: 'retry' },
    human,
    setup.paths,
  );
  await tick();
  expect(state().effects[0].state).toBe('sent');
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('incomplete pages and foreign copied markers never become receipts or cause another create', async () => {
  consent();
  io.create = vi.fn(async () => {
    throw new Error('timeout');
  });
  await tick();
  const effect = state().effects[0];
  remote = [
    {
      id: 13,
      body: effect.body,
      user: { login: 'other-bot' },
      created_at: '2026-09-05T01:00:00Z',
      updated_at: '2026-09-05T01:00:00Z',
    },
  ];
  io.comments = vi.fn(async () => ({ items: remote, hasNext: true }));
  recoverWriteback(
    id,
    { effectId: effect.id, action: 'retry' },
    human,
    setup.paths,
  );
  await tick();
  expect(state().effects[0].state).toBe('uncertain');
  expect(io.create).toHaveBeenCalledTimes(1);
  expect(dbRun(setup.paths, (db) => echoDisposition(db, id, remote[0]))).toBe(
    'external',
  );
});
it('requires confirmed identity AND revision to suppress echo', async () => {
  consent();
  await tick();
  expect(dbRun(setup.paths, (db) => echoDisposition(db, id, remote[0]))).toBe(
    'confirmed',
  );
  expect(
    dbRun(setup.paths, (db) =>
      echoDisposition(db, id, {
        ...remote[0],
        updated_at: '2026-09-05T03:00:00Z',
      }),
    ),
  ).toBe('external');
  expect(
    dbRun(setup.paths, (db) =>
      echoDisposition(db, id, { ...remote[0], id: 99 }),
    ),
  ).toBe('external');
});
it('remote edits stop status overwrite; human can relinquish without deleting history', async () => {
  consent();
  await tick();
  remote[0] = { ...remote[0], body: 'Human edit' };
  approveWriteback(id, approval('summary', 'Public'), human, setup.paths);
  await tick();
  const effect = state().effects.at(-1)!;
  expect(effect.state).toBe('repair');
  expect(io.update).not.toHaveBeenCalled();
  recoverWriteback(
    id,
    { effectId: effect.id, action: 'relinquish' },
    human,
    setup.paths,
  );
  await tick();
  expect(state().status?.relinquished).toBe(true);
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('writeback failure never blocks valid human release and queue wording is truthful', async () => {
  consent();
  io.create = vi.fn(async () => {
    throw new Error('timeout');
  });
  await tick();
  const d = saveSpec(),
    rev = d.revisions.at(-1)!;
  const released = releaseFactoryWork(
    id,
    {
      requestKey: 'release',
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
  expect(released.eligible).toBe(true);
  expect(state().template).toContain('Released — awaiting coding executor');
});
it('a persisted sending record recovers through reads after restart', async () => {
  consent();
  await tick();
  const e = state().effects[0];
  dbRun(setup.paths, (db) =>
    put(db, 'effect', {
      ...rows(db, 'effect')[0],
      state: 'sending',
      remoteId: null,
    }),
  );
  await tick();
  expect(state().effects.find((x) => x.id === e.id)?.state).toBe('sent');
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('durable pagination continues past four pages and confirms a unique exact receipt', async () => {
  consent();
  const create = io.create;
  io.create = vi.fn(async (c, n, b, s) => {
    await create(c, n, b, s);
    throw new Error('lost');
  });
  await tick();
  const e = state().effects[0];
  io.comments = vi.fn(async (_c, _n, page) => ({
    items: page === 5 ? remote : [],
    hasNext: page < 5,
  }));
  recoverWriteback(id, { effectId: e.id, action: 'retry' }, human, setup.paths);
  await tick();
  expect(state().effects[0].scanPage).toBe(5);
  expect(state().effects[0].state).toBe('uncertain');
  recoverWriteback(id, { effectId: e.id, action: 'retry' }, human, setup.paths);
  await tick();
  expect(state().effects[0].state).toBe('sent');
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('configuration ABA revokes consent and old approvals cannot revive', async () => {
  consent();
  approveWriteback(id, approval(), human, setup.paths);
  updateFactoryConfig(
    { github: [{ ...connection, enabled: false }] },
    setup.paths,
  );
  updateFactoryConfig({ github: [connection] }, setup.paths);
  await tick();
  expect(io.create).not.toHaveBeenCalled();
  expect(state().policy.enabled).toBe(false);
  consent();
  await tick();
  expect(remote.every((c) => !c.body.includes('Which behavior'))).toBe(true);
});
it('source changes during identity lookup cancel the immutable question', async () => {
  consent();
  approveWriteback(id, approval(), human, setup.paths);
  io.identity = vi.fn(async () => {
    dbRun(setup.paths, (db) =>
      reconcileGitHubSource(
        db,
        {
          ...connection,
          connectionId: connection.id,
          issue: {
            ...issue,
            body: 'Changed',
            updated_at: '2026-09-05T01:00:00Z',
          },
        },
        setup.paths,
      ),
    );
    return { login: 'neon-bot', id: 77 };
  });
  await tick();
  expect(io.create).not.toHaveBeenCalled();
  expect(state().effects.find((e) => e.kind === 'question')?.state).toBe(
    'cancelled',
  );
});
it('read failures remain failed without claiming deletion or sending a write', async () => {
  consent();
  io.repository = vi.fn(async () => {
    throw new GitHubApiError(403, null, 'Forbidden');
  });
  await tick();
  expect(state().effects[0].state).toBe('failed');
  expect(state().effects[0].error).toContain('access denied');
  expect(io.create).not.toHaveBeenCalled();
});
it('edited status requires exact repair approval and a second remote revision check', async () => {
  consent();
  await tick();
  remote[0] = {
    ...remote[0],
    body: 'Human content',
    updated_at: '2026-09-05T04:00:00Z',
  };
  approveWriteback(id, approval('summary', 'Public'), human, setup.paths);
  await tick();
  const e = state().effects.at(-1)!;
  const preview = await previewWritebackRepair(id, e.id, setup.paths, io);
  expect(preview.observed?.body).toBe('Human content');
  expect(() =>
    approveWritebackRepair(
      id,
      { previewId: preview.id, replacement: 'Changed' },
      human,
      setup.paths,
    ),
  ).toThrow('changed');
  approveWritebackRepair(
    id,
    { previewId: preview.id, replacement: preview.replacement },
    human,
    setup.paths,
  );
  await tick();
  expect(io.update).toHaveBeenCalledTimes(1);
  expect(remote[0].body).toContain('Public');
});
it('a confirmed deleted status is recreated only after exact human repair approval', async () => {
  consent();
  await tick();
  remote = [];
  approveWriteback(id, approval('summary', 'Public'), human, setup.paths);
  await tick();
  const e = state().effects.at(-1)!;
  expect(e.state).toBe('repair');
  const preview = await previewWritebackRepair(id, e.id, setup.paths, io);
  expect(preview.observed).toBeNull();
  expect(io.create).toHaveBeenCalledTimes(1);
  approveWritebackRepair(
    id,
    { previewId: preview.id, replacement: preview.replacement },
    human,
    setup.paths,
  );
  await tick();
  expect(io.create).toHaveBeenCalledTimes(2);
});
it('an additional remote edit after repair approval blocks overwrite', async () => {
  consent();
  await tick();
  remote[0].body = 'First edit';
  approveWriteback(id, approval('summary', 'Public'), human, setup.paths);
  await tick();
  const preview = await previewWritebackRepair(
    id,
    state().effects.at(-1)!.id,
    setup.paths,
    io,
  );
  approveWritebackRepair(
    id,
    { previewId: preview.id, replacement: preview.replacement },
    human,
    setup.paths,
  );
  remote[0].body = 'Second edit';
  await tick();
  expect(io.update).not.toHaveBeenCalled();
  expect(state().effects.at(-1)!.state).toBe('repair');
});
it('inbound before receipt is held then confirmed without invalidating released authority', async () => {
  consent();
  const d = saveSpec(),
    rev = d.revisions.at(-1)!;
  releaseFactoryWork(
    id,
    {
      requestKey: 'release',
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
  const create = io.create;
  io.create = vi.fn(async (c, n, b, s) => {
    const result = await create(c, n, b, s);
    await runFactoryGitHubSync(setup.paths, {
      repository: io.repository,
      issue: io.issue,
      issues: async () => ({ items: [issue], hasNext: false }),
      comments: io.comments,
      comment: io.comment,
      planning: async () => {},
    });
    expect(factoryGitHubState(setup.paths).comments[0].echo).toBe(
      'awaiting-receipt',
    );
    return result;
  });
  await tick();
  expect(factoryGitHubState(setup.paths).comments[0].echo).toBe('confirmed');
  expect(getFactoryWork(id, setup.paths).eligible).toBe(true);
});
it('genuine other-bot discussion remains attributed context and invalidates release', async () => {
  consent();
  await tick();
  remote.push({
    ...remote[0],
    id: 33,
    user: { login: 'other-bot' },
    body: 'Please consider the compatibility impact.',
  });
  await runFactoryGitHubSync(setup.paths, {
    repository: io.repository,
    issue: io.issue,
    issues: async () => ({ items: [issue], hasNext: false }),
    comments: io.comments,
    comment: io.comment,
    planning: async () => {},
  });
  const comments = factoryGitHubState(setup.paths).comments;
  expect(comments.find((c) => c.remoteId === '33')?.echo).toBe('external');
  expect(getFactoryWork(id, setup.paths).source.attention).toContain('33');
});

it('definite provider rate-limit rejection can retry the same authorized effect after recovery', async () => {
  consent();
  const create = io.create;
  io.create = vi.fn(async () => {
    throw new GitHubApiError(429, null, 'Synthetic limit', {
      rateLimited: true,
      retryAt: Date.now() + 600000,
    });
  });
  await tick();
  const e = state().effects[0];
  expect(e.state).toBe('failed');
  expect(e.retryAt).toBeGreaterThan(Date.now() + 300000);
  io.create = create;
  recoverWriteback(id, { effectId: e.id, action: 'retry' }, human, setup.paths);
  await tick();
  expect(state().effects.find((x) => x.id === e.id)?.state).toBe('sent');
  expect(remote).toHaveLength(1);
});
it('same login with different numeric actor is not an owned echo', async () => {
  consent();
  await tick();
  expect(
    dbRun(setup.paths, (db) =>
      echoDisposition(db, id, {
        ...remote[0],
        user: { login: 'neon-bot', id: 88 },
      }),
    ),
  ).toBe('external');
});
it('duplicate exact remote candidates remain uncertain, never select an arbitrary receipt', async () => {
  consent();
  const create = io.create;
  io.create = vi.fn(async (c, n, b, s) => {
    const posted = await create(c, n, b, s);
    remote.push({ ...posted, id: 99 });
    throw new Error('Lost');
  });
  await tick();
  const e = state().effects[0];
  recoverWriteback(id, { effectId: e.id, action: 'retry' }, human, setup.paths);
  await tick();
  expect(state().effects[0].state).toBe('uncertain');
  expect(io.create).toHaveBeenCalledTimes(1);
});
it('source closure and reopening never revive an old question approval', async () => {
  consent();
  approveWriteback(id, approval(), human, setup.paths);
  for (const [state, updated_at] of [
    ['closed', '2026-09-05T01:00:00Z'],
    ['open', '2026-09-05T02:00:00Z'],
  ] as const)
    dbRun(setup.paths, (db) =>
      reconcileGitHubSource(
        db,
        {
          ...connection,
          connectionId: connection.id,
          issue: { ...issue, state, updated_at },
        },
        setup.paths,
      ),
    );
  await tick();
  expect(state().effects.find((e) => e.kind === 'question')?.state).toBe(
    'cancelled',
  );
  expect(io.create).not.toHaveBeenCalled();
});

it.each(
  [401, 403, 422, 429].flatMap((status) =>
    [false, true].flatMap((known) =>
      ['repository', 'issue', 'receipt'].map((read) => ({
        status,
        known,
        read,
      })),
    ),
  ),
)(
  'recovery GET $read status $status (known ID=$known) cannot turn an uncertain write into a resend',
  async ({ status, read, known }) => {
    consent();
    if (known) {
      await tick();
      approveWriteback(
        id,
        approval('summary', 'Approved summary'),
        human,
        setup.paths,
      );
      const update = io.update;
      io.update = vi.fn(async (c, remoteId, body, signal) => {
        await update(c, remoteId, body, signal);
        throw Error('Lost update receipt');
      });
    } else {
      const create = io.create;
      io.create = vi.fn(async (c, n, body, signal) => {
        await create(c, n, body, signal);
        throw Error('Lost create receipt');
      });
    }
    await tick();
    const e = state().effects.at(-1)!;
    expect(e.state).toBe('uncertain');
    const key =
      read === 'receipt'
        ? known
          ? 'comment'
          : 'comments'
        : (read as 'repository' | 'issue');
    const original = io[key];
    io[key] = vi.fn(async () => {
      throw new GitHubApiError(
        status,
        null,
        'Synthetic recovery-read rejection',
      );
    });
    const creates = vi.mocked(io.create).mock.calls.length,
      updates = vi.mocked(io.update).mock.calls.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      recoverWriteback(
        id,
        { effectId: e.id, action: 'retry' },
        human,
        setup.paths,
      );
      await tick();
      expect(state().effects.find((x) => x.id === e.id)?.state).toBe(
        'uncertain',
      );
    }
    expect(io.create).toHaveBeenCalledTimes(creates);
    expect(io.update).toHaveBeenCalledTimes(updates);
    Object.assign(io, { [key]: original });
    recoverWriteback(
      id,
      { effectId: e.id, action: 'retry' },
      human,
      setup.paths,
    );
    await tick();
    expect(state().effects.find((x) => x.id === e.id)?.state).toBe('sent');
    expect(io.create).toHaveBeenCalledTimes(creates);
    expect(io.update).toHaveBeenCalledTimes(updates);
  },
);
async function approveObservedRepair() {
  consent();
  await tick();
  const baseline = state().status!.confirmedBody;
  remote[0] = {
    ...remote[0],
    body: 'Human-owned remote edit',
    updated_at: '2026-09-05T04:00:00Z',
  };
  await runFactoryGitHubSync(setup.paths, {
    repository: io.repository,
    issue: io.issue,
    issues: async () => ({ items: [issue], hasNext: false }),
    comments: io.comments,
    comment: io.comment,
    planning: async () => {},
  });
  const repairEffect = state().effects.at(-1)!;
  expect(repairEffect.state).toBe('repair');
  const preview = await previewWritebackRepair(
    id,
    repairEffect.id,
    setup.paths,
    io,
  );
  approveWritebackRepair(
    id,
    { previewId: preview.id, replacement: preview.replacement },
    human,
    setup.paths,
  );
  expect(state().status!.confirmedBody).toBe(baseline);
  expect(state().status!.confirmedBody).not.toBe('Human-owned remote edit');
  return { baseline, effect: state().effects.at(-1)! };
}
it('task changes cannot coalesce a reviewed repair into an unapproved replacement', async () => {
  const { baseline, effect } = await approveObservedRepair();
  saveSpec();
  await tick();
  await tick();
  expect(io.update).not.toHaveBeenCalled();
  expect(remote[0].body).toBe('Human-owned remote edit');
  expect(state().status!.confirmedBody).toBe(baseline);
  expect(state().effects.find((e) => e.id === effect.id)?.state).toBe('repair');
  const renewed = await previewWritebackRepair(id, effect.id, setup.paths, io);
  approveWritebackRepair(
    id,
    { previewId: renewed.id, replacement: renewed.replacement },
    human,
    setup.paths,
  );
  await tick();
  expect(io.update).toHaveBeenCalledTimes(1);
  expect(state().status!.repairRequired).toBe(false);
});
it('ingested human edit → approved repair → opt-out → re-enable still requires a new repair review', async () => {
  const { baseline, effect } = await approveObservedRepair();
  consent(false);
  consent(true);
  await tick();
  await tick();
  expect(io.update).not.toHaveBeenCalled();
  expect(remote[0].body).toBe('Human-owned remote edit');
  expect(state().status!.confirmedBody).toBe(baseline);
  expect(state().effects.find((e) => e.id === effect.id)?.state).toBe('repair');
  const renewed = await previewWritebackRepair(id, effect.id, setup.paths, io);
  approveWritebackRepair(
    id,
    { previewId: renewed.id, replacement: renewed.replacement },
    human,
    setup.paths,
  );
  await tick();
  expect(io.update).toHaveBeenCalledTimes(1);
});
it('repo context invalidates public released wording and the previously approved scope', async () => {
  consent();
  const d = saveSpec(),
    rev = d.revisions.at(-1)!;
  releaseFactoryWork(
    id,
    {
      requestKey: 'released',
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
  approveWriteback(
    id,
    approval('summary', 'Previously approved scope'),
    human,
    setup.paths,
  );
  await tick();
  expect(remote[0].body).toContain('Released — awaiting coding executor');
  expect(remote[0].body).toContain('Previously approved scope');
  const repos = JSON.parse(readFileSync(setup.paths.repos, 'utf8'));
  repos.repos[0].packageScripts = { test: 'echo synthetic context change' };
  writeFileSync(setup.paths.repos, JSON.stringify(repos));
  expect(getFactoryWork(id, setup.paths).work.lifecycle).toBe('queued');
  expect(getFactoryWork(id, setup.paths).eligible).toBe(false);
  expect(state().template).toContain('Review needed');
  expect(state().template).not.toContain('Previously approved scope');
  await tick();
  expect(remote[0].body).toContain('Review needed');
  expect(remote[0].body).not.toContain('Released — awaiting coding executor');
  expect(remote[0].body).not.toContain('Previously approved scope');
  expect(() =>
    approveWriteback(
      id,
      approval('summary', 'New text without context adoption'),
      human,
      setup.paths,
    ),
  ).toThrow('changed');
});

it('repo changes during a provider read invalidate the final publication fence', async () => {
  consent();
  approveWriteback(id, approval(), human, setup.paths);
  io.identity = vi.fn(async () => {
    const repos = JSON.parse(readFileSync(setup.paths.repos, 'utf8'));
    repos.repos[0].packageScripts = { test: 'echo changed during read' };
    writeFileSync(setup.paths.repos, JSON.stringify(repos));
    return { login: 'neon-bot', id: 77 };
  });
  await tick();
  expect(io.create).not.toHaveBeenCalled();
  expect(state().effects.find((e) => e.kind === 'question')?.state).toBe(
    'cancelled',
  );
});

it.each(['optout', 'taskchange'] as const)(
  'deleted status repair can be renewed after %s without losing the managed identity',
  async (change) => {
    consent();
    await tick();
    const managed = state().status!;
    remote = [];
    approveWriteback(id, approval('summary', 'Public'), human, setup.paths);
    await tick();
    const first = await previewWritebackRepair(
      id,
      state().effects.at(-1)!.id,
      setup.paths,
      io,
    );
    approveWritebackRepair(
      id,
      { previewId: first.id, replacement: first.replacement },
      human,
      setup.paths,
    );
    const recreation = state().effects.at(-1)!;
    expect(recreation.remoteId).toBeNull();
    if (change === 'optout') {
      consent(false);
      consent(true);
    } else saveSpec();
    await tick();
    expect(state().effects.find((e) => e.id === recreation.id)?.state).toBe(
      'repair',
    );
    expect(state().status!.remoteId).toBe(managed.remoteId);
    expect(io.create).toHaveBeenCalledTimes(1);
    const renewed = await previewWritebackRepair(
      id,
      recreation.id,
      setup.paths,
      io,
    );
    expect(renewed.observed).toBeNull();
    expect(io.comment).toHaveBeenLastCalledWith(
      expect.anything(),
      managed.remoteId,
      expect.anything(),
    );
    approveWritebackRepair(
      id,
      { previewId: renewed.id, replacement: renewed.replacement },
      human,
      setup.paths,
    );
    await tick();
    await tick();
    expect(io.create).toHaveBeenCalledTimes(2);
    expect(io.update).not.toHaveBeenCalled();
    expect(io.comment).toHaveBeenLastCalledWith(
      expect.anything(),
      managed.remoteId,
      expect.anything(),
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].body).toBe(state().effects.at(-1)!.body);
    expect(remote[0].body).toContain(renewed.replacement);
    expect(state().effects.at(-1)!.state).toBe('sent');
    expect(state().status!.repairRequired).toBe(false);
  },
);

it.each(['manual', 'github'] as const)(
  'typed repo ABA permanently revokes %s release authority and requires a new review',
  async (provider) => {
    expect(
      (
        await updateRepo(
          { id: 'fixture', packageScripts: { test: 'echo A' } },
          setup.paths,
        )
      ).ok,
    ).toBe(true);
    if (provider === 'manual')
      id = submitFactoryWork(
        {
          requestKey: 'manual-aba',
          title: 'Manual context review',
          body: 'Synthetic',
          repoId: 'fixture',
        },
        human,
        setup.paths,
      ).work.id;
    const d = saveSpec(),
      rev = d.revisions.at(-1)!;
    const release = {
      requestKey: 'aba-release',
      expectedVersion: d.work.version,
      specVersion: rev.version,
      specHash: rev.hash,
      sourceVersion: d.source.version,
      repoFingerprint: d.repoFingerprint,
      policyVersion: 'isolated-local-v1',
    };
    releaseFactoryWork(id, release, human, setup.paths);
    let question: ReturnType<typeof approval> | undefined;
    if (provider === 'github') {
      consent();
      approveWriteback(
        id,
        approval('summary', 'Approved scope before ABA'),
        human,
        setup.paths,
      );
      await tick();
      question = approval();
      approveWriteback(id, question, human, setup.paths);
    }
    const before = getFactoryWork(id, setup.paths);
    const noop = await updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo A' } },
      setup.paths,
    );
    expect(noop.ok).toBe(true);
    expect(noop.changed).toBe(false);
    expect(getFactoryWork(id, setup.paths).source.version).toBe(
      before.source.version,
    );
    expect(getFactoryWork(id, setup.paths).eligible).toBe(true);
    await updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo B' } },
      setup.paths,
    );
    await updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo A' } },
      setup.paths,
    );
    const after = getFactoryWork(id, setup.paths);
    expect(after.repoFingerprint).toBe(before.repoFingerprint);
    expect(after.source.version).toBe(before.source.version + 2);
    expect(after.eligible).toBe(false);
    expect(after.releases.at(-1)!.withdrawnAt).not.toBeNull();
    expect(releaseFactoryWork(id, release, human, setup.paths).eligible).toBe(
      false,
    );
    expect(() =>
      releaseFactoryWork(
        id,
        { ...release, requestKey: 'stale-new-release' },
        human,
        setup.paths,
      ),
    ).toThrow();
    if (provider === 'github') {
      expect(state().template).toContain('Review needed');
      expect(state().template).not.toContain('Approved scope before ABA');
      expect(() =>
        approveWriteback(
          id,
          { ...question!, requestKey: 'stale-approval' },
          human,
          setup.paths,
        ),
      ).toThrow();
      await tick();
      await tick();
      expect(state().effects.find((e) => e.kind === 'question')!.state).toBe(
        'cancelled',
      );
      expect(remote).toHaveLength(1);
      expect(remote[0].body).toContain('Review needed');
      expect(remote[0].body).not.toContain('Approved scope before ABA');
    }
    const reviewed = saveSpec(),
      newRev = reviewed.revisions.at(-1)!;
    expect(
      releaseFactoryWork(
        id,
        {
          ...release,
          requestKey: 'renewed-release',
          expectedVersion: reviewed.work.version,
          specVersion: newRev.version,
          specHash: newRev.hash,
          sourceVersion: reviewed.source.version,
          repoFingerprint: reviewed.repoFingerprint,
        },
        human,
        setup.paths,
      ).eligible,
    ).toBe(true);
  },
);
it.each(['manual', 'github'] as const)(
  'remove and re-add identical repository cannot restore %s authority',
  async (provider) => {
    execFileSync('git', ['init', '-b', 'main', setup.paths.home], {
      stdio: 'ignore',
    });
    await updateRepo({ id: 'fixture', packageScripts: {} }, setup.paths);
    if (provider === 'manual')
      id = submitFactoryWork(
        {
          requestKey: 'manual-removal',
          title: 'Manual removal review',
          body: 'Synthetic',
          repoId: 'fixture',
        },
        human,
        setup.paths,
      ).work.id;
    const d = saveSpec(),
      rev = d.revisions.at(-1)!;
    releaseFactoryWork(
      id,
      {
        requestKey: 'remove-release',
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
    if (provider === 'github') {
      consent();
      approveWriteback(
        id,
        approval('summary', 'Old public scope'),
        human,
        setup.paths,
      );
      await tick();
      approveWriteback(id, approval(), human, setup.paths);
    }
    expect(
      (await removeRepo({ id: 'fixture', confirm: true }, setup.paths)).ok,
    ).toBe(true);
    expect(getFactoryWork(id, setup.paths).eligible).toBe(false);
    expect(
      (
        await addRepo(
          {
            id: 'fixture',
            path: setup.paths.home,
            githubOwner: 'example',
            githubName: 'fixture',
            defaultBranch: 'main',
            packageScripts: {},
          },
          setup.paths,
        )
      ).ok,
    ).toBe(true);
    const after = getFactoryWork(id, setup.paths);
    expect(after.repoFingerprint).toBe(d.repoFingerprint);
    expect(after.eligible).toBe(false);
    expect(after.source.version).toBe(d.source.version + 2);
    expect(after.releases.at(-1)!.withdrawnAt).not.toBeNull();
    if (provider === 'github') {
      await tick();
      await tick();
      expect(state().template).toContain('Review needed');
      expect(state().template).not.toContain('Old public scope');
      expect(state().effects.find((e) => e.kind === 'question')!.state).toBe(
        'cancelled',
      );
      expect(remote).toHaveLength(1);
    }
  },
);
it('repo ABA during awaited provider reads fences a previously approved exact question', async () => {
  consent();
  await tick();
  approveWriteback(id, approval(), human, setup.paths);
  const original = io.identity;
  io.identity = vi.fn(async (c, signal) => {
    await updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo changed' } },
      setup.paths,
    );
    await updateRepo({ id: 'fixture', packageScripts: {} }, setup.paths);
    return original(c, signal);
  });
  await tick();
  expect(io.create).toHaveBeenCalledTimes(1);
  expect(state().effects.find((e) => e.kind === 'question')!.state).toBe(
    'cancelled',
  );
});
it('concurrent typed registry writes reject a stale async snapshot', async () => {
  const read = runtimeHome.readRuntimeJson;
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(runtimeHome, 'readRuntimeJson').mockImplementation(
    async (...args) => {
      const result = await read(...args);
      if (args[0] === setup.paths.repos) {
        if (++arrived === 2) release();
        await gate;
      }
      return result;
    },
  );
  const before = getFactoryWork(id, setup.paths);
  const results = await Promise.all([
    updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo first' } },
      setup.paths,
    ),
    updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo second' } },
      setup.paths,
    ),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.message).toContain('Reload and retry');
  expect(getFactoryWork(id, setup.paths).source.version).toBe(
    before.source.version + 1,
  );
});

it('revocation is durable before registry replacement and survives a failed write', async () => {
  const d = saveSpec(),
    rev = d.revisions.at(-1)!;
  releaseFactoryWork(
    id,
    {
      requestKey: 'write-failure-release',
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
  consent();
  approveWriteback(
    id,
    approval('summary', 'Scope before failed write'),
    human,
    setup.paths,
  );
  await tick();
  approveWriteback(id, approval(), human, setup.paths);
  const original = readFileSync(setup.paths.repos, 'utf8');
  vi.spyOn(runtimeFiles, 'writeJsonAtomicSync').mockImplementation(() => {
    const current = getFactoryWork(id, setup.paths);
    expect(current.eligible).toBe(false);
    expect(current.source.version).toBe(d.source.version + 1);
    expect(state().template).not.toContain('Scope before failed write');
    throw Error('Synthetic registry write failure');
  });
  await expect(
    updateRepo(
      { id: 'fixture', packageScripts: { test: 'echo new' } },
      setup.paths,
    ),
  ).rejects.toThrow('Synthetic registry write failure');
  expect(readFileSync(setup.paths.repos, 'utf8')).toBe(original);
  await tick();
  await tick();
  expect(state().effects.find((e) => e.kind === 'question')!.state).toBe(
    'cancelled',
  );
  expect(remote).toHaveLength(1);
  expect(getFactoryWork(id, setup.paths).eligible).toBe(false);
});
