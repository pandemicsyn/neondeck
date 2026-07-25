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
import { postGitHubPrComment } from './modules/pr-events';
import { pushInteractiveRepo } from './repo-edit';
import {
  bindWatchAutopilotOwner,
  claimWatchAutopilotTurn,
  configureWatchAutopilot,
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
import { buildPrAutopilotOwnerRuntime } from './agents/pr-autopilot-owner';
import {
  clearPendingAutopilotTurn,
  readPendingAutopilotTurn,
  recordPendingAutopilotTurnLearningMemoryContext,
  registerPendingAutopilotTurn,
} from './modules/autopilot/owner/pending';
import { updateAutopilotPrompt, updateLearningConfig } from './modules/config';
import { addNotification, listNotifications } from './modules/app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { listMemories, upsertMemory } from './modules/memory';
import { listHandledPrEventsForReview } from './modules/learning/reviews/pr-context';
import type { PrBatchReviewInput } from './modules/learning';
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
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('minimal Autopilot watch loop', () => {
  it('applies prompt edits to an existing owner on its next turn', async () => {
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
    const instanceId = 'editable-prompt-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: '',
    });
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'prompt-event',
      'prepare-only',
      'watch-event',
    );

    await updateAutopilotPrompt(
      {
        mode: 'prepare-only',
        prompt: 'FIRST {{mode}} / {{source}} / {{status}}',
      },
      paths,
    );
    const first = await buildPrAutopilotOwnerRuntime(instanceId, paths);
    expect(first.instructions).toBe(
      'FIRST prepare-only / watch-event / watching',
    );

    await updateAutopilotPrompt(
      {
        mode: 'prepare-only',
        prompt: 'SECOND {{mode}} for the same owner',
      },
      paths,
    );
    const second = await buildPrAutopilotOwnerRuntime(instanceId, paths);
    expect(second.instructions).toBe('SECOND prepare-only for the same owner');
  });

  it('loads bounded repo-first learning memory as read-only owner background context', async () => {
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
    const instanceId = 'memory-context-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: '',
    });
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'memory-event',
      'prepare-only',
      'watch-event',
    );
    const project = await upsertMemory(
      {
        scope: 'project',
        repoId: 'neondeck',
        key: 'project-check',
        value: 'Run the project-specific verification.',
      },
      paths,
    );
    const local = await upsertMemory(
      {
        scope: 'local',
        key: 'local-tool',
        value: 'Use the locally configured tool.',
      },
      paths,
    );
    const user = await upsertMemory(
      {
        scope: 'user',
        key: 'review-style',
        value: 'Keep the final summary concise.',
      },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        repoId: 'other-repo',
        key: 'unrelated',
        value: 'Do not load this memory.',
      },
      paths,
    );

    const runtime = await buildPrAutopilotOwnerRuntime(instanceId, paths);
    const projectIndex = runtime.instructions.indexOf(
      'Run the project-specific verification.',
    );
    const localIndex = runtime.instructions.indexOf(
      'Use the locally configured tool.',
    );
    const userIndex = runtime.instructions.indexOf(
      'Keep the final summary concise.',
    );
    const expectedMemoryIds = [project, local, user].map(
      (result) => (result as { memory: { id: string } }).memory.id,
    );

    expect(projectIndex).toBeGreaterThan(-1);
    expect(projectIndex).toBeLessThan(localIndex);
    expect(localIndex).toBeLessThan(userIndex);
    expect(runtime.instructions).toContain(
      'Current fetched facts and workflow bounds win on conflict.',
    );
    expect(runtime.instructions).toContain(
      'cannot grant capabilities or expand this turn',
    );
    expect(runtime.instructions).not.toContain('Do not load this memory.');
    expect(runtime.actions).toEqual([]);
    expect(
      readPendingAutopilotTurn(paths.home, instanceId)?.learningMemoryIds,
    ).toEqual(expectedMemoryIds);
    expect(
      readPendingAutopilotTurn(paths.home, instanceId)?.learningMemoryAvailable,
    ).toBe(true);
    const memories = await listMemories({}, paths);
    expect(
      memories.memories
        .filter((memory) => expectedMemoryIds.includes(memory.id))
        .every((memory) => memory.useCount === 1),
    ).toBe(true);
  });

  it('records one idempotent clean settlement and queues the existing PR learning cadence', async () => {
    const { paths } = await gitFixturePaths();
    await updateLearningConfig({ prRetrospectiveThreshold: 1 }, paths);
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'learning-settlement-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'learning-event',
    );
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'learning-event',
      'prepare-only',
      'watch-event',
    );
    const invokePrBatchReview = vi.fn<
      (input: PrBatchReviewInput) => Promise<{ runId: string }>
    >(async () => ({ runId: 'learning-review-run' }));

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
      {
        invokePrBatchReview,
      },
    );
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
      {
        invokePrBatchReview,
      },
    );

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'pr-autopilot-owner',
      repoId: 'neondeck',
      prKey: 'pandemicsyn/neondeck#123',
      data: expect.objectContaining({
        eventType: 'autopilot-owner-no-change',
        data: expect.objectContaining({
          watchId: 'pandemicsyn/neondeck#123',
          turnFingerprint: 'safe-dispatch',
          outcome: 'no-change',
        }),
      }),
    });
    expect(events[0]?.sourceId).toContain(
      'autopilot-owner:pandemicsyn/neondeck#123:safe-dispatch:no-change:',
    );
    expect(invokePrBatchReview).toHaveBeenCalledTimes(1);
    expect(invokePrBatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'threshold' }),
    );
  });

  it('preserves unavailable owner memory context in settlement audit evidence', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'unavailable-memory-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'unavailable-memory-event',
    );
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'unavailable-memory-event',
      'prepare-only',
      'watch-event',
    );
    recordPendingAutopilotTurnLearningMemoryContext(
      paths.home,
      instanceId,
      [],
      'Learning memories background context: unavailable for this workflow run.',
      false,
    );
    const recordHandledPr = vi.fn(async () => ({ recorded: true }));

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
      {
        recordHandledPr: recordHandledPr as never,
      },
    );

    expect(recordHandledPr).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memorySnapshot: {
            available: false,
            ids: [],
            reason: 'owner-runtime-memory-context-was-unavailable',
          },
        }),
      }),
      paths,
      {},
    );
  });

  it('does not clear a newly registered owner turn after deferred settlement learning', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'settlement-race-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'old-event');
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'old-event',
      'prepare-only',
      'watch-event',
    );
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settlement = settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
      {
        recordHandledPr: vi.fn(async () => {
          recording.resolve();
          await release.promise;
          return { recorded: true };
        }) as never,
      },
    );
    await recording.promise;
    const next = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'new-event',
      'prepare-only',
      'watch-event',
    );

    release.resolve();
    await settlement;

    expect(readPendingAutopilotTurn(paths.home, instanceId)?.turnId).toBe(
      next.turnId,
    );
  });

  it('reconstructs restarted settlement identity and reloads memory without claiming recovered ids', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'restarted-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'restart-event');
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'restart-event',
      'prepare-only',
      'watch-event',
    );
    await upsertMemory(
      {
        scope: 'project',
        repoId: 'neondeck',
        key: 'restart-guidance',
        value: 'Reload this bounded project guidance after restart.',
      },
      paths,
    );
    clearPendingAutopilotTurn(paths.home, instanceId);

    const runtime = await buildPrAutopilotOwnerRuntime(instanceId, paths);
    expect(runtime.instructions).toContain(
      'Reload this bounded project guidance after restart.',
    );
    const recoveredObservation = {
      v: 3,
      type: 'submission_settled',
      eventIndex: 9,
      timestamp: '2026-07-25T01:00:00.000Z',
      agentName: 'pr-autopilot-owner',
      instanceId,
      submissionId: 'submission-recovered-123',
      outcome: 'completed',
    } as Extract<FlueObservation, { type: 'submission_settled' }>;

    await settleAutopilotOwnerObservation(recoveredObservation, paths);

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repoId: 'neondeck',
      sourceId: expect.stringContaining('submission-recovered-123'),
      data: expect.objectContaining({
        data: expect.objectContaining({
          turnFingerprint: 'submission-recovered-123',
          correlationKind: 'submission',
          memoryIds: [],
          memorySnapshot: {
            available: false,
            ids: [],
            reason:
              'process-restarted-before-owner-memory-audit-correlation-could-be-recovered',
          },
        }),
      }),
    });
  });

  it('records recovered dispatched owner outcomes from the prompt operation', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'recovered-dispatch-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'recovered-dispatch-event',
    );
    clearPendingAutopilotTurn(paths.home, instanceId);
    await recoverInterruptedAutopilotOwners(paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, 'recovered-dispatch-123'),
      paths,
    );

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: expect.stringContaining('recovered-dispatch-123'),
      data: expect.objectContaining({
        data: expect.objectContaining({
          correlationKind: 'dispatch',
          memorySnapshot: expect.objectContaining({ available: false }),
        }),
      }),
    });
  });

  it('does not let agent end preempt an authoritative failed prompt operation', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'failed-prompt-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'failed-prompt-event',
    );
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'failed-prompt-event',
      'prepare-only',
      'watch-event',
    );

    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'working',
    });
    expect(readPendingAutopilotTurn(paths.home, instanceId)).not.toBeNull();

    await settleAutopilotOwnerObservation(
      ownerPromptFailure(instanceId),
      paths,
    );
    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'pr-autopilot-owner',
      data: expect.objectContaining({
        eventType: 'autopilot-owner-failed',
        data: expect.objectContaining({ outcome: 'failed' }),
      }),
    });
  });

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

  it('defers owner dispatch while the local runtime starts without blocking the watch', async () => {
    const { paths } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const prepare = async () => ({
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
    });
    const unavailable = Object.assign(
      new Error('The local runtime is temporarily unavailable.'),
      { type: 'runtime_unavailable' },
    );

    await expect(
      runAutopilotWatchEvent(ownerEvent('runtime-starting'), paths, {
        prepare: prepare as never,
        dispatch: (async () => {
          throw unavailable;
        }) as never,
      }),
    ).resolves.toMatchObject({
      state: 'deferred',
      changed: false,
      message: expect.stringContaining('retry'),
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
      worktreeId: worktree.id,
    });
    expect(await listNotifications(paths)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Autopilot owner turn blocked' }),
      ]),
    );

    await expect(
      runAutopilotWatchEvent(ownerEvent('permanent-dispatch-error'), paths, {
        prepare: prepare as never,
        dispatch: (async () => {
          throw new Error('The owner agent is misconfigured.');
        }) as never,
      }),
    ).resolves.toMatchObject({
      state: 'blocked',
      changed: false,
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'blocked',
    });
    expect(await listNotifications(paths)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Autopilot owner turn blocked',
          message: expect.stringContaining('misconfigured'),
        }),
      ]),
    );
  });

  it('rearms a legacy runtime-startup block and resolves its stale notification', async () => {
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
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'blocked',
    });
    await addNotification(
      {
        level: 'attention',
        title: 'Autopilot owner turn blocked',
        message:
          'Autopilot could not start the owner turn: The local runtime is temporarily unavailable.',
        source: 'autopilot-owner',
        sourceId: 'pandemicsyn/neondeck#123:dispatch-blocked',
        data: { watchId: 'pandemicsyn/neondeck#123' },
      },
      paths,
    );

    await expect(recoverInterruptedAutopilotOwners(paths)).resolves.toBe(0);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
    });
    expect(await listNotifications(paths)).toEqual([]);
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
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
    );

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
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId),
      paths,
    );
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
    const pushInteractive = vi.fn<typeof pushInteractiveRepo>(
      async (input, _ownerPaths, ownerDependencies = {}) =>
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
          authorizePush: ownerDependencies.authorizePush,
        }),
    );
    const humanTurnWatch = readWatch(paths, 'pandemicsyn/neondeck#123')!;
    const stalePushEffect = vi.fn<() => void>();
    const stalePushInteractive = vi.fn<typeof pushInteractiveRepo>(
      async (input, _ownerPaths, ownerDependencies = {}) =>
        pushInteractiveRepo(input, paths, {
          resolveContext: vi.fn(async () => {
            configureWatchAutopilot(
              paths,
              'pandemicsyn/neondeck#123',
              'prepare-only',
            );
            return {
              repo: {
                id: 'neondeck',
                github: { owner: 'pandemicsyn', name: 'neondeck' },
                path: repo,
                defaultBranch: 'main',
              },
              prNumber: 123,
              worktree: await readManagedWorktree(
                worktree.id,
                'neondeck',
                paths,
              ),
              pushRemote: 'origin',
              pushBranch: 'feature',
              linkedPrHead: true,
            };
          }) as never,
          pushGit: vi.fn(async () => {
            stalePushEffect();
            return {
              remote: 'origin',
              branch: 'feature',
              force: false,
              stdout: 'unexpected push',
            };
          }),
          authorizePush: ownerDependencies.authorizePush,
        }),
    );
    const staleHumanRegistry = buildAutopilotOwnerToolRegistry({
      watch: { ...humanTurnWatch, autopilotStatus: 'waiting' },
      source: 'direct-human',
      paths,
      pushInteractive: stalePushInteractive,
    });
    await expect(
      staleHumanRegistry.tools
        .find((tool) => tool.name === 'neondeck_owner_push')
        ?.run({ input: {} } as never),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentAuthority'],
    });
    expect(stalePushEffect).not.toHaveBeenCalled();
    configureWatchAutopilot(
      paths,
      'pandemicsyn/neondeck#123',
      'autofix-with-approval',
    );
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
      expect.objectContaining({ authorizePush: expect.any(Function) }),
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

  it('roots every fixing mode in the managed worktree with ordinary Node and non-Node commands', async () => {
    const { paths, repo } = await gitFixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
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
    const instanceId = 'workspace-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'workspace-event',
    );
    vi.stubEnv('GITHUB_TOKEN', 'must-not-enter-owner-shell');
    let autonomousInstructions = '';

    for (const mode of [
      'prepare-only',
      'autofix-with-approval',
      'autofix-push-when-safe',
    ] as const) {
      configureWatchAutopilot(paths, 'pandemicsyn/neondeck#123', mode);
      registerPendingAutopilotTurn(
        paths.home,
        instanceId,
        `event-${mode}`,
        mode,
        'watch-event',
      );
      const runtime = await buildPrAutopilotOwnerRuntime(instanceId, paths);
      expect(runtime.cwd).toBe(worktree.localPath);
      expect(runtime.instructions).toContain(
        'Configured checks in the turn facts are useful hints, never an exhaustive command allowlist or a delivery prerequisite.',
      );
      if (mode === 'autofix-push-when-safe') {
        autonomousInstructions = runtime.instructions;
      }
      if (!('sandbox' in runtime)) {
        throw new Error(`${mode} did not receive its coding sandbox.`);
      }
      const environment = await runtime.sandbox.createSessionEnv({
        id: instanceId,
      });
      expect((await environment.exec('pwd')).stdout.trim()).toBe(
        worktree.localPath,
      );
      expect(
        (await environment.exec('git rev-parse --show-toplevel')).stdout.trim(),
      ).toBe(worktree.localPath);
      expect(
        (
          await environment.exec(
            `node -e "require('node:fs').writeFileSync('node-${mode}.txt', 'node')"`,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await environment.exec(
            `/bin/sh -c "printf non-node > shell-${mode}.txt"`,
          )
        ).exitCode,
      ).toBe(0);
      const secret = await environment.exec(
        'printf %s "${GITHUB_TOKEN-unavailable}"',
      );
      expect(secret.stdout).toBe('unavailable');
      const credentialHome = await environment.exec(
        'printf "%s|%s" "$HOME" "$GH_CONFIG_DIR"',
      );
      const [home, ghConfig] = credentialHome.stdout.split('|');
      expect(home?.startsWith(join(paths.data, 'autopilot-owner-homes'))).toBe(
        true,
      );
      expect(home).not.toBe(process.env.HOME);
      expect(ghConfig).toBe(join(home!, '.config', 'gh'));
      const deliveryBoundary = await environment.exec(
        'printf "%s|%s|%s" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_SSH_COMMAND"',
      );
      expect(deliveryBoundary.stdout).toContain('credential.helper||');
      expect(deliveryBoundary.stdout).toContain('-oPubkeyAuthentication=no');
    }

    expect(autonomousInstructions).toContain(
      'reasonable, relevant, technically sound, appropriately scoped, and sufficiently validated',
    );
    expect(autonomousInstructions).toContain(
      'absurd, ambiguous, scope-exploding',
    );
    expect(autonomousInstructions).toContain(
      'Do not invent a mechanical safety classifier.',
    );
    expect(await gitOutput(repo, ['status', '--porcelain'])).toBe('');
  });

  it('retains semantic escalations and cleans only an eligible managed worktree at terminal state', async () => {
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
    registerPendingAutopilotTurn(
      paths.home,
      'safe-owner',
      'safe-event',
      'autofix-push-when-safe',
      'watch-event',
    );
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 4;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'fix: safe candidate']);

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess('safe-owner'),
      paths,
    );
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
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess('safe-owner'),
      paths,
    );
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
    registerPendingAutopilotTurn(
      paths.home,
      'successful-safe-owner',
      'safe-success-event',
      'autofix-push-when-safe',
      'watch-event',
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
          fetchFacts: vi.fn(async () =>
            prEventFacts(repositorySeed!.featureSha!, 126),
          ) as never,
          fetchLogin: vi.fn(async () => 'pandemicsyn'),
          resolvePushTarget: vi.fn(async () => ({
            remote: 'origin',
            branch: 'feature',
          })) as never,
          pushGit: pushGit as never,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('mechanical delivery guards'),
    });
    expect(pushGit).toHaveBeenCalledTimes(1);
    expect(readWorktreeRecord(safeWorktree.id, paths)).toMatchObject({
      lifecycleStatus: 'succeeded',
      lastPushedSha: await gitOutput(safeWorktree.localPath, [
        'rev-parse',
        'HEAD',
      ]),
    });
    let autonomousCommentPosted = false;
    const autonomousPostPrComment = vi.fn<typeof postGitHubPrComment>(
      async (input, callPaths, ownerDependencies = {}) =>
        postGitHubPrComment(input, callPaths, {
          token: 'test-token',
          fetchPullRequestEventState: vi.fn(async () =>
            prEventFacts(repositorySeed!.featureSha!, 126),
          ) as never,
          listPullRequestComments: vi.fn(async () => []),
          authorizeComment: () => {
            configureWatchAutopilot(
              paths,
              'pandemicsyn/neondeck#126',
              'prepare-only',
            );
            return ownerDependencies.authorizeComment?.();
          },
          postPullRequestComment: vi.fn(async ({ body }) => {
            autonomousCommentPosted = true;
            return {
              id: 126,
              nodeId: 'comment-node-126',
              url: 'https://github.com/pandemicsyn/neondeck/pull/126#issuecomment-126',
              authorLogin: 'neon',
              body,
              createdAt: '2026-07-20T00:00:00.000Z',
              updatedAt: '2026-07-20T00:00:00.000Z',
            };
          }),
        }),
    );
    const safeWatch = readWatch(paths, 'pandemicsyn/neondeck#126')!;
    const autonomousRegistry = buildAutopilotOwnerToolRegistry({
      watch: safeWatch,
      source: 'watch-event',
      paths,
      postPrComment: autonomousPostPrComment as never,
    });
    await expect(
      autonomousRegistry.tools
        .find((tool) => tool.name === 'neondeck_owner_pr_respond')
        ?.run({ input: { body: 'Implemented and validated.' } } as never),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentSafeMode'],
    });
    expect(autonomousPostPrComment).toHaveBeenCalledTimes(1);
    expect(autonomousCommentPosted).toBe(false);
    await settleAutopilotOwnerObservation(
      ownerPromptFailure('successful-safe-owner'),
      paths,
    );
    expect(readWatch(paths, 'pandemicsyn/neondeck#126')).toMatchObject({
      autopilotStatus: 'blocked',
    });
  });

  it('refuses autonomous delivery when the remote head or current mode changes', async () => {
    const { paths } = await gitFixturePaths();
    const setupCandidate = async (number: number, instanceId: string) => {
      await configurePrAutopilot(
        {
          ref: `neondeck#${number}`,
          mode: 'autofix-push-when-safe',
          processExisting: false,
          confirm: true,
        },
        paths,
        fixtureDependencies(repositorySeed?.featureSha ?? undefined, number),
      );
      const created = await createWorktree(
        { repoId: 'neondeck', prNumber: number, headRef: 'feature' },
        paths,
      );
      const candidate = worktreeFrom(created);
      const watchId = `pandemicsyn/neondeck#${number}`;
      bindWatchAutopilotOwner(paths, watchId, {
        ownerInstanceId: instanceId,
        worktreeId: candidate.id,
      });
      claimWatchAutopilotTurn(paths, watchId, `event-${number}`);
      registerPendingAutopilotTurn(
        paths.home,
        instanceId,
        `event-${number}`,
        'autofix-push-when-safe',
        'watch-event',
      );
      await writeFile(
        join(candidate.localPath, 'src/app.ts'),
        `export const value = ${number};\n`,
      );
      await git(candidate.localPath, ['add', '-A']);
      await git(candidate.localPath, [
        'commit',
        '-m',
        `fix: candidate ${number}`,
      ]);
      return { candidate, watchId };
    };
    const pushGit = vi.fn(async () => ({
      remote: 'origin',
      branch: 'feature',
      force: false,
      stdout: 'pushed',
    }));

    const stale = await setupCandidate(127, 'stale-head-owner');
    await expect(
      safePushAutopilotOwner(
        {
          id: stale.watchId,
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 127,
          worktreeId: stale.candidate.id,
        },
        paths,
        {
          token: 'test-token',
          fetchFacts: vi.fn(async () =>
            prEventFacts('b'.repeat(40), 127),
          ) as never,
          pushGit: pushGit as never,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentPrHead'],
    });

    const changedMode = await setupCandidate(128, 'changed-mode-owner');
    await expect(
      safePushAutopilotOwner(
        {
          id: changedMode.watchId,
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 128,
          worktreeId: changedMode.candidate.id,
        },
        paths,
        {
          token: 'test-token',
          fetchFacts: vi.fn(async () => {
            configureWatchAutopilot(paths, changedMode.watchId, 'prepare-only');
            return prEventFacts(repositorySeed!.featureSha!, 128);
          }) as never,
          fetchLogin: vi.fn(async () => 'pandemicsyn'),
          resolvePushTarget: vi.fn(async () => ({
            remote: 'origin',
            branch: 'feature',
          })) as never,
          pushGit: pushGit as never,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['humanInspection'],
      message: expect.stringContaining(
        'no longer a current autonomous watcher delivery turn',
      ),
    });
    expect(pushGit).not.toHaveBeenCalled();
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

function ownerPromptSuccess(instanceId: string, dispatchId = 'safe-dispatch') {
  return {
    v: 3,
    type: 'operation',
    eventIndex: 2,
    timestamp: '2026-07-20T00:00:01.000Z',
    agentName: 'pr-autopilot-owner',
    instanceId,
    dispatchId,
    operationId: `${dispatchId}:prompt`,
    operationKind: 'prompt',
    durationMs: 1_000,
    isError: false,
    result: { text: 'Completed.' },
  } as FlueObservation & { type: 'operation' };
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
