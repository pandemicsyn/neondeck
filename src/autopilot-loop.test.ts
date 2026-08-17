import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { init, type FlueObservation } from '@flue/runtime';
import { start } from '@flue/runtime/node';
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
  approvePrAutopilotChange,
  completeAutopilotWatchIfTerminal,
  configurePrAutopilot,
  controlPrAutopilot,
  dispatchAutopilotOwnerTurn,
  messagePrAutopilotOwner,
  recoverInterruptedAutopilotOwners,
  runAutopilotWatchEvent,
  settleAutopilotOwnerObservation,
} from './modules/autopilot';
import { reviewRevisionKey } from '../shared/review-source';
import { safePushAutopilotOwner } from './modules/autopilot/owner/safe-push';
import { recordOwnerOutcomeQuietly } from './modules/autopilot/owner/settlement-learning';
import { buildAutopilotOwnerToolRegistry } from './modules/autopilot/owner/tools';
import { postGitHubPrComment } from './modules/pr-events';
import { pushInteractiveRepo, readRepoDiff } from './repo-edit';
import { gitCurrentSha, gitPushHead, gitStatus } from './repo-edit/git';
import {
  bindWatchAutopilotOwner,
  addPrWatch,
  claimWatchAutopilotTurn,
  configureWatchAutopilot,
  removePrWatch,
  readWatch,
  refreshPrWatch,
  setPrWatchPolling,
  transitionWatchAutopilot,
  upsertWatchPollingTask,
} from './modules/watches';
import { readScheduledTask } from './modules/scheduled-tasks';
import {
  createWorktree,
  readManagedWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readWorktreeRecord,
} from './modules/worktrees';
import {
  buildPrAutopilotOwnerRuntime,
  PrAutopilotOwner,
} from './agents/pr-autopilot-owner';
import {
  clearPendingAutopilotTurn,
  claimPendingAutopilotTurnSettlement,
  readPendingAutopilotTurn,
  recordPendingAutopilotTurnCorrelationId,
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
import {
  autopilotOwnerInitialData,
  buildAutopilotOwnerEnvelope,
} from './modules/autopilot/owner/envelope';
import { openDb } from './lib/sqlite';

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
  it('keeps immutable owner creation data limited to the stable watch identity', () => {
    const envelope = buildAutopilotOwnerEnvelope({
      watchId: 'pandemicsyn/neondeck#123',
      repoId: 'canonical-repo-id',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      eventFingerprint: 'event-1',
      mode: 'prepare-only',
      facts: {},
      availableCapabilities: [],
    });

    expect(autopilotOwnerInitialData(envelope)).toEqual({
      schema: 'neondeck.autopilot-owner-instance.v2',
      watchId: envelope.watchId,
    });
  });

  it('ignores late owner context updates from a superseded turn', async () => {
    const paths = await fixturePaths();
    const instanceId = 'superseded-context-owner';
    const oldTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'old-event',
      'prepare-only',
      'watch-event',
    );
    const newTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'new-event',
      'autofix-with-approval',
      'direct-human',
    );

    expect(
      recordPendingAutopilotTurnLearningMemoryContext(
        paths.home,
        instanceId,
        oldTurn.turnId,
        ['stale-memory'],
        'Stale context.',
        true,
      ),
    ).toBeNull();
    expect(
      recordPendingAutopilotTurnCorrelationId(
        paths.home,
        instanceId,
        oldTurn.turnId,
        'stale-dispatch',
      ),
    ).toBeNull();
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toEqual(newTurn);
    expect(newTurn).toMatchObject({
      learningMemoryAvailable: false,
      learningMemoryIds: [],
      learningMemoryLoaded: false,
      learningMemoryText: null,
      turnId: newTurn.turnId,
    });
  });

  it('scopes HTTP delivery idempotency keys to one owner instance', async () => {
    const paths = await fixturePaths();
    const first = registerPendingAutopilotTurn(
      paths.home,
      'keyed-owner-a',
      undefined,
      'autofix-with-approval',
      'direct-human',
      undefined,
      {
        idempotencyKey: 'client-key-1',
        messageBody: 'approved, push',
        watchId: 'watch-a',
      },
    );
    clearPendingAutopilotTurn(paths.home, 'keyed-owner-a');
    const retry = registerPendingAutopilotTurn(
      paths.home,
      'keyed-owner-a',
      undefined,
      'autofix-with-approval',
      'direct-human',
      undefined,
      {
        idempotencyKey: 'client-key-1',
        messageBody: 'approved, push',
        watchId: 'watch-a',
      },
    );
    const otherOwner = registerPendingAutopilotTurn(
      paths.home,
      'keyed-owner-b',
      undefined,
      'autofix-with-approval',
      'direct-human',
      undefined,
      {
        idempotencyKey: 'client-key-1',
        messageBody: 'approved, push',
        watchId: 'watch-b',
      },
    );

    expect(retry).toMatchObject({
      idempotencyKey: 'client-key-1',
      status: 'settled',
      turnId: first.turnId,
    });
    expect(otherOwner.turnId).not.toBe(first.turnId);
  });

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
    registerCorrelatedPendingAutopilotTurn(
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
    clearPendingAutopilotTurn(paths.home, instanceId);
    registerCorrelatedPendingAutopilotTurn(
      paths.home,
      instanceId,
      'prompt-event-next',
      'prepare-only',
      'watch-event',
    );
    const second = await buildPrAutopilotOwnerRuntime(instanceId, paths);
    expect(second.instructions).toBe('SECOND prepare-only for the same owner');
  });

  it('replays a crash-before-receipt reservation with one stable Flue idempotency key', async () => {
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
    const instanceId = 'reserved-recovery-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'reserved-event',
    );
    const envelope = buildAutopilotOwnerEnvelope({
      watchId: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      worktreeId: worktree.id,
      worktreePath: worktree.localPath,
      headSha: repositorySeed?.featureSha ?? 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      eventFingerprint: 'reserved-event',
      mode: 'prepare-only',
      facts: {},
      availableCapabilities: ['workspace', 'commit'],
    });
    const reserved = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      envelope.eventFingerprint,
      'prepare-only',
      'watch-event',
      undefined,
      { envelope, watchId: envelope.watchId },
    );
    const dispatchTurn = vi.fn<
      (input: unknown) => Promise<{
        submissionId: string;
        acceptedAt: string;
        uid: string;
      }>
    >(async () => {
      expect(
        readPendingAutopilotTurn(paths.home, instanceId)?.prepared,
      ).toEqual(
        expect.objectContaining({
          schema: 'neondeck.autopilot-owner-prepared.v2',
        }),
      );
      return {
        submissionId: 'recovered-reservation-submission',
        acceptedAt: new Date().toISOString(),
        uid: 'owner-uid',
      };
    });
    const neverSettles = vi.fn<() => Promise<{ failed: false }>>(
      () => new Promise<{ failed: false }>(() => undefined),
    );

    await expect(
      recoverInterruptedAutopilotOwners(paths, {
        dispatchTurn: dispatchTurn as never,
        prepareTurn: vi.fn<() => Promise<never>>(async () => {
          throw new Error('transient preparation failure');
        }),
        readSettlement: neverSettles,
      }),
    ).resolves.toBe(0);
    expect(dispatchTurn).not.toHaveBeenCalled();
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toMatchObject({
      error: 'transient preparation failure',
      status: 'reserved',
      turnId: reserved.turnId,
    });

    const recoveredCount = await recoverInterruptedAutopilotOwners(paths, {
      dispatchTurn: dispatchTurn as never,
      readSettlement: neverSettles,
    });
    expect(
      readPendingAutopilotTurn(paths.home, instanceId)?.error,
    ).toBeUndefined();
    expect(recoveredCount).toBe(1);
    expect(dispatchTurn).toHaveBeenCalledWith({
      instanceId,
      envelope,
      idempotencyKey: reserved.turnId,
    });
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toMatchObject({
      correlationId: 'recovered-reservation-submission',
      status: 'admitted',
      turnId: reserved.turnId,
    });

    await recoverInterruptedAutopilotOwners(paths, {
      dispatchTurn: dispatchTurn as never,
      readSettlement: neverSettles,
    });
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('mounts recovered pre-Explore owner authority before the first turn and changes capabilities only at the next turn', async () => {
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
    const instanceId = 'mounted-recovery-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'mounted-recovery-event',
    );
    const firstEnvelope = buildAutopilotOwnerEnvelope({
      watchId: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      worktreeId: worktree.id,
      worktreePath: worktree.localPath,
      headSha: repositorySeed?.featureSha ?? 'a'.repeat(40),
      baseSha: repositorySeed?.baseSha ?? 'b'.repeat(40),
      eventFingerprint: 'mounted-recovery-event',
      mode: 'prepare-only',
      facts: { feedback: ['Confirm the mounted lifecycle boundary.'] },
      availableCapabilities: ['workspace', 'commit'],
    });
    const firstTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      firstEnvelope.eventFingerprint,
      'prepare-only',
      'watch-event',
      undefined,
      { envelope: firstEnvelope, watchId: firstEnvelope.watchId },
    );
    vi.stubEnv('NEONDECK_HOME', paths.home);
    vi.stubEnv('FLUE_AGENT_MODEL', 'faux/faux-1');
    await buildPrAutopilotOwnerRuntime(instanceId, paths);
    const currentPrepared = readPendingAutopilotTurn(
      paths.home,
      instanceId,
    )?.prepared;
    if (
      !currentPrepared ||
      currentPrepared.schema !== 'neondeck.autopilot-owner-prepared.v2'
    ) {
      throw new Error('Expected the current prepared owner context.');
    }
    const {
      exploreModel: _exploreModel,
      exploreThinkingLevel: _exploreThinkingLevel,
      ...preparedWithoutExplore
    } = currentPrepared;
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          'UPDATE autopilot_owner_turns SET prepared_json = ? WHERE turn_id = ?;',
        )
        .run(
          JSON.stringify({
            ...preparedWithoutExplore,
            schema: 'neondeck.autopilot-owner-prepared.v1',
          }),
          firstTurn.turnId,
        );
    } finally {
      database.close();
    }
    const modelContexts: string[] = [];
    const modelToolCatalogs: string[][] = [];
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        modelContexts.push(JSON.stringify(context));
        modelToolCatalogs.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage('No repository mutation looks necessary.');
      },
      (context) => {
        modelContexts.push(JSON.stringify(context));
        modelToolCatalogs.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage(
          'I inspected the bounded turn and no repository mutation is appropriate.',
        );
      },
      (context) => {
        modelContexts.push(JSON.stringify(context));
        modelToolCatalogs.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage('Notification-only turn acknowledged.');
      },
    ]);
    const flue = await start({
      agents: [PrAutopilotOwner],
      providers: [faux.provider],
    });
    const handle = init(PrAutopilotOwner, { id: instanceId });
    const neverSettles = () => new Promise<{ failed: false }>(() => undefined);
    try {
      await expect(
        recoverInterruptedAutopilotOwners(paths, {
          readSettlement: neverSettles,
        }),
      ).resolves.toBe(1);
      const recovered = readPendingAutopilotTurn(paths.home, instanceId);
      expect(recovered).toMatchObject({
        turnId: firstTurn.turnId,
        status: 'admitted',
        prepared: {
          schema: 'neondeck.autopilot-owner-prepared.v1',
          capabilities: ['workspace', 'commit'],
          workspaceContext: { path: worktree.localPath },
        },
      });
      await expect(
        handle.read(recovered!.correlationId!),
      ).resolves.toBeDefined();
      expect(modelContexts).toHaveLength(2);
      expect(modelToolCatalogs[0]).toContain('neondeck_owner_commit');
      expect(modelContexts[0]).toContain(worktree.localPath);
      expect(modelContexts[1]).toContain(
        'neondeck.autopilot.completion-required',
      );

      clearPendingAutopilotTurn(paths.home, instanceId);
      transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
        from: 'working',
        to: 'watching',
      });
      configureWatchAutopilot(paths, 'pandemicsyn/neondeck#123', 'notify-only');
      claimWatchAutopilotTurn(
        paths,
        'pandemicsyn/neondeck#123',
        'mounted-notify-event',
      );
      const secondEnvelope = buildAutopilotOwnerEnvelope({
        ...firstEnvelope,
        eventFingerprint: 'mounted-notify-event',
        mode: 'notify-only',
        availableCapabilities: [],
      });
      const secondTurn = registerPendingAutopilotTurn(
        paths.home,
        instanceId,
        secondEnvelope.eventFingerprint,
        'notify-only',
        'watch-event',
        undefined,
        { envelope: secondEnvelope, watchId: secondEnvelope.watchId },
      );
      await buildPrAutopilotOwnerRuntime(instanceId, paths);
      const receipt = await dispatchAutopilotOwnerTurn({
        instanceId,
        envelope: secondEnvelope,
        idempotencyKey: secondTurn.turnId,
      });
      recordPendingAutopilotTurnCorrelationId(
        paths.home,
        instanceId,
        secondTurn.turnId,
        receipt.submissionId,
      );
      await expect(handle.read(receipt)).resolves.toBeDefined();
      expect(modelContexts).toHaveLength(3);
      expect(modelToolCatalogs[2]).not.toContain('neondeck_owner_commit');
      expect(readPendingAutopilotTurn(paths.home, instanceId)).toMatchObject({
        prepared: { capabilities: [], workspaceContext: null },
      });
    } finally {
      await flue.stop();
    }
  });

  it('reclaims an interrupted app-side settlement from the canonical Flue submission', async () => {
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
    const instanceId = 'settlement-recovery-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'settlement-recovery-event',
    );
    const turn = registerCorrelatedPendingAutopilotTurn(
      paths.home,
      instanceId,
      'settlement-recovery-event',
      'prepare-only',
      'watch-event',
      'settlement-recovery-submission',
    );
    expect(
      claimPendingAutopilotTurnSettlement(paths.home, instanceId),
    ).toMatchObject({ turnId: turn.turnId, status: 'settling' });

    await recoverInterruptedAutopilotOwners(paths, {
      readSettlement: vi.fn(async () => ({ failed: false as const })),
    });
    await vi.waitFor(() => {
      expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
        autopilotStatus: 'watching',
      });
    });
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toBeUndefined();
  });

  it('attaches a terminal submission that races ahead of receipt persistence', async () => {
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
    const instanceId = 'receipt-race-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#123',
      'receipt-race-event',
    );
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'receipt-race-event',
      'prepare-only',
      'watch-event',
      undefined,
      { watchId: 'pandemicsyn/neondeck#123' },
    );

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, 'receipt-race-submission'),
      paths,
    );

    expect(readPendingAutopilotTurn(paths.home, instanceId)).toBeUndefined();
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
    });
  });

  it('does not attach a delayed duplicate settlement to a newer owner turn', async () => {
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
    const instanceId = 'delayed-settlement-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'old-event');
    registerCorrelatedPendingAutopilotTurn(
      paths.home,
      instanceId,
      'old-event',
      'prepare-only',
      'watch-event',
      'old-submission',
    );
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, 'old-submission'),
      paths,
    );
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'new-event');
    const newer = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'new-event',
      'prepare-only',
      'watch-event',
      undefined,
      { watchId: 'pandemicsyn/neondeck#123' },
    );

    await expect(
      settleAutopilotOwnerObservation(
        ownerPromptSuccess(instanceId, 'old-submission'),
        paths,
      ),
    ).resolves.toBeNull();
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toMatchObject({
      correlationId: undefined,
      turnId: newer.turnId,
    });
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
    registerCorrelatedPendingAutopilotTurn(
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
      'Current fetched facts and operation bounds win on conflict.',
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
    registerCorrelatedPendingAutopilotTurn(
      paths.home,
      instanceId,
      'learning-event',
      'prepare-only',
      'watch-event',
    );
    const invokePrBatchReview = vi.fn(async (_input: PrBatchReviewInput) => ({
      ok: true as const,
      reviewId: 'learning-review',
      agentId: 'learning-review:learning-review',
      submissionId: 'learning-review-run',
      activityUrl: '/activity?submissionId=learning-review-run',
    }));

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
      'autopilot-owner:pandemicsyn/neondeck#123:safe-dispatch',
    );
    expect(invokePrBatchReview).toHaveBeenCalledTimes(1);
    expect(invokePrBatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'threshold' }),
    );
  });

  it('deduplicates recovery reclassification by owner-turn identity', async () => {
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
    const watch = readWatch(paths, 'pandemicsyn/neondeck#123');
    if (!watch) throw new Error('Expected configured Autopilot watch.');
    const context = {
      correlationKind: 'dispatch',
      learningMemoryIds: [],
      memorySnapshotAvailable: false,
      memorySnapshotReason: 'recovery-test',
      mode: 'prepare-only' as const,
      source: 'watch-event',
      turnId: 'dispatch-one',
    };

    await recordOwnerOutcomeQuietly(
      watch,
      context,
      {
        eventType: 'autopilot-owner-prepared',
        outcome: 'prepared',
        commitSha: 'commit-one',
        summary: 'Prepared before restart.',
      },
      paths,
      {},
    );
    await recordOwnerOutcomeQuietly(
      watch,
      context,
      {
        eventType: 'autopilot-owner-escalated',
        outcome: 'escalated',
        commitSha: 'commit-one',
        summary: 'Reclassified during recovery.',
      },
      paths,
      {},
    );

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: 'autopilot-owner:pandemicsyn/neondeck#123:dispatch-one',
      data: expect.objectContaining({
        eventType: 'autopilot-owner-prepared',
      }),
    });
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
    const pendingTurn = registerCorrelatedPendingAutopilotTurn(
      paths.home,
      instanceId,
      'unavailable-memory-event',
      'prepare-only',
      'watch-event',
    );
    recordPendingAutopilotTurnLearningMemoryContext(
      paths.home,
      instanceId,
      pendingTurn.turnId,
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

  it('keeps the old owner turn claimed until settlement evidence is durable', async () => {
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
    registerCorrelatedPendingAutopilotTurn(
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
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')?.autopilotStatus).toBe(
      'working',
    );
    expect(
      claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'new-event'),
    ).toBeUndefined();
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
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')?.autopilotStatus).toBe(
      'watching',
    );
  });

  it('ignores a delayed terminal observation from the previous dispatch', async () => {
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
    const instanceId = 'delayed-terminal-owner';
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'old-event');
    const oldTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'old-event',
      'prepare-only',
      'watch-event',
    );
    recordPendingAutopilotTurnCorrelationId(
      paths.home,
      instanceId,
      oldTurn.turnId,
      'dispatch-old',
    );
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, 'dispatch-old'),
      paths,
    );

    claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'new-event');
    const newTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      'new-event',
      'prepare-only',
      'watch-event',
    );
    recordPendingAutopilotTurnCorrelationId(
      paths.home,
      instanceId,
      newTurn.turnId,
      'dispatch-new',
    );

    await expect(
      settleAutopilotOwnerObservation(
        ownerPromptFailure(instanceId, 'dispatch-old'),
        paths,
      ),
    ).resolves.toBeNull();
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')?.autopilotStatus).toBe(
      'working',
    );
    expect(readPendingAutopilotTurn(paths.home, instanceId)?.turnId).toBe(
      newTurn.turnId,
    );

    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, 'dispatch-new'),
      paths,
    );
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')?.autopilotStatus).toBe(
      'watching',
    );
    expect(readPendingAutopilotTurn(paths.home, instanceId)).toBeUndefined();
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
    registerCorrelatedPendingAutopilotTurn(
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
          correlationKind: 'submission',
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
    registerCorrelatedPendingAutopilotTurn(
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
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeUndefined();
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
      ok: true,
      changed: false,
      watch: { autopilotMode: 'autofix-with-approval' },
    });
    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: true,
          desiredTerminalState: 'merged',
          intervalSeconds: 60,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: {
        autopilotMode: 'prepare-only',
        processExisting: true,
        desiredTerminalState: 'merged',
      },
    });
    const beforeRejectedIncrease = readWatch(paths, 'pandemicsyn/neondeck#123');
    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'autofix-push-when-safe',
          processExisting: false,
          desiredTerminalState: 'checks',
          intervalSeconds: 120,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirmAutopilotMode'],
      watch: { autopilotMode: 'prepare-only' },
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toEqual(
      beforeRejectedIncrease,
    );

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#124',
          mode: 'notify-only',
          processExisting: false,
        },
        paths,
        fixtureDependencies(undefined, 124),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotMode: 'notify-only' },
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

  it('requires fresh confirmation to rearm completed non-notify authority and fences stale mode writes', async () => {
    const paths = await fixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-push-when-safe',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(),
    );
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'complete',
    });

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'autofix-push-when-safe',
          processExisting: false,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirmAutopilotMode'],
    });
    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirmAutopilotMode'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotMode: 'autofix-push-when-safe',
      autopilotStatus: 'complete',
    });

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
          confirm: true,
        },
        paths,
        fixtureDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      watch: {
        autopilotMode: 'prepare-only',
        autopilotStatus: 'watching',
      },
    });

    const fence = readWatch(paths, 'pandemicsyn/neondeck#123')!;
    configureWatchAutopilot(
      paths,
      'pandemicsyn/neondeck#123',
      'autofix-with-approval',
    );
    expect(
      configureWatchAutopilot(
        paths,
        'pandemicsyn/neondeck#123',
        'notify-only',
        { expected: fence },
      ),
    ).toMatchObject({
      matched: false,
      changed: false,
      watch: { autopilotMode: 'autofix-with-approval' },
    });
  });

  it('rejects a concurrent completion before addPrWatch can rearm without confirmation', async () => {
    const paths = await fixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-push-when-safe',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(),
    );
    const dependencies = fixtureDependencies();

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
        },
        paths,
        {
          ...dependencies,
          addWatch: async (...args: Parameters<typeof addPrWatch>) => {
            transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
              from: 'watching',
              to: 'complete',
            });
            return addPrWatch(...args);
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchState'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotMode: 'autofix-push-when-safe',
      autopilotStatus: 'complete',
    });
  });

  it('repairs disabled polling when a completed-watch rearm is retried after task upsert fails', async () => {
    const paths = await fixturePaths();
    const dependencies = fixtureDependencies();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'complete',
    });
    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );
    const failedUpsert = vi.fn(async () => {
      throw new Error('polling upsert unavailable');
    });

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
          confirm: true,
        },
        paths,
        { ...dependencies, upsertPollingTask: failedUpsert },
      ),
    ).rejects.toThrow('polling upsert unavailable');
    expect(failedUpsert).toHaveBeenCalledOnce();
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotMode: 'prepare-only',
      autopilotStatus: 'watching',
    });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: false });

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
        },
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotStatus: 'watching' },
    });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: true });
  });

  it('preserves an intentional polling pause across idempotent configuration', async () => {
    const paths = await fixturePaths();
    const dependencies = fixtureDependencies();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );
    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
        },
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({ ok: true, changed: false });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('preserves a manual pause that wins after a completed-watch rearm commit', async () => {
    const paths = await fixturePaths();
    const dependencies = fixtureDependencies();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'complete',
    });
    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
          confirm: true,
        },
        paths,
        {
          ...dependencies,
          upsertPollingTask: async (watch, callPaths, intervalSeconds) => {
            await setPrWatchPolling(
              { id: watch.id, enabled: false },
              callPaths,
            );
            return upsertWatchPollingTask(watch, callPaths, intervalSeconds);
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('cannot recreate polling when removal wins an in-flight configuration', async () => {
    const paths = await fixturePaths();
    const dependencies = fixtureDependencies();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: true,
        },
        paths,
        {
          ...dependencies,
          upsertPollingTask: async (watch, callPaths, intervalSeconds) => {
            await removePrWatch({ id: watch.id, confirm: true }, callPaths);
            return upsertWatchPollingTask(watch, callPaths, intervalSeconds);
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchState'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeUndefined();
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toBeUndefined();
  });

  it('cannot re-enable polling when stop wins an in-flight configuration', async () => {
    const paths = await fixturePaths();
    const dependencies = fixtureDependencies();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: true,
        },
        paths,
        {
          ...dependencies,
          upsertPollingTask: async (watch, callPaths, intervalSeconds) => {
            await completeAutopilotWatchIfTerminal(watch.id, callPaths, {
              explicitStop: true,
            });
            return upsertWatchPollingTask(watch, callPaths, intervalSeconds);
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchState'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'complete',
    });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('atomically applies a completed-watch downgrade before polling observes the rearm', async () => {
    const paths = await fixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-push-when-safe',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(),
    );
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'complete',
    });
    const dependencies = fixtureDependencies();
    let concurrentPollState: string | undefined;

    await expect(
      configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'notify-only',
          processExisting: true,
        },
        paths,
        {
          ...dependencies,
          addWatch: async (...args: Parameters<typeof addPrWatch>) => {
            const result = await addPrWatch(...args);
            expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
              autopilotMode: 'notify-only',
              autopilotStatus: 'watching',
              ownerInstanceId: null,
              worktreeId: null,
            });
            concurrentPollState = (
              await runAutopilotWatchEvent(
                ownerEvent('concurrent-downgrade-poll'),
                paths,
              )
            ).state;
            return result;
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      watch: {
        autopilotMode: 'notify-only',
        autopilotStatus: 'watching',
      },
    });
    expect(concurrentPollState).toBe('notified');
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

  it('returns detached worktree recovery details from the public stop control', async () => {
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
    const current = readWatch(paths, 'pandemicsyn/neondeck#123')!;
    const cleanupRecovery =
      'Managed worktree retained-worktree was retained and detached for manual recovery.';
    const complete = vi.fn(async () => ({
      complete: true as const,
      reason: 'terminal' as const,
      watch: {
        ...current,
        autopilotStatus: 'complete' as const,
        worktreeId: null,
      },
      cleanup: {
        ok: true,
        action: 'worktree_cleanup',
        changed: false,
        message: 'retained',
        results: [
          {
            worktreeId: 'retained-worktree',
            outcome: 'failed',
            reason: 'worktree is dirty',
          },
        ],
      },
      detachedWorktreeId: 'retained-worktree',
      cleanupRecovery,
    }));

    await expect(
      controlPrAutopilot({ id: current.id, operation: 'stop' }, paths, {
        complete: complete as never,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'autopilot_watch_stop',
      changed: true,
      message: expect.stringContaining(cleanupRecovery),
      detachedWorktreeId: 'retained-worktree',
      cleanupRecovery,
    });
    expect(complete).toHaveBeenCalledWith(current.id, paths, {
      explicitStop: true,
    });
  });

  it('refuses stop before transition or cleanup when enabled polling cannot be disabled', async () => {
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
    const cleanup = vi.fn();
    const failedSetPolling = vi.fn(async () => {
      throw new Error('polling storage unavailable');
    });
    const setPolling = vi.fn(async () => ({
      ok: true,
      action: 'watch_pr_pause',
      changed: true,
      message: 'Reported disabled without persisting the change.',
    }));

    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
        cleanup: cleanup as never,
        setPolling: failedSetPolling as never,
      }),
    ).resolves.toMatchObject({
      complete: false,
      reason: 'polling-disable-failed',
      error: 'polling storage unavailable',
      watch: { autopilotStatus: 'watching' },
    });
    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
        cleanup: cleanup as never,
        setPolling: setPolling as never,
      }),
    ).resolves.toMatchObject({
      complete: false,
      reason: 'polling-disable-failed',
      error: expect.stringContaining('remained enabled'),
      watch: { autopilotStatus: 'watching' },
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
    });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: true });

    const current = readWatch(paths, 'pandemicsyn/neondeck#123')!;
    await expect(
      controlPrAutopilot({ id: current.id, operation: 'stop' }, paths, {
        complete: vi.fn(async () => ({
          complete: false as const,
          reason: 'polling-disable-failed' as const,
          watch: current,
          error: 'polling storage unavailable',
        })) as never,
      }),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['retryStop'],
      message: expect.stringContaining('No worktree cleanup was attempted'),
    });
  });

  it('keeps polling disabled and rejects concurrent configuration throughout stop cleanup', async () => {
    const { paths } = await gitFixturePaths();
    const dependencies = fixtureDependencies(
      repositorySeed?.featureSha ?? undefined,
    );
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      dependencies,
    );
    const created = await createWorktree(
      { repoId: 'neondeck', prNumber: 123, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'stopping-owner',
      worktreeId: worktree.id,
    });
    let concurrentConfiguration: Awaited<
      ReturnType<typeof configurePrAutopilot>
    > | null = null;
    const cleanup = vi.fn(async () => {
      concurrentConfiguration = await configurePrAutopilot(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: false,
        },
        paths,
        dependencies,
      );
      await expect(
        readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
      ).resolves.toMatchObject({ enabled: false });
      await expect(
        setPrWatchPolling(
          { id: 'pandemicsyn/neondeck#123', enabled: true },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        requires: ['retryStop'],
      });
      return {
        ok: true,
        action: 'worktree_cleanup',
        changed: true,
        message: 'deleted',
        results: [{ worktreeId: worktree.id, outcome: 'deleted' }],
      };
    });

    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
        cleanup: cleanup as never,
      }),
    ).resolves.toMatchObject({
      complete: true,
      watch: { autopilotStatus: 'complete' },
    });
    expect(concurrentConfiguration).toMatchObject({
      ok: false,
      requires: ['retryStop'],
      watch: { autopilotStatus: 'stopping' },
    });
    await expect(
      readScheduledTask('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('requires explicit prepared-diff discard confirmation before stop cleanup', async () => {
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
    const worktree = worktreeFrom(
      await createWorktree(
        { repoId: 'neondeck', prNumber: 123, headRef: 'feature' },
        paths,
      ),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'prepared-stop-owner',
      worktreeId: worktree.id,
    });
    await recordWorktreePushBlocked(
      worktree.id,
      { message: 'Held unpushed commit is ready for review.' },
      paths,
    );

    await expect(
      controlPrAutopilot(
        { id: 'pandemicsyn/neondeck#123', operation: 'stop' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirmPreparedDiff'],
      watch: { autopilotStatus: 'watching', worktreeId: worktree.id },
    });
    expect(readWorktreeRecord(worktree.id, paths).lifecycleStatus).toBe(
      'prepared-diff',
    );

    await expect(
      controlPrAutopilot(
        {
          id: 'pandemicsyn/neondeck#123',
          operation: 'stop',
          confirmPreparedDiff: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotStatus: 'complete' },
    });
    expect(readWorktreeRecord(worktree.id, paths).lifecycleStatus).toBe(
      'deleted',
    );
  });

  it('requires discard confirmation for a crash-window commit before lifecycle settlement', async () => {
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
    const worktree = worktreeFrom(
      await createWorktree(
        { repoId: 'neondeck', prNumber: 123, headRef: 'feature' },
        paths,
      ),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'crash-window-stop-owner',
      worktreeId: worktree.id,
    });
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 99;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'fix: crash window']);
    const committedSha = await gitCurrentSha(worktree.localPath);

    expect(readWorktreeRecord(worktree.id, paths)).toMatchObject({
      lifecycleStatus: 'ready',
      lastPushedSha: null,
    });
    await expect(gitStatus(worktree.localPath)).resolves.toMatchObject({
      clean: true,
    });
    expect(committedSha).not.toBe(
      readWorktreeRecord(worktree.id, paths).headSha,
    );

    await expect(
      controlPrAutopilot(
        { id: 'pandemicsyn/neondeck#123', operation: 'stop' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirmPreparedDiff'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
      worktreeId: worktree.id,
    });
    expect(await gitCurrentSha(worktree.localPath)).toBe(committedSha);

    await expect(
      controlPrAutopilot(
        {
          id: 'pandemicsyn/neondeck#123',
          operation: 'stop',
          confirmPreparedDiff: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotStatus: 'complete' },
    });
    expect(readWorktreeRecord(worktree.id, paths).lifecycleStatus).toBe(
      'deleted',
    );
  });

  it('defers known pre-admission failures and preserves ambiguous dispatch reservations', async () => {
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
      state: 'deferred',
      changed: false,
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'working',
    });
    const pending = readPendingAutopilotTurn(
      paths.home,
      readWatch(paths, 'pandemicsyn/neondeck#123')!.ownerInstanceId!,
    )!;
    expect(pending).toMatchObject({
      eventFingerprint: 'permanent-dispatch-error',
      status: 'reserved',
    });
    const recoveredDispatch = vi.fn(async () => ({
      submissionId: 'ambiguous-retry-submission',
      acceptedAt: new Date().toISOString(),
      uid: 'owner-uid',
    }));
    await recoverInterruptedAutopilotOwners(paths, {
      dispatchTurn: recoveredDispatch as never,
      readSettlement: () => new Promise(() => undefined),
    });
    expect(recoveredDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: pending.turnId }),
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
    let dispatchCount = 0;
    const dispatch = vi.fn(async () => ({
      submissionId: `dispatch-${++dispatchCount}`,
      acceptedAt: '2026-07-20T00:00:00.000Z',
      uid: 'owner-session',
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
    if (!('dispatchId' in first)) {
      throw new Error('Expected the first owner turn to be dispatched.');
    }
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess(instanceId, first.dispatchId),
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
    if (!('dispatchId' in second)) {
      throw new Error('Expected the second owner turn to be dispatched.');
    }
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
      ownerPromptSuccess(instanceId, second.dispatchId),
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
      submissionId: 'human-dispatch',
      acceptedAt: '2026-07-20T00:00:00.000Z',
      uid: 'owner-session',
    }));
    let remoteHeadSha = repositorySeed!.featureSha!;
    let moveRemoteBeforeCommentAuthorization = false;
    let postedPrCommentCount = 0;
    const postPrComment = vi.fn<typeof postGitHubPrComment>(
      async (input, _commentPaths, dependencies = {}) => {
        if (moveRemoteBeforeCommentAuthorization) {
          remoteHeadSha = 'b'.repeat(40);
        }
        const authorizationFailure = await dependencies.authorizeComment?.();
        if (authorizationFailure) return authorizationFailure;
        postedPrCommentCount += 1;
        return {
          ok: true,
          action: 'github_pr_comment',
          changed: true,
          message: 'Posted owner response.',
          data: { idempotencyKey: input.idempotencyKey ?? null },
        };
      },
    );
    await expect(
      messagePrAutopilotOwner(
        {
          id: 'pandemicsyn/neondeck#123',
          message: 'make one more focused edit before I review',
        },
        paths,
        humanDispatch as never,
      ),
    ).resolves.toMatchObject({ ok: true, dispatchId: 'human-dispatch' });
    expect(humanDispatch).toHaveBeenCalledWith({
      agent: 'pr-autopilot-owner',
      id: instanceId,
      input: 'make one more focused edit before I review',
      idempotencyKey: expect.any(String),
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
    expect(firstHumanRegistry.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_push',
    );
    expect(firstHumanRegistry.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_pr_respond',
    );
    await firstHumanRegistry.tools
      .find((tool) => tool.name === 'neondeck_owner_pr_respond')
      ?.run(durableToolContext({ body: 'I am checking one more edit.' }));
    await settleAutopilotOwnerObservation(
      ownerPromptFailure(instanceId, 'human-dispatch'),
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
    await expect(
      approvePrAutopilotChange(
        {
          id: 'pandemicsyn/neondeck#123',
          expectedRevisionKey: 'worktree-diff:stale:revision',
        },
        paths,
        { dispatchOwner: humanDispatch as never },
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentReviewedDiff'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'waiting',
    });
    const reviewedWorktree = await readManagedWorktree(
      worktree.id,
      'neondeck',
      paths,
    );
    const reviewedDiff = await readRepoDiff(
      {
        repoId: 'neondeck',
        worktreeId: worktree.id,
        base: reviewedWorktree.headSha ?? undefined,
        includePatch: false,
      },
      paths,
    );
    const reviewedRevisionKey = reviewRevisionKey(reviewedDiff.revision!);
    expect(reviewedRevisionKey).toBeTruthy();
    await expect(
      approvePrAutopilotChange(
        {
          id: 'pandemicsyn/neondeck#123',
          expectedRevisionKey: reviewedRevisionKey!,
        },
        paths,
        { dispatchOwner: humanDispatch as never },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'autopilot_change_approve',
      dispatchId: 'human-dispatch',
    });
    expect(
      readPendingAutopilotTurn(paths.home, instanceId)?.approvedRevisionKey,
    ).toBe(reviewedRevisionKey);
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
            remoteHeadSha = target.sha;
            return {
              remote: target.remote,
              branch: target.branch,
              force: false,
              stdout: 'pushed to local test remote',
            };
          }),
          authorizePush: ownerDependencies.authorizePush,
          expectedRemoteSha: ownerDependencies.expectedRemoteSha,
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
          expectedRemoteSha: ownerDependencies.expectedRemoteSha,
        }),
    );
    const staleHumanRegistry = buildAutopilotOwnerToolRegistry({
      watch: { ...humanTurnWatch, autopilotStatus: 'waiting' },
      source: 'direct-human',
      paths,
      pushInteractive: stalePushInteractive,
      fetchPrDetail: vi.fn(async () => ({ headSha: remoteHeadSha })) as never,
      githubToken: 'test-token',
      approvedRevisionKey: readPendingAutopilotTurn(paths.home, instanceId)
        ?.approvedRevisionKey,
    });
    await expect(
      toolOutputPromise(
        staleHumanRegistry.tools
          .find((tool) => tool.name === 'neondeck_owner_push')
          ?.run(durableToolContext({})),
      ),
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
    const remoteRacePushEffect = vi.fn();
    const remoteRacePushInteractive = vi.fn<typeof pushInteractiveRepo>(
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
          pushGit: (localPath, target) =>
            gitPushHead(localPath, target, {
              runGit: async () => {
                remoteRacePushEffect();
                return 'unexpected push';
              },
              probePushAccess: async (_cwd, probe) => ({
                credential: {
                  protocol: 'local',
                  provided: true,
                  source: 'local-transport',
                  login: null,
                  repositoryPush: null,
                },
                remote: {
                  remote: probe.remote,
                  ref: probe.ref,
                  sha: repositorySeed!.baseSha!,
                  reachable: true,
                },
              }),
            }),
          authorizePush: ownerDependencies.authorizePush,
          expectedRemoteSha: ownerDependencies.expectedRemoteSha,
        }),
    );
    const remoteRaceRegistry = buildAutopilotOwnerToolRegistry({
      watch: { ...humanTurnWatch, autopilotStatus: 'waiting' },
      source: 'direct-human',
      paths,
      pushInteractive: remoteRacePushInteractive,
      fetchPrDetail: vi.fn(async () => ({
        headSha: repositorySeed!.featureSha!,
      })) as never,
      githubToken: 'test-token',
      approvedRevisionKey: readPendingAutopilotTurn(paths.home, instanceId)
        ?.approvedRevisionKey,
    });
    await expect(
      toolOutputPromise(
        remoteRaceRegistry.tools
          .find((tool) => tool.name === 'neondeck_owner_push')
          ?.run(durableToolContext({})),
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Git push target moved'),
    });
    expect(remoteRacePushEffect).not.toHaveBeenCalled();
    const humanRegistry = buildAutopilotOwnerToolRegistry({
      watch: { ...humanTurnWatch, autopilotStatus: 'waiting' },
      source: 'direct-human',
      paths,
      postPrComment: postPrComment as never,
      pushInteractive: pushInteractive as never,
      fetchPrDetail: vi.fn(async () => ({ headSha: remoteHeadSha })) as never,
      githubToken: 'test-token',
      approvedRevisionKey: readPendingAutopilotTurn(paths.home, instanceId)
        ?.approvedRevisionKey,
    });
    const humanPush = humanRegistry.tools.find(
      (tool) => tool.name === 'neondeck_owner_push',
    );
    const humanResponse = humanRegistry.tools.find(
      (tool) => tool.name === 'neondeck_owner_pr_respond',
    );
    await expect(
      toolOutputPromise(
        humanResponse?.run(
          durableToolContext({ body: 'This must not post before push.' }),
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentApprovedPushedRevision'],
    });
    expect(postPrComment).not.toHaveBeenCalled();
    await git(worktree.localPath, [
      'push',
      'origin',
      `${preparedSha}:refs/heads/feature`,
    ]);
    remoteHeadSha = preparedSha;
    const humanPushResult = toolOutput(
      await humanPush?.run(durableToolContext({})),
    );
    expect(humanPushResult).toMatchObject({
      ok: true,
      changed: false,
      commitSha: preparedSha,
      recovered: true,
    });
    expect(pushInteractive).not.toHaveBeenCalled();
    expect(readWorktreeRecord(worktree.id, paths)).toMatchObject({
      lastPushedSha: preparedSha,
      lifecycleStatus: 'succeeded',
    });
    moveRemoteBeforeCommentAuthorization = true;
    await expect(
      toolOutputPromise(
        humanResponse?.run(
          durableToolContext({
            body: 'This must not post after the PR head moves.',
          }),
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentApprovedPushedRevision'],
    });
    expect(postedPrCommentCount).toBe(0);
    moveRemoteBeforeCommentAuthorization = false;
    remoteHeadSha = preparedSha;
    await expect(
      toolOutputPromise(
        humanResponse?.run(
          durableToolContext({ body: 'The held commit is pushed.' }),
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
    const responseKeys = postPrComment.mock.calls.map(
      ([input]) => input.idempotencyKey,
    );
    expect(responseKeys).toHaveLength(2);
    expect(responseKeys[0]).toMatch(/human-turn:/);
    expect(responseKeys[1]).toBe(responseKeys[0]);
    expect(postedPrCommentCount).toBe(1);
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 4;\n',
    );
    await expect(
      toolOutputPromise(
        humanResponse?.run(
          durableToolContext({ body: 'This stale diff must not post.' }),
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentApprovedPushedRevision'],
    });
    expect(postPrComment).toHaveBeenCalledTimes(2);
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 3;\n',
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
    await recoverInterruptedAutopilotOwners(paths, {
      readSettlement: vi.fn(async () => ({ failed: false as const })),
    });
    await vi.waitFor(() => {
      expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
        autopilotStatus: 'watching',
      });
    });
    await settleAutopilotOwnerObservation(ownerEnd(instanceId), paths);
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
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
      if (!runtime.sandbox) {
        throw new Error(`${mode} did not receive its coding sandbox.`);
      }
      const environment = await runtime.sandbox.createSandbox({
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
    const firstSafeTurn = registerCorrelatedPendingAutopilotTurn(
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
      submissionId: 'safe-retry-dispatch',
      acceptedAt: '2026-07-20T00:00:00.000Z',
      uid: 'owner-session',
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
    expect(readPendingAutopilotTurn(paths.home, 'safe-owner')?.turnId).not.toBe(
      firstSafeTurn.turnId,
    );
    await settleAutopilotOwnerObservation(
      ownerPromptSuccess('safe-owner', 'safe-retry-dispatch'),
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
    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
        confirmPreparedDiff: true,
      }),
    ).resolves.toMatchObject({
      complete: true,
      detachedWorktreeId: null,
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'complete',
    });
    expect(readWorktreeRecord(worktree.id, paths).lifecycleStatus).toBe(
      'deleted',
    );
    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({ ok: true, outcome: 'removed' });

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
    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#124', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'removed',
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#124')).toBeUndefined();

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
    registerCorrelatedPendingAutopilotTurn(
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
    const autonomousPushedSha = readWorktreeRecord(
      safeWorktree.id,
      paths,
    ).lastPushedSha!;
    let autonomousRemoteHeadSha = autonomousPushedSha;
    let changeModeBeforeAutonomousCommentAuthorization = true;
    let moveRemoteBeforeAutonomousCommentAuthorization = false;
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
            if (changeModeBeforeAutonomousCommentAuthorization) {
              configureWatchAutopilot(
                paths,
                'pandemicsyn/neondeck#126',
                'prepare-only',
              );
            }
            if (moveRemoteBeforeAutonomousCommentAuthorization) {
              autonomousRemoteHeadSha = 'b'.repeat(40);
            }
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
      fetchPrDetail: vi.fn(async () => ({
        headSha: autonomousRemoteHeadSha,
      })) as never,
      githubToken: 'test-token',
    });
    await expect(
      toolOutputPromise(
        autonomousRegistry.tools
          .find((tool) => tool.name === 'neondeck_owner_pr_respond')
          ?.run(durableToolContext({ body: 'Implemented and validated.' })),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentSafeMode'],
    });
    expect(autonomousPostPrComment).toHaveBeenCalledTimes(1);
    expect(autonomousCommentPosted).toBe(false);
    configureWatchAutopilot(
      paths,
      'pandemicsyn/neondeck#126',
      'autofix-push-when-safe',
    );
    autonomousRemoteHeadSha = autonomousPushedSha;
    changeModeBeforeAutonomousCommentAuthorization = false;
    moveRemoteBeforeAutonomousCommentAuthorization = true;
    await expect(
      toolOutputPromise(
        autonomousRegistry.tools
          .find((tool) => tool.name === 'neondeck_owner_pr_respond')
          ?.run(
            durableToolContext({
              body: 'This response must not post after the PR head moves.',
            }),
          ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentSafeMode'],
    });
    expect(autonomousPostPrComment).toHaveBeenCalledTimes(2);
    expect(autonomousCommentPosted).toBe(false);
    await settleAutopilotOwnerObservation(
      ownerPromptFailure('successful-safe-owner'),
      paths,
    );
    expect(readWatch(paths, 'pandemicsyn/neondeck#126')).toMatchObject({
      autopilotStatus: 'blocked',
    });
  });

  it('detaches recoverable non-adopted cleanup artifacts while preserving adopted retention', async () => {
    const paths = await fixturePaths();
    const cleanup = vi.fn(async () => ({
      ok: true,
      action: 'worktree_cleanup',
      changed: false,
      message: 'retained',
      results: [
        {
          worktreeId: 'retained-worktree',
          outcome: 'failed',
          reason: 'worktree is dirty',
        },
      ],
    }));
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
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'retained-owner',
      worktreeId: 'retained-worktree',
    });

    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#123', paths, {
        explicitStop: true,
        confirmPreparedDiff: true,
        cleanup: cleanup as never,
        readWorktree: (() => ({
          id: 'retained-worktree',
          adopted: false,
          createdBy: 'neondeck',
          lifecycleStatus: 'prepared-diff',
        })) as never,
      }),
    ).resolves.toMatchObject({
      complete: true,
      detachedWorktreeId: 'retained-worktree',
      watch: { autopilotStatus: 'complete', worktreeId: null },
      cleanupRecovery: expect.stringContaining('manual recovery'),
    });
    expect(await listNotifications(paths)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'Autopilot watch stopped',
          message: expect.stringContaining('manual recovery'),
        }),
      ]),
    );
    expect(cleanup).toHaveBeenCalledWith(
      {
        worktreeId: 'retained-worktree',
        force: true,
        confirmPreparedDiff: true,
      },
      paths,
    );
    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({ ok: true, outcome: 'removed' });

    await configurePrAutopilot(
      {
        ref: 'neondeck#124',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(undefined, 124),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#124', {
      ownerInstanceId: 'missing-owner',
      worktreeId: 'missing-worktree',
    });
    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#124', paths, {
        explicitStop: true,
        readWorktree: (() => {
          throw new Error('missing record');
        }) as never,
      }),
    ).resolves.toMatchObject({
      complete: true,
      detachedWorktreeId: 'missing-worktree',
      watch: { worktreeId: null },
    });

    await configurePrAutopilot(
      {
        ref: 'neondeck#125',
        mode: 'prepare-only',
        processExisting: false,
        confirm: true,
      },
      paths,
      fixtureDependencies(undefined, 125),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#125', {
      ownerInstanceId: 'adopted-owner',
      worktreeId: 'adopted-worktree',
    });
    await expect(
      completeAutopilotWatchIfTerminal('pandemicsyn/neondeck#125', paths, {
        explicitStop: true,
        cleanup: cleanup as never,
        readWorktree: (() => ({
          id: 'adopted-worktree',
          adopted: true,
          createdBy: 'user',
        })) as never,
      }),
    ).resolves.toMatchObject({
      complete: true,
      detachedWorktreeId: null,
      watch: { worktreeId: 'adopted-worktree' },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
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

    const recovered = await setupCandidate(129, 'recovered-push-owner');
    const recoveredCommit = await gitOutput(recovered.candidate.localPath, [
      'rev-parse',
      'HEAD',
    ]);
    await expect(
      safePushAutopilotOwner(
        {
          id: recovered.watchId,
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 129,
          worktreeId: recovered.candidate.id,
        },
        paths,
        {
          token: 'test-token',
          fetchFacts: vi.fn(async () =>
            prEventFacts(recoveredCommit, 129),
          ) as never,
          pushGit: pushGit as never,
        },
      ),
    ).resolves.toMatchObject({ ok: true, changed: false, recovered: true });
    expect(pushGit).not.toHaveBeenCalled();
    expect(readWorktreeRecord(recovered.candidate.id, paths)).toMatchObject({
      lastPushedSha: recoveredCommit,
      lifecycleStatus: 'succeeded',
    });

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

function registerCorrelatedPendingAutopilotTurn(
  home: string,
  instanceId: string,
  eventFingerprint: string | undefined,
  mode: Parameters<typeof registerPendingAutopilotTurn>[3],
  source: Parameters<typeof registerPendingAutopilotTurn>[4],
  correlationId = 'safe-dispatch',
) {
  const pending = registerPendingAutopilotTurn(
    home,
    instanceId,
    eventFingerprint,
    mode,
    source,
  );
  recordPendingAutopilotTurnCorrelationId(
    home,
    instanceId,
    pending.turnId,
    correlationId,
  );
  return pending;
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

function toolOutput<T>(
  envelope: { output?: T } | string | void | undefined,
): T {
  expect(envelope).toEqual(
    expect.objectContaining({ output: expect.anything() }),
  );
  return (envelope as { output: T }).output;
}

async function toolOutputPromise(value: unknown) {
  return toolOutput((await value) as never);
}

function durableToolContext<T>(data: T) {
  return {
    data,
    step: {
      do: async (_name: string, run: () => unknown) => run(),
    },
  } as never;
}

function ownerPromptSuccess(instanceId: string, dispatchId = 'safe-dispatch') {
  return {
    v: 3,
    type: 'submission_settled',
    eventIndex: 3,
    timestamp: '2026-07-20T00:00:01.000Z',
    agentName: 'pr-autopilot-owner',
    instanceId,
    submissionId: dispatchId,
    outcome: 'completed',
  } as FlueObservation & { type: 'submission_settled' };
}

function ownerPromptFailure(instanceId: string, dispatchId = 'safe-dispatch') {
  return {
    v: 3,
    type: 'submission_settled',
    eventIndex: 3,
    timestamp: '2026-07-20T00:00:01.000Z',
    agentName: 'pr-autopilot-owner',
    instanceId,
    submissionId: dispatchId,
    outcome: 'failed',
    error: {
      type: 'provider_error',
      name: 'Error',
      message: 'provider disconnected after push',
    },
  } as FlueObservation & { type: 'submission_settled' };
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
