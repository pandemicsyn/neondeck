import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  completeAutopilotWatchIfTerminal,
  configurePrAutopilot,
  controlPrAutopilot,
  messagePrAutopilotOwner,
  recoverInterruptedAutopilotOwners,
  runAutopilotWatchEvent,
  settleAutopilotOwnerObservation,
} from './modules/autopilot';
import { safePushAutopilotOwner } from './modules/autopilot/owner/safe-push';
import { buildAutopilotOwnerToolRegistry } from './modules/autopilot/owner/tools';
import { pushInteractiveRepo } from './repo-edit';
import {
  bindWatchAutopilotOwner,
  claimWatchAutopilotTurn,
  readWatch,
  refreshPrWatch,
  transitionWatchAutopilot,
} from './modules/watches';
import {
  createWorktree,
  readManagedWorktree,
  recordWorktreePushSucceeded,
  readWorktreeRecord,
} from './modules/worktrees';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { emptyPrWatchInitialEventBaseline } from './testing/pr-watch-event-baseline';
import { refreshWatchJobEvents } from './modules/scheduler/pr-watch-events';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';
import type { FlueObservation } from '@flue/runtime';

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);
let repositorySeed: SeededGitRepository | undefined;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialFiles: { 'src/app.ts': 'export const value = 1;\n' },
    feature: { files: { 'src/app.ts': 'export const value = 2;\n' } },
  });
});

afterAll(async () => {
  await repositorySeed?.dispose();
});

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('minimal Autopilot watch loop', () => {
  it('configures one watch and retains its stable owner/worktree binding across reloads', async () => {
    const paths = await fixturePaths();
    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'autofix-with-approval',
          processExisting: false,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['confirmAutopilotMode'],
      watch: { autopilotMode: 'notify-only' },
    });
    const result = await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-with-approval',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      watch: {
        id: 'pandemicsyn/neondeck#123',
        autopilotMode: 'autofix-with-approval',
        autopilotStatus: 'watching',
        ownerInstanceId: null,
        worktreeId: null,
      },
    });

    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'pr-owner-stable',
      worktreeId: 'worktree-stable',
    });
    await ensureRuntimeHome(paths);
    await ensureRuntimeHome(paths);

    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      ownerInstanceId: 'pr-owner-stable',
      worktreeId: 'worktree-stable',
    });
    expect(() =>
      bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
        ownerInstanceId: 'pr-owner-replacement',
        worktreeId: 'worktree-stable',
      }),
    ).toThrow(/already bound/);
  });

  it('claims only one turn per fingerprint and exposes an explicit blocked retry', async () => {
    const paths = await fixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(),
    );

    expect(
      claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'event-1'),
    ).toMatchObject({ autopilotStatus: 'working' });
    expect(
      claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'event-1'),
    ).toBeUndefined();
    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
      }),
    ).resolves.toMatchObject({ complete: false, reason: 'owner-working' });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'working',
    });

    const refreshEvents = vi.fn();
    await expect(
      refreshWatchJobEvents(
        [{ watch: { id: 'pandemicsyn/neondeck#123' } }] as never,
        paths,
        { refreshPrWatchEventState: refreshEvents as never },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        changed: false,
        message: expect.stringContaining('Deferred'),
      }),
    ]);
    expect(refreshEvents).not.toHaveBeenCalled();

    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'working',
      to: 'blocked',
    });
    await expect(
      controlPrAutopilot(
        { id: 'pandemicsyn/neondeck#123', operation: 'retry' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotStatus: 'watching' },
    });
  });

  it('reuses one owner/worktree, preserves a prepared commit, and grants push only to the human waiting turn', async () => {
    const { paths, repo, remote } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-with-approval',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(repositorySeed?.featureSha ?? undefined),
    );
    const created = await createWorktree(
      { repoId: 'neondeck', prNumber: 123, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const instanceId = 'pr-owner-stable';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    const prepare = vi.fn(async () => ({
      ok: true as const,
      action: 'autopilot_prepare_pr_worktree',
      changed: false,
      message: 'Prepared exact head.',
      data: {
        pr: {
          headSha: repositorySeed?.featureSha,
          baseSha: repositorySeed?.baseSha,
        },
        worktree: { id: worktree.id },
      },
    }));
    const dispatch = vi.fn(async () => ({
      dispatchId: `dispatch-${dispatch.mock.calls.length + 1}`,
      acceptedAt: '2026-07-20T00:00:00.000Z',
    }));

    const first = await runAutopilotWatchEvent(ownerEvent('event-1'), paths, {
      prepare: prepare as never,
      dispatch: dispatch as never,
    });
    expect(first).toMatchObject({
      state: 'dispatched',
      instanceId,
      worktreeId: worktree.id,
    });
    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);

    const second = await runAutopilotWatchEvent(ownerEvent('event-2'), paths, {
      prepare: prepare as never,
      dispatch: dispatch as never,
    });
    expect(second).toMatchObject({
      state: 'dispatched',
      instanceId,
      worktreeId: worktree.id,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(await gitOutput(worktree.localPath, ['rev-parse', 'HEAD'])).toBe(
      repositorySeed?.featureSha,
    );

    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 3;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'fix: address review']);
    const preparedSha = await gitOutput(worktree.localPath, [
      'rev-parse',
      'HEAD',
    ]);
    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'waiting',
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
      lastEventFingerprint: 'event-2',
    });

    const third = await runAutopilotWatchEvent(ownerEvent('event-3'), paths, {
      prepare: prepare as never,
      dispatch: dispatch as never,
    });
    expect(third).toMatchObject({ state: 'waiting', changed: false });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(await gitOutput(worktree.localPath, ['rev-parse', 'HEAD'])).toBe(
      preparedSha,
    );

    const humanDispatch = vi.fn(async () => ({
      dispatchId: 'human-dispatch',
      acceptedAt: '2026-07-20T00:00:00.000Z',
    }));
    const postPrComment = vi.fn(async (input: { idempotencyKey?: string }) => ({
      ok: true,
      action: 'github_pr_comment',
      changed: true,
      message: 'Posted owner response.',
      idempotencyKey: input.idempotencyKey,
    }));
    await expect(
      messagePrAutopilotOwner(
        {
          id: 'pandemicsyn/neondeck#123',
          message: 'approved, fix the typo then push',
        },
        paths,
        humanDispatch as never,
      ),
    ).resolves.toMatchObject({ ok: true, dispatchId: 'human-dispatch' });
    expect(humanDispatch).toHaveBeenCalledWith({
      agent: 'pr-autopilot-owner',
      id: instanceId,
      input: 'approved, fix the typo then push',
    });
    const firstHumanRegistry = buildAutopilotOwnerToolRegistry({
      watch: {
        ...readWatch(paths, 'pandemicsyn/neondeck#123')!,
        autopilotStatus: 'waiting',
      },
      source: 'direct-human',
      paths,
      postPrComment: postPrComment as never,
    });
    await firstHumanRegistry.tools
      .find((tool) => tool.name === 'neondeck_owner_pr_respond')
      ?.run({ input: { body: 'I am checking one more edit.' } } as never);
    await settleAutopilotOwnerObservation(
      ownerPromptFailure(instanceId),
      paths,
    );
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });
    await expect(
      controlPrAutopilot(
        { id: 'pandemicsyn/neondeck#123', operation: 'retry' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      watch: { autopilotStatus: 'waiting' },
    });
    await messagePrAutopilotOwner(
      {
        id: 'pandemicsyn/neondeck#123',
        message: 'approved, push the held commit',
      },
      paths,
      humanDispatch as never,
    );
    const pushInteractive = vi.fn(
      async (input: Parameters<typeof pushInteractiveRepo>[0]) =>
        pushInteractiveRepo(input, paths, {
          resolveContext: vi.fn(async () => ({
            repo: {
              id: 'neondeck',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: repo,
              defaultBranch: 'main',
            },
            prNumber: 123,
            worktree: await readManagedWorktree(worktree.id, 'neondeck', paths),
            pushRemote: 'origin',
            pushBranch: 'feature',
            linkedPrHead: true,
          })) as never,
          pushGit: vi.fn(async (localPath, target) => {
            await git(localPath, [
              'push',
              target.remote,
              `${target.sha}:refs/heads/${target.branch}`,
            ]);
            return {
              remote: target.remote,
              branch: target.branch,
              force: false,
              stdout: 'pushed to local test remote',
            };
          }),
        }),
    );
    const humanTurnWatch = readWatch(paths, 'pandemicsyn/neondeck#123')!;
    const humanRegistry = buildAutopilotOwnerToolRegistry({
      watch: { ...humanTurnWatch, autopilotStatus: 'waiting' },
      source: 'direct-human',
      paths,
      postPrComment: postPrComment as never,
      pushInteractive: pushInteractive as never,
    });
    const humanPush = humanRegistry.tools.find(
      (tool) => tool.name === 'neondeck_owner_push',
    );
    const humanPushResult = await humanPush?.run({ input: {} } as never);
    expect(humanPushResult).toMatchObject({
      ok: true,
      changed: true,
    });
    await humanRegistry.tools
      .find((tool) => tool.name === 'neondeck_owner_pr_respond')
      ?.run({ input: { body: 'The held commit is pushed.' } } as never);
    const responseKeys = postPrComment.mock.calls.map(
      ([input]) => input.idempotencyKey,
    );
    expect(responseKeys).toHaveLength(2);
    expect(responseKeys[0]).toMatch(/human-turn:/);
    expect(responseKeys[1]).toMatch(/human-turn:/);
    expect(responseKeys[1]).not.toBe(responseKeys[0]);
    expect(pushInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'neondeck',
        worktreeId: worktree.id,
        prNumber: 123,
      }),
      paths,
    );
    expect(await gitOutput(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
      preparedSha,
    );

    await recordWorktreePushSucceeded(
      worktree.id,
      { commitSha: preparedSha, message: 'Simulated completed push.' },
      paths,
    );
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'waiting',
      to: 'working',
    });
    await recoverInterruptedAutopilotOwners(paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });
    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });
  });

  it('fails closed with no configured checks and cleans only an eligible managed worktree at terminal state', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-push-when-safe',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(repositorySeed?.featureSha ?? undefined),
    );
    const created = await createWorktree(
      { repoId: 'neondeck', prNumber: 123, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'safe-owner',
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'safe-event');
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 4;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'fix: safe candidate']);

    await expect(
      safePushAutopilotOwner(
        {
          id: 'pandemicsyn/neondeck#123',
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 123,
          worktreeId: worktree.id,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['configuredChecks'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });

    await controlPrAutopilot(
      { id: 'pandemicsyn/neondeck#123', operation: 'retry' },
      paths,
    );
    const retryPrepare = vi.fn();
    const retryDispatch = vi.fn(async () => ({
      dispatchId: 'safe-retry-dispatch',
      acceptedAt: '2026-07-20T00:00:00.000Z',
    }));
    await expect(
      runAutopilotWatchEvent(ownerEvent('safe-event'), paths, {
        prepare: retryPrepare as never,
        dispatch: retryDispatch as never,
      }),
    ).resolves.toMatchObject({
      state: 'dispatched',
      instanceId: 'safe-owner',
      worktreeId: worktree.id,
    });
    expect(retryPrepare).not.toHaveBeenCalled();
    await settleAutopilotOwnerObservation(ownerEnd('safe-owner'), paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });

    await git(worktree.localPath, [
      'reset',
      '--hard',
      repositorySeed!.featureSha!,
    ]);
    const record = await readManagedWorktree(worktree.id, 'neondeck', paths);
    expect(record.adopted).toBe(false);
    await completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
      explicitStop: true,
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'complete',
    });
    expect(readWorktreeRecord(worktree.id, paths).lifecycleStatus).toBe(
      'prepared-diff',
    );

    await configurePrAutopilot(
      {
        ref: 'neondeck#124',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(repositorySeed?.featureSha ?? undefined, 124),
    );
    const terminalCreated = await createWorktree(
      { repoId: 'neondeck', prNumber: 124, headRef: 'feature' },
      paths,
    );
    const terminalWorktree = worktreeFrom(terminalCreated);
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#124', {
      ownerInstanceId: 'terminal-owner',
      worktreeId: terminalWorktree.id,
    });
    const terminalDependencies = fixtureDependencies(
      repositorySeed?.featureSha ?? undefined,
      124,
    );
    await refreshPrWatch(
      { id: 'pandemicsyn/neondeck#124' },
      paths,
      async () => ({
        ...(await terminalDependencies.fetcher()),
        state: 'closed',
      }),
      terminalDependencies.checkFetcher,
    );
    await completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#124', paths);
    expect(readWorktreeRecord(terminalWorktree.id, paths).lifecycleStatus).toBe(
      'deleted',
    );

    await configurePrAutopilot(
      {
        ref: 'neondeck#126',
        mode: 'autofix-push-when-safe',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(repositorySeed?.featureSha ?? undefined, 126),
    );
    const safeCreated = await createWorktree(
      { repoId: 'neondeck', prNumber: 126, headRef: 'feature' },
      paths,
    );
    const safeWorktree = worktreeFrom(safeCreated);
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#126', {
      ownerInstanceId: 'successful-safe-owner',
      worktreeId: safeWorktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#126',
      'safe-success-event',
    );
    await writeFile(
      join(safeWorktree.localPath, 'src/app.ts'),
      'export const value = 126;\n',
    );
    await git(safeWorktree.localPath, ['add', '-A']);
    await git(safeWorktree.localPath, [
      'commit',
      '-m',
      'fix: safe verified change',
    ]);
    const runExecution = vi.fn(async (_input: { command: string }) => ({
      ok: true,
      action: 'execution_run',
      changed: false,
      message: 'check passed',
    }));
    const pushGit = vi.fn(async () => ({
      remote: 'origin',
      branch: 'feature',
      force: false,
      stdout: 'pushed',
    }));
    await expect(
      safePushAutopilotOwner(
        {
          id: 'pandemicsyn/neondeck#126',
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 126,
          worktreeId: safeWorktree.id,
        },
        paths,
        {
          token: 'test-token',
          configuredChecks: vi.fn(async () => ({
            repo: {} as never,
            checks: ['npm test -- first', 'npm test -- second'],
          })) as never,
          runExecution: runExecution as never,
          fetchFacts: vi.fn(async () =>
            prEventFacts(repositorySeed!.featureSha!, 126),
          ) as never,
          fetchLogin: vi.fn(async () => 'pandemicsyn'),
          checkPolicy: vi.fn(async () => ({
            blocked: false,
            approvalRequired: false,
            canPush: false,
            requires: [],
          })) as never,
          resolvePushTarget: vi.fn(async () => ({
            remote: 'origin',
            branch: 'feature',
          })) as never,
          pushGit: pushGit as never,
        },
      ),
    ).resolves.toMatchObject({ ok: true, checks: expect.any(Array) });
    expect(runExecution.mock.calls.map(([input]) => input.command)).toEqual([
      'npm test -- first',
      'npm test -- second',
    ]);
    expect(pushGit).toHaveBeenCalledTimes(1);
    expect(readWorktreeRecord(safeWorktree.id, paths)).toMatchObject({
      lifecycleStatus: 'succeeded',
      lastPushedSha: await gitOutput(safeWorktree.localPath, [
        'rev-parse',
        'HEAD',
      ]),
    });
    await settleAutopilotOwnerObservation(
      ownerPromptFailure('successful-safe-owner'),
      paths,
    );
    expect(readWatch(paths, 'pandemicsyn/neondeck#126')).toMatchObject({
      autopilotStatus: 'blocked',
    });
  });
});

async function fixturePaths(repoPath = '/src/neondeck') {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-loop-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  await writeFile(
    paths.repos,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: repoPath,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
  return paths;
}

function fixtureDependencies(headSha = 'a'.repeat(40), number = 123) {
  return {
    async fetcher() {
      return {
        number,
        title: 'Minimal Autopilot loop',
        repo: 'pandemicsyn/neondeck',
        url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        headSha,
        baseRef: 'main',
        updatedAt: '2026-07-20T00:00:00.000Z',
      };
    },
    async checkFetcher() {
      return {
        status: 'none' as const,
        total: 0,
        successful: 0,
        failed: 0,
        pending: 0,
        checkedAt: '2026-07-20T00:00:00.000Z',
      };
    },
    initialEventBaselineFetcher: emptyPrWatchInitialEventBaseline,
  };
}

async function gitFixturePaths() {
  if (!repositorySeed) throw new Error('Git seed unavailable.');
  const repoRoot = await mkdtemp(join(tmpdir(), 'neondeck-loop-repo-'));
  const repo = join(repoRoot, 'repository');
  const remote = join(repoRoot, 'remote.git');
  tempRoots.push(repoRoot);
  await repositorySeed.copyTo(repo);
  await execFileAsync('git', ['clone', '--bare', repo, remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  const paths = await fixturePaths(repo);
  return { paths, repo, remote };
}

function worktreeFrom(result: unknown) {
  expect(result).toMatchObject({ ok: true, worktree: expect.any(Object) });
  return (result as { worktree: { id: string; localPath: string } }).worktree;
}

function ownerEvent(eventFingerprint: string) {
  return {
    watchId: 'pandemicsyn/neondeck#123',
    eventFingerprint,
    reasoningRequired: true,
    changedCategories: ['review_threads'],
    deltas: [{ type: 'review-comment', actionable: true }],
    currentFacts: { headSha: repositorySeed?.featureSha ?? '' },
  };
}

function ownerEnd(instanceId: string) {
  return {
    v: 3,
    type: 'agent_end',
    eventIndex: 1,
    timestamp: '2026-07-20T00:00:00.000Z',
    agentName: 'pr-autopilot-owner',
    instanceId,
    messages: [],
  } as FlueObservation & { type: 'agent_end' };
}

function ownerPromptFailure(instanceId: string) {
  return {
    v: 3,
    type: 'operation',
    eventIndex: 2,
    timestamp: '2026-07-20T00:00:01.000Z',
    agentName: 'pr-autopilot-owner',
    instanceId,
    dispatchId: 'safe-dispatch',
    operationId: 'safe-prompt',
    operationKind: 'prompt',
    durationMs: 1_000,
    isError: true,
    error: new Error('provider disconnected after push'),
  } as FlueObservation & { type: 'operation' };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
  });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function prEventFacts(headSha: string, number: number) {
  return {
    repo: 'pandemicsyn/neondeck',
    number,
    url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
    title: 'Safe Autopilot',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha,
    headRef: 'feature',
    headOwner: 'pandemicsyn',
    headName: 'neondeck',
    headRepoFullName: 'pandemicsyn/neondeck',
    baseRef: 'main',
    baseSha: repositorySeed?.baseSha ?? null,
    baseRepoFullName: 'pandemicsyn/neondeck',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: {
      latestByReviewer: [],
      history: [],
      active: [],
    },
    conversationComments: [],
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-20T00:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}
