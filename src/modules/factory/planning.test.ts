import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentRunError } from '@flue/runtime';
import {
  ensureRuntimeHomeSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { emptyFactorySpec } from '../../../shared/factory';
import {
  submitFactoryWork,
  getFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  transitionFactoryWork,
  updateFactorySource,
} from './service';
import {
  prepareFactoryPlanning,
  getPlanningState,
  getPlanningIntent,
  getBoundPlanningSession,
  proposeFactorySpec,
  recordTriage,
  updatePlanningIntent,
  refreshFactoryPlanningContext,
} from './planning-store';
import {
  resumeFactoryPlanning,
  type PlanningTransport,
} from './planning-dispatch';
import { readPlanningRepo } from './repo-tools';
let paths: RuntimePaths;
const human = { kind: 'human' as const, id: 'local-operator' };
const triage = {
  disposition: 'implement' as const,
  summary: 'A small local change.',
  priority: 'normal' as const,
  missingInformation: [],
  candidateIds: [],
};
const spec = {
  ...emptyFactorySpec(),
  outcome: 'Find tasks',
  scope: 'Titles only',
  approach: 'Add a filter',
  acceptanceCriteria: [{ id: 'ac-1', text: 'Filters task titles' }],
};
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-planning-')));
  ensureRuntimeHomeSync(paths);
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true },
      models: { default: 'faux/faux-1' },
    }),
  );
  writeFileSync(paths.repos, JSON.stringify({ version: 1, repos: [] }));
});
afterEach(() => {
  rmSync(paths.home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function task() {
  return submitFactoryWork(
    {
      requestKey: crypto.randomUUID(),
      title: 'Find tasks',
      body: 'Search local task titles.',
      repoId: null,
    },
    human,
    paths,
  );
}
function prepare() {
  const work = task();
  return prepareFactoryPlanning(
    work.work.id,
    {
      requestKey: 'message-1',
      expectedVersion: 1,
      message: 'Please propose a plan.',
    },
    paths,
  );
}
function proposal(intent: ReturnType<typeof prepare>, content = spec) {
  return {
    expectedVersion: intent.snapshot.work.version,
    expectedSpecVersion: intent.snapshot.work.specVersion,
    expectedRepoFingerprint: intent.context.repoFingerprint,
    spec: content,
  };
}
function planning() {
  const intent = prepare();
  recordTriage(intent.sessionId, intent.id, triage, paths);
  return updatePlanningIntent(
    intent.id,
    (i) => {
      i.stage = 'planner';
    },
    paths,
  );
}
it('persists the dedicated task binding and exact request before dispatch, and rejects key reuse or parallel messages', () => {
  const intent = prepare();
  expect(
    getBoundPlanningSession(intent.sessionId, paths).session,
  ).toMatchObject({
    agentName: 'factory-planner',
    kind: 'task',
    linkedTaskId: intent.workId,
  });
  expect(getPlanningIntent(intent.id, runtimePaths(paths.home))).toEqual(
    intent,
  );
  expect(
    prepareFactoryPlanning(
      intent.workId,
      { requestKey: 'message-1', expectedVersion: 1, message: intent.message },
      paths,
    ),
  ).toEqual(intent);
  expect(() =>
    prepareFactoryPlanning(
      intent.workId,
      { requestKey: 'message-1', expectedVersion: 1, message: 'Different' },
      paths,
    ),
  ).toThrow(/another message/);
  expect(() =>
    prepareFactoryPlanning(
      intent.workId,
      { requestKey: 'message-2', expectedVersion: 1, message: 'More' },
      paths,
    ),
  ).toThrow(/pending/);
  expect(() => getBoundPlanningSession('neondeck-main', paths)).toThrow(
    /Unbound/,
  );
});
it('commits one model revision and its idempotency effect together; a replay cannot duplicate the revision', () => {
  const intent = planning();
  const input = proposal(intent);
  const first = proposeFactorySpec(
    intent.sessionId,
    intent.id,
    'tool-1',
    input,
    paths,
  );
  expect(first.version).toBe(2);
  expect(
    proposeFactorySpec(
      intent.sessionId,
      intent.id,
      'tool-1',
      input,
      runtimePaths(paths.home),
    ),
  ).toEqual(first);
  expect(getFactoryWork(intent.workId, paths).revisions).toHaveLength(2);
  expect(getFactoryWork(intent.workId, paths).revisions[1].authorKind).toBe(
    'model',
  );
  expect(() =>
    proposeFactorySpec(intent.sessionId, intent.id, 'tool-2', input, paths),
  ).toThrow(/changed/);
  expect(() =>
    proposeFactorySpec(
      intent.sessionId,
      intent.id,
      'tool-1',
      { ...input, spec: { ...spec, scope: 'Changed' } },
      paths,
    ),
  ).toThrow(/differs/);
});
it('rejects cross-task/session, stale human/model, and revoked tool authority; release remains human-only', () => {
  const intent = planning();
  const input = proposal(intent);
  expect(() =>
    proposeFactorySpec('neondeck-main', intent.id, 'cross', input, paths),
  ).toThrow(/capability/);
  saveFactorySpec(intent.workId, input, human, paths);
  expect(() =>
    proposeFactorySpec(intent.sessionId, intent.id, 'stale', input, paths),
  ).toThrow(/changed/);
  expect(() =>
    releaseFactoryWork(
      intent.workId,
      {},
      { kind: 'model', id: intent.sessionId } as never,
      paths,
    ),
  ).toThrow(/human/);
  const other = planning();
  updatePlanningIntent(
    other.id,
    (i) => {
      i.abortRequested = true;
    },
    paths,
  );
  expect(() =>
    proposeFactorySpec(
      other.sessionId,
      other.id,
      'stopped',
      proposal(other),
      paths,
    ),
  ).toThrow(/capability/);
});
it('retains original context until explicit refresh, including model changes', () => {
  const intent = planning();
  updatePlanningIntent(
    intent.id,
    (i) => {
      i.stage = 'completed';
    },
    paths,
  );
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true },
      models: { default: 'faux/faux-2' },
    }),
  );
  expect(getPlanningState(intent.workId, paths)).toMatchObject({
    contextStale: true,
    model: 'faux/faux-1',
  });
  expect(() =>
    prepareFactoryPlanning(
      intent.workId,
      { requestKey: 'm2', expectedVersion: 1, message: 'Revise' },
      paths,
    ),
  ).toThrow(/context changed/);
  refreshFactoryPlanningContext(intent.workId, 1, paths);
  expect(getPlanningState(intent.workId, paths)).toMatchObject({
    contextStale: false,
    model: 'faux/faux-2',
    sessionId: intent.sessionId,
  });
});
it('reconciles an accepted dispatch with a lost receipt through the same idempotent delivery', async () => {
  const intent = prepare();
  const admitted = new Map<string, string>();
  let failReceipt = true;
  const calls: string[] = [];
  const io: PlanningTransport = {
    async dispatch(i, stage) {
      const key = `${i.id}:${stage}`;
      calls.push(key);
      admitted.set(key, admitted.get(key) ?? `sub-${admitted.size}`);
      if (failReceipt) {
        failReceipt = false;
        throw new Error('receipt lost');
      }
      return { submissionId: admitted.get(key)! };
    },
    async read(i, stage) {
      if (stage === 'triage') recordTriage(i.sessionId, i.id, triage, paths);
      else
        proposeFactorySpec(i.sessionId, i.id, 'model-tool', proposal(i), paths);
    },
    async abort() {},
  };
  await resumeFactoryPlanning(intent.id, paths, io);
  expect(getPlanningState(intent.workId, paths)).toMatchObject({
    activity: 'pending',
    error: expect.stringContaining('recovery'),
  });
  await resumeFactoryPlanning(intent.id, runtimePaths(paths.home), io);
  expect(calls[0]).toBe(calls[1]);
  expect(admitted.size).toBe(2);
  expect(getPlanningState(intent.workId, paths).activity).toBe('completed');
  expect(getFactoryWork(intent.workId, paths).revisions).toHaveLength(2);
});
it('invalid triage and terminal provider failure leave retryable inspectable state and never start planner', async () => {
  const intent = prepare();
  expect(() =>
    recordTriage(
      intent.sessionId,
      intent.id,
      { ...triage, disposition: 'release' },
      paths,
    ),
  ).toThrow();
  expect(() =>
    recordTriage(
      intent.sessionId,
      intent.id,
      { ...triage, candidateIds: ['unconfigured'] },
      paths,
    ),
  ).toThrow(/Unknown/);
  await resumeFactoryPlanning(intent.id, paths, {
    dispatch: async () => ({ submissionId: 'bad-sub' }),
    read: async () => {},
    abort: async () => {},
  });
  expect(getPlanningState(intent.workId, paths)).toMatchObject({
    activity: 'failed',
    triage: null,
  });
  const retry = prepareFactoryPlanning(
    intent.workId,
    { requestKey: 'retry', expectedVersion: 1, message: 'Try again' },
    paths,
  );
  const failure = Object.assign(Object.create(AgentRunError.prototype), {
    message: 'synthetic provider error',
    outcome: 'failed',
  });
  await resumeFactoryPlanning(retry.id, paths, {
    dispatch: async () => ({ submissionId: 'failure-sub' }),
    read: async () => {
      throw failure;
    },
    abort: async () => {},
  });
  expect(getPlanningState(intent.workId, paths)).toMatchObject({
    activity: 'failed',
    error: expect.stringContaining('failed'),
  });
  expect(getFactoryWork(intent.workId, paths).revisions).toHaveLength(1);
});
it('a pause races a model save through the same version fence', () => {
  const intent = planning();
  transitionFactoryWork(
    intent.workId,
    { action: 'pause', expectedVersion: 1 },
    human,
    paths,
  );
  expect(() =>
    proposeFactorySpec(
      intent.sessionId,
      intent.id,
      'paused',
      proposal(intent),
      paths,
    ),
  ).toThrow(/not open/);
});
it('reads only bounded committed regular files and requires inspected evidence for references', () => {
  const repo = join(paths.home, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), 'Committed public fixture');
  writeFileSync(join(repo, '.env'), 'SYNTHETIC=fixture');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  );
  writeFileSync(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'demo',
          path: repo,
          defaultBranch: 'main',
          github: { owner: 'example', name: 'demo' },
        },
      ],
    }),
  );
  const work = submitFactoryWork(
    { requestKey: 'repo', title: 'Read', body: 'Plan', repoId: 'demo' },
    human,
    paths,
  );
  const intent = prepareFactoryPlanning(
    work.work.id,
    { requestKey: 'repo-plan', expectedVersion: 1, message: 'Plan' },
    paths,
  );
  updatePlanningIntent(
    intent.id,
    (i) => {
      i.stage = 'planner';
    },
    paths,
  );
  writeFileSync(join(repo, 'README.md'), 'Uncommitted context');
  expect(
    readPlanningRepo(intent.sessionId, intent.id, 'README.md', 'read-1', paths)
      .content,
  ).toBe('Committed public fixture');
  for (const name of ['../README.md', '/etc/passwd', '.env'])
    expect(() =>
      readPlanningRepo(intent.sessionId, intent.id, name, 'bad', paths),
    ).toThrow();
  const proposed = {
    ...spec,
    references: [
      {
        path: 'missing.ts',
        commit: intent.context.repoCommit!,
        note: 'Invented',
      },
    ],
  };
  expect(() =>
    proposeFactorySpec(
      intent.sessionId,
      intent.id,
      'ref',
      proposal(intent, proposed),
      paths,
    ),
  ).toThrow(/references/);
});
it('automatically admitted triage is deduped by meaningful input and never starts planning', async () => {
  const { prepareFactoryTriage } = await import('./planning-store');
  const work = task();
  const intent = prepareFactoryTriage(work.work.id, paths)!;
  expect(intent.triageOnly).toBe(true);
  expect(prepareFactoryTriage(work.work.id, paths)?.id).toBe(intent.id);
  const dispatched: string[] = [];
  await resumeFactoryPlanning(intent.id, paths, {
    async dispatch(i, stage) {
      dispatched.push(stage);
      return { submissionId: i.id };
    },
    async read(i) {
      recordTriage(i.sessionId, i.id, triage, paths);
    },
    async abort() {},
  });
  expect(dispatched).toEqual(['triage']);
  expect(getFactoryWork(work.work.id, paths).revisions).toHaveLength(1);
  expect(getPlanningState(work.work.id, paths)).toMatchObject({
    activity: 'completed',
    plannerStarted: false,
    triage,
  });
  expect(prepareFactoryTriage(work.work.id, paths)?.id).toBe(intent.id);
  const request = prepareFactoryPlanning(
    work.work.id,
    { requestKey: 'human-plan', expectedVersion: 1, message: 'Now plan it' },
    paths,
  );
  expect(request.stage).toBe('planner');
  expect(request.triageOnly).toBe(false);
});
it('replays a persisted abort before awaiting settlement after restart', async () => {
  const intent = prepare();
  updatePlanningIntent(
    intent.id,
    (i) => {
      i.abortRequested = true;
      i.triageSubmissionId = 'accepted-before-restart';
    },
    paths,
  );
  const calls: string[] = [];
  await resumeFactoryPlanning(intent.id, runtimePaths(paths.home), {
    async dispatch() {
      calls.push('dispatch');
      return { submissionId: 'unexpected' };
    },
    async abort() {
      calls.push('abort');
    },
    async read() {
      calls.push('read');
    },
  });
  expect(calls).toEqual(['abort', 'read']);
  expect(getPlanningState(intent.workId, paths).activity).toBe('failed');
});
it.each([false, true])(
  'triages changed input after an in-flight classifier settles (failed=%s)',
  async (failed) => {
    const { prepareFactoryTriage } = await import('./planning-store');
    const work = task();
    const first = prepareFactoryTriage(work.work.id, paths)!;
    // A valid tool result can precede the final Flue settlement receipt.
    if (!failed) recordTriage(first.sessionId, first.id, triage, paths);
    updateFactorySource(
      work.work.id,
      {
        expectedVersion: 1,
        title: 'Changed title',
        body: work.source.body,
        repoId: null,
      },
      human,
      paths,
    );
    expect(prepareFactoryTriage(work.work.id, paths)?.id).toBe(first.id);
    const dispatched: string[] = [];
    const io: PlanningTransport = {
      async dispatch(i, stage) {
        expect(stage).toBe('triage');
        dispatched.push(i.id);
        return { submissionId: i.id };
      },
      async read(i) {
        if (i.id === first.id && failed)
          throw Object.assign(Object.create(AgentRunError.prototype), {
            outcome: 'failed',
          });
        recordTriage(i.sessionId, i.id, triage, paths);
      },
      async abort() {},
    };
    await resumeFactoryPlanning(first.id, paths, io);
    const successor = prepareFactoryTriage(work.work.id, paths)!;
    expect(successor.id).not.toBe(first.id);
    await resumeFactoryPlanning(successor.id, paths, io);
    expect(dispatched).toEqual([first.id, successor.id]);
    expect(getPlanningState(work.work.id, paths).activity).toBe('completed');
    expect(getFactoryWork(work.work.id, paths).revisions).toHaveLength(1);
  },
);

it('binds section feedback to its retained original revision without selecting another task/session', () => {
  const original = task();
  const first = original.revisions[0];
  const revised = saveFactorySpec(
    original.work.id,
    {
      expectedVersion: 1,
      expectedSpecVersion: 1,
      expectedRepoFingerprint: null,
      spec,
    },
    human,
    paths,
  );
  const ref = {
    version: first.version,
    hash: first.hash,
    kind: 'section',
    id: 'outcome',
  };
  const intent = prepareFactoryPlanning(
    original.work.id,
    {
      requestKey: 'section',
      expectedVersion: revised.work.version,
      message: 'Please explain this choice.',
      discussion: ref,
    },
    paths,
  );
  expect(intent.message).toContain(
    `Discussing brief v1 (${first.hash}), section:outcome`,
  );
  expect(intent.message).toContain(first.spec.outcome);
  expect(intent.snapshot.revisions[0].version).toBe(2);
  expect(getFactoryWork(original.work.id, paths).revisions).toHaveLength(2);
  expect(getFactoryWork(original.work.id, paths).releases).toHaveLength(0);
  expect(
    prepareFactoryPlanning(
      original.work.id,
      {
        requestKey: 'section',
        expectedVersion: revised.work.version,
        message: 'Please explain this choice.',
        discussion: ref,
      },
      paths,
    ).id,
  ).toBe(intent.id);
  const other = task();
  expect(() =>
    prepareFactoryPlanning(
      other.work.id,
      {
        requestKey: 'bad',
        expectedVersion: 1,
        message: 'Another session',
        discussion: { ...ref, hash: 'f'.repeat(64) },
      },
      paths,
    ),
  ).toThrow('Discussion reference is not retained in this task');
  expect(() =>
    prepareFactoryPlanning(
      other.work.id,
      {
        requestKey: 'bad',
        expectedVersion: 1,
        message: 'Redirect',
        discussion: { ...ref, sessionId: intent.sessionId },
      },
      paths,
    ),
  ).toThrow();
  expect(() =>
    prepareFactoryPlanning(
      other.work.id,
      {
        requestKey: 'bad',
        expectedVersion: 1,
        message: 'Unknown field',
        discussion: { ...ref, hash: other.revisions[0].hash, id: 'release' },
      },
      paths,
    ),
  ).toThrow('Discussion reference is not retained in this task');
});
