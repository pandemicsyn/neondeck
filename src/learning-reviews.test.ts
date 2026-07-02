import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAgentModels, updateLearningConfig } from './config-actions';
import {
  completeLearningReviewFromModelOutput,
  listLearningReviews,
  prepareConversationReflection,
  prepareMemoryCurationReview,
  preparePrBatchLearningReview,
  recordConversationTurnAndMaybeQueueLearning,
  recordHandledPrEventAndMaybeQueueLearning,
  recordHandledPrFromWorkflowResult,
  failLearningReview,
  startLearningReview,
} from './learning-reviews';
import { readLearningOperatorState } from './learning-operator';
import {
  listMemories,
  listMemoryCandidates,
  upsertMemory,
} from './memory-actions';
import { createChatSession } from './session-actions';
import {
  applySkillPatchCandidate,
  listSkillPatchCandidates,
  proposeSkillPatch,
  rejectSkillPatchCandidate,
  restoreSkillPatchCandidate,
} from './skill-patches';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('learning review orchestration', () => {
  it('creates review-mode memory candidates from conversation reflection output', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ memoryWriteMode: 'review' }, paths);
    await updateAgentModels(
      {
        selfImprovement: 'openai/gpt-4.1-mini',
        selfImprovementThinkingLevel: 'low',
      },
      paths,
    );
    const session = await createChatSession(
      {
        title: 'Learning test',
        summary: 'The user prefers terse PR summaries.',
        summarySource: 'manual',
      },
      paths,
    );
    const sessionId = (session as { session: { id: string } }).session.id;

    const prepared = await prepareConversationReflection(
      { sessionId, reason: 'unit-test', trigger: 'manual' },
      paths,
    );
    expect(prepared).toMatchObject({
      ok: true,
      kind: 'conversation',
      mode: 'review',
      model: 'openai/gpt-4.1-mini',
      thinkingLevel: 'low',
    });
    if (!prepared.ok) throw new Error(prepared.message);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'User preference is durable.',
          memoryActions: [
            {
              action: 'upsert',
              scope: 'user',
              key: 'summary-style',
              value: 'Prefer terse PR summaries.',
              reason: 'Repeated summary preference in conversation.',
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      candidates: [expect.objectContaining({ action: 'upsert' })],
      applied: [],
    });

    await expect(
      listMemoryCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          action: 'upsert',
          key: 'summary-style',
          reviewId: prepared.reviewId,
        }),
      ],
    });
    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: [],
    });
    expect(listLearningReviews({ kind: 'conversation' }, paths)).toMatchObject({
      reviews: [
        expect.objectContaining({
          id: prepared.reviewId,
          status: 'completed',
          model: 'openai/gpt-4.1-mini',
          thinkingLevel: 'low',
          result: expect.objectContaining({
            candidatesCreated: 1,
            applied: 0,
          }),
        }),
      ],
    });
  });

  it('scopes conversation learning evidence to the session memory context', async () => {
    const paths = runtimePaths(await tempHome());
    const repoA = await upsertMemory(
      {
        scope: 'project',
        key: 'checks',
        repoId: 'repo-a',
        value: 'npm run check',
      },
      paths,
    );
    const repoB = await upsertMemory(
      {
        scope: 'project',
        key: 'checks',
        repoId: 'repo-b',
        value: 'pnpm test',
      },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        key: 'global',
        value: 'Use Node 26.',
      },
      paths,
    );
    const session = await createChatSession(
      {
        title: 'Repo A session',
        linkedRepoId: 'repo-a',
        summary: 'Repo A work.',
        summarySource: 'manual',
      },
      paths,
    );
    const prepared = await prepareConversationReflection(
      {
        sessionId: (session as { session: { id: string } }).session.id,
        trigger: 'manual',
      },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);

    expect(prepared.allowedMemoryIds).toContain(
      (repoA as { memory: { id: string } }).memory.id,
    );
    expect(prepared.allowedMemoryIds).not.toContain(
      (repoB as { memory: { id: string } }).memory.id,
    );
    expect(JSON.stringify(prepared.inputSummary)).not.toContain('pnpm test');
  });

  it('rejects conversation upserts outside the reviewed project scope', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ memoryWriteMode: 'auto' }, paths);
    await upsertMemory(
      {
        scope: 'project',
        key: 'checks',
        repoId: 'repo-a',
        value: 'npm run check',
      },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        key: 'checks',
        repoId: 'repo-b',
        value: 'pnpm test',
      },
      paths,
    );
    const session = await createChatSession(
      {
        title: 'Repo A session',
        linkedRepoId: 'repo-a',
        summary: 'Repo A work.',
        summarySource: 'manual',
      },
      paths,
    );
    const prepared = await prepareConversationReflection(
      {
        sessionId: (session as { session: { id: string } }).session.id,
        trigger: 'manual',
      },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'Repo A has a durable test command.',
          memoryActions: [
            {
              action: 'upsert',
              scope: 'project',
              key: 'learned-check',
              repoId: 'repo-b',
              value: 'pnpm test',
              reason: 'This repo was not in the review snapshot.',
            },
            {
              action: 'upsert',
              scope: 'project',
              key: 'learned-check',
              repoId: 'repo-a',
              value: 'npm run check',
              reason: 'Repo A was the reviewed session scope.',
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      applied: [expect.objectContaining({ action: 'memory_upsert' })],
      skipped: [
        expect.objectContaining({
          action: 'upsert',
          reason: 'memory-not-in-review-snapshot',
        }),
      ],
    });
    await expect(
      listMemories(
        { scope: 'project', repoId: 'repo-b', key: 'learned-check' },
        paths,
      ),
    ).resolves.toMatchObject({ memories: [] });
    await expect(
      listMemories(
        { scope: 'project', repoId: 'repo-a', key: 'learned-check' },
        paths,
      ),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ value: 'npm run check' })],
    });
  });

  it('prepares manual reviews for valid sessions outside the recent state list', async () => {
    const paths = runtimePaths(await tempHome());
    const first = await createChatSession(
      {
        title: 'Old session',
        linkedTaskId: 'task-0',
        summary: 'Older but valid session.',
        summarySource: 'manual',
      },
      paths,
    );
    const firstId = (first as { session: { id: string } }).session.id;
    for (let index = 1; index <= 35; index += 1) {
      await createChatSession(
        {
          title: `Recent session ${index}`,
          linkedTaskId: `task-${index}`,
          activate: true,
        },
        paths,
      );
    }

    await expect(
      prepareConversationReflection({ sessionId: firstId }, paths),
    ).resolves.toMatchObject({
      ok: true,
      kind: 'conversation',
    });
  });

  it('applies auto-mode model curation through memory actions', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryCurationMode: 'auto',
        memoryWriteMode: 'auto',
      },
      paths,
    );
    const created = await upsertMemory(
      { scope: 'local', key: 'stale-tooling', value: 'Use Node 24.' },
      paths,
    );
    const memoryId = (created as { memory: { id: string } }).memory.id;

    const prepared = await prepareMemoryCurationReview(
      { trigger: 'manual', mode: 'auto' },
      paths,
    );
    expect(prepared).toMatchObject({
      ok: true,
      kind: 'curation',
      mode: 'auto',
    });
    if (!prepared.ok) throw new Error(prepared.message);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'Archived stale tooling memory.',
          memoryActions: [
            {
              action: 'archive',
              memoryId,
              reason: 'Superseded by current Node 26 guidance.',
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      applied: [expect.objectContaining({ action: 'memory_archive' })],
    });
    await expect(
      listMemories({ includeArchived: true }, paths),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: memoryId, status: 'archived' })],
    });
  });

  it('bounds model-proposed memory actions before creating candidates', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ memoryWriteMode: 'review' }, paths);
    const session = await createChatSession(
      {
        title: 'Too many proposals',
        summary: 'A compact summary.',
        summarySource: 'manual',
      },
      paths,
    );
    const prepared = await prepareConversationReflection(
      {
        sessionId: (session as { session: { id: string } }).session.id,
        trigger: 'manual',
      },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'Too many actions.',
          memoryActions: Array.from({ length: 13 }, (_value, index) => ({
            action: 'upsert' as const,
            scope: 'local' as const,
            key: `item-${index}`,
            value: 'bounded',
          })),
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'learning_review_conversation',
      changed: false,
    });
    await expect(
      listMemoryCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [],
    });
    expect(
      listLearningReviews({ kind: 'conversation' }, paths).reviews[0],
    ).toMatchObject({
      id: prepared.reviewId,
      status: 'failed',
    });
  });

  it('retries threshold reflection after workflow admission failure', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        conversationReviewTurnInterval: 2,
        memoryCurationEnabled: false,
      },
      paths,
    );
    const session = await createChatSession({ title: 'Retry cadence' }, paths);
    const sessionId = (session as { session: { id: string } }).session.id;
    const attempts: number[] = [];

    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview() {
        throw new Error('not due');
      },
    });
    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview(input) {
        attempts.push(input.turnCount ?? 0);
        throw new Error('admission failed');
      },
    });
    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview(input) {
        attempts.push(input.turnCount ?? 0);
        return { runId: 'run-retry' };
      },
    });

    expect(attempts).toEqual([2, 3]);
  });

  it('fails closed when learning config cannot be parsed', async () => {
    const paths = runtimePaths(await tempHome());
    const session = await createChatSession({ title: 'Invalid config' }, paths);
    const sessionId = (session as { session: { id: string } }).session.id;
    await writeFile(paths.config, '{ invalid json', 'utf8');

    await expect(
      prepareConversationReflection({ sessionId }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'learning_review_conversation',
      requires: ['valid-learning-config'],
    });
    await expect(
      recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
        async invokeConversationReview() {
          throw new Error('should not queue');
        },
      }),
    ).resolves.toMatchObject({
      queued: [],
      turnCount: 0,
      message: expect.stringContaining('Learning config is invalid'),
    });
  });

  it('does not expose legacy memory rows as model curation targets', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryCurationMode: 'auto',
        memoryWriteMode: 'auto',
      },
      paths,
    );
    const legacyId = insertLegacyMemory(paths, {
      scope: 'session',
      key: 'old-task',
      value: 'legacy task state',
    });

    const prepared = await prepareMemoryCurationReview(
      { trigger: 'manual', mode: 'auto' },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.allowedMemoryIds).not.toContain(legacyId);
    expect(JSON.stringify(prepared.inputSummary)).not.toContain(legacyId);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'Ignore legacy rows.',
          memoryActions: [
            {
              action: 'archive',
              memoryId: legacyId,
              reason: 'Legacy row should not be model-curated.',
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      skipped: [
        expect.objectContaining({
          reason: 'memory-not-in-review-snapshot',
        }),
      ],
    });
    await expect(
      listMemories({ includeArchived: true, scope: 'session' }, paths),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: legacyId, status: 'active' })],
    });
  });

  it('queues bounded learning workflows on configured turn intervals', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        conversationReviewTurnInterval: 2,
        memoryCurationTurnInterval: 3,
        memoryCurationEnabled: true,
      },
      paths,
    );
    const session = await createChatSession({ title: 'Cadence' }, paths);
    const sessionId = (session as { session: { id: string } }).session.id;
    const conversationCalls: unknown[] = [];
    const curationCalls: unknown[] = [];

    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview(input) {
        conversationCalls.push(input);
        return { runId: 'run-reflect-1' };
      },
      async invokeCurationReview(input) {
        curationCalls.push(input);
        return { runId: 'run-curate-1' };
      },
    });
    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview(input) {
        conversationCalls.push(input);
        return { runId: 'run-reflect-2' };
      },
      async invokeCurationReview(input) {
        curationCalls.push(input);
        return { runId: 'run-curate-2' };
      },
    });
    await recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
      async invokeConversationReview(input) {
        conversationCalls.push(input);
        return { runId: 'run-reflect-3' };
      },
      async invokeCurationReview(input) {
        curationCalls.push(input);
        return { runId: 'run-curate-3' };
      },
    });

    expect(conversationCalls).toEqual([
      expect.objectContaining({
        sessionId,
        trigger: 'turn-threshold',
        turnCount: 2,
      }),
    ]);
    expect(curationCalls).toEqual([
      expect.objectContaining({
        trigger: 'turn-threshold',
        turnCount: 3,
      }),
    ]);
  });

  it('records handled PR events idempotently and queues threshold reviews', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 2 }, paths);
    const queued: unknown[] = [];
    const first = await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-verified',
        source: 'workflow',
        sourceId: 'neondeck#42:prepared-diff-verified:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 42,
        summary: 'Verification passed.',
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review' };
        },
      },
    );
    const duplicate = await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-verified',
        source: 'workflow',
        sourceId: 'neondeck#42:prepared-diff-verified:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 42,
      },
      paths,
    );
    const second = await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-pushed',
        source: 'workflow',
        sourceId: 'neondeck#42:prepared-diff-pushed:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 42,
        summary: 'Autofix pushed.',
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review' };
        },
      },
    );

    expect(first).toMatchObject({
      recorded: true,
      duplicate: false,
      handledCountSinceReview: 1,
    });
    expect(duplicate).toMatchObject({ recorded: false, duplicate: true });
    expect(second).toMatchObject({
      recorded: true,
      handledCountSinceReview: 2,
      queued: [expect.objectContaining({ runId: 'run-pr-review' })],
    });
    expect(queued).toEqual([expect.objectContaining({ trigger: 'threshold' })]);
    expect((queued[0] as { repoId?: unknown }).repoId).toBeUndefined();
  });

  it('queues threshold PR retrospectives over the full unreviewed batch', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 2 }, paths);
    const queued: unknown[] = [];

    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-verified',
        source: 'workflow',
        sourceId: 'alpha#10:prepared-diff-verified:pd-10',
        repoId: 'alpha',
        repoFullName: 'example/alpha',
        prNumber: 10,
      },
      paths,
    );
    const second = await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-pushed',
        source: 'workflow',
        sourceId: 'beta#20:prepared-diff-pushed:pd-20',
        repoId: 'beta',
        repoFullName: 'example/beta',
        prNumber: 20,
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review' };
        },
      },
    );

    expect(second).toMatchObject({
      recorded: true,
      handledCountSinceReview: 2,
      queued: [expect.objectContaining({ runId: 'run-pr-review' })],
    });
    expect(queued).toEqual([expect.objectContaining({ trigger: 'threshold' })]);
    expect((queued[0] as { repoId?: unknown }).repoId).toBeUndefined();
  });

  it('retries automatic PR retrospectives after workflow admission failure', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 2 }, paths);
    const attempts: unknown[] = [];

    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-verified',
        source: 'workflow',
        sourceId: 'neondeck#51:prepared-diff-verified:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 51,
      },
      paths,
    );
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-pushed',
        source: 'workflow',
        sourceId: 'neondeck#51:prepared-diff-pushed:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 51,
      },
      paths,
      {
        async invokePrBatchReview(input) {
          attempts.push(input);
          throw new Error('admission failed');
        },
      },
    );
    const retry = await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'result-comment-completed',
        source: 'workflow',
        sourceId: 'neondeck#51:result-comment-completed:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 51,
      },
      paths,
      {
        async invokePrBatchReview(input) {
          attempts.push(input);
          return { runId: 'run-pr-review-retry' };
        },
      },
    );

    expect(attempts).toHaveLength(2);
    expect(retry).toMatchObject({
      recorded: true,
      queued: [expect.objectContaining({ runId: 'run-pr-review-retry' })],
    });
  });

  it('retries automatic PR retrospectives after a failed review', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 2 }, paths);
    const queued: unknown[] = [];
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-verified',
        source: 'workflow',
        sourceId: 'neondeck#50:prepared-diff-verified:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 50,
      },
      paths,
    );
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'prepared-diff-pushed',
        source: 'workflow',
        sourceId: 'neondeck#50:prepared-diff-pushed:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 50,
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review-1' };
        },
      },
    );
    const failedReviewId = startLearningReview(
      {
        kind: 'pr-batch',
        model: 'openai/test',
        thinkingLevel: 'low',
        trigger: { type: 'threshold' },
        inputSummary: { handledEventIds: [] },
      },
      paths,
    );
    failLearningReview(failedReviewId, 'model failed', paths);
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'result-comment-completed',
        source: 'workflow',
        sourceId: 'neondeck#50:result-comment-completed:pd-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 50,
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review-2' };
        },
      },
    );

    expect(queued).toHaveLength(2);
    expect(queued[1]).toEqual(
      expect.objectContaining({ trigger: 'threshold' }),
    );
    expect((queued[1] as { repoId?: unknown }).repoId).toBeUndefined();
  });

  it('records nested Kilo verification results as handled PR events', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 1 }, paths);
    const queued: unknown[] = [];

    const result = await recordHandledPrFromWorkflowResult(
      {
        workflow: 'verify_kilo_result',
        runId: 'run-kilo-verify',
        result: {
          ok: true,
          action: 'kilo_result_verify',
          changed: true,
          message: 'Kilo result verification passed.',
          task: {
            id: 'kilo-task-verify',
            repoId: 'neondeck',
            repoFullName: 'pandemicsyn/neondeck',
            worktreeId: 'wt-kilo',
          },
          data: {
            verification: {
              ok: true,
              action: 'autopilot_verify_pr_worktree',
              changed: true,
              message: 'Verified pandemicsyn/neondeck#77.',
              data: {
                worktree: {
                  id: 'wt-kilo',
                  repoId: 'neondeck',
                  repoFullName: 'pandemicsyn/neondeck',
                  prNumber: 77,
                },
                preparedDiffVerification: {
                  id: 'pd-kilo-verify',
                  repoId: 'neondeck',
                  repoFullName: 'pandemicsyn/neondeck',
                  prNumber: 77,
                  status: 'passed',
                },
              },
            },
          },
        },
      },
      paths,
      {
        async invokePrBatchReview(input) {
          queued.push(input);
          return { runId: 'run-pr-review-kilo' };
        },
      },
    );

    expect(result).toMatchObject({
      recorded: true,
      duplicate: false,
      queued: [expect.objectContaining({ runId: 'run-pr-review-kilo' })],
    });
    expect(queued).toEqual([expect.objectContaining({ trigger: 'threshold' })]);
  });

  it('labels blocked workflow outcomes without successful handled-event names', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ prRetrospectiveThreshold: 10 }, paths);

    await recordHandledPrFromWorkflowResult(
      {
        workflow: 'verify_pr_worktree',
        runId: 'run-verify-blocked',
        result: {
          ok: false,
          action: 'autopilot_verify_pr_worktree',
          changed: true,
          message: 'Verification is blocked by execution approval.',
          requires: ['approval'],
          data: {
            worktree: {
              id: 'wt-verify-blocked',
              repoId: 'neondeck',
              repoFullName: 'pandemicsyn/neondeck',
              prNumber: 78,
            },
            preparedDiffVerification: {
              id: 'pd-verify-blocked',
              repoId: 'neondeck',
              repoFullName: 'pandemicsyn/neondeck',
              prNumber: 78,
              status: 'failed',
            },
          },
        },
      },
      paths,
    );
    await recordHandledPrFromWorkflowResult(
      {
        workflow: 'push_pr_autofix',
        runId: 'run-push-blocked',
        result: {
          ok: false,
          action: 'autopilot_push_pr_autofix',
          changed: true,
          message: 'Push is blocked by policy.',
          requires: ['pushApproval'],
          data: {
            preparedDiff: {
              id: 'pd-push-blocked',
              repoId: 'neondeck',
              repoFullName: 'pandemicsyn/neondeck',
              prNumber: 78,
              status: 'push-blocked',
            },
          },
        },
      },
      paths,
    );

    const prepared = await preparePrBatchLearningReview(
      { trigger: 'manual' },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const summary = prepared.inputSummary as {
      handledEvents?: Array<{ eventType?: string | null }>;
    };

    expect(summary.handledEvents?.map((event) => event.eventType)).toEqual([
      'prepared-diff-verification-blocked',
      'prepared-diff-push-blocked',
    ]);
  });

  it('turns PR retrospective output into memory and skill candidates', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryWriteMode: 'review',
        skillWriteMode: 'review',
      },
      paths,
    );
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'review-feedback-workflow-completed',
        source: 'workflow',
        sourceId: 'neondeck#77:review-feedback-workflow-completed:run-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 77,
        summary: 'Review feedback repeatedly asked for Valibot IO guards.',
      },
      paths,
    );
    const prepared = await preparePrBatchLearningReview(
      { trigger: 'manual' },
      paths,
    );
    expect(prepared).toMatchObject({
      ok: true,
      kind: 'pr-batch',
      mode: 'review',
      skillMode: 'review',
    });
    if (!prepared.ok) throw new Error(prepared.message);

    await expect(
      completeLearningReviewFromModelOutput(
        prepared,
        {
          summary: 'Valibot boundary feedback is recurring.',
          memoryActions: [
            {
              action: 'upsert',
              scope: 'project',
              repoId: 'neondeck',
              key: 'autopilot.valibot-boundaries',
              value:
                'Autopilot TypeScript changes touching API/action inputs should verify Valibot schemas at IO boundaries before preparing diffs.',
              reason: 'Repeated PR feedback in handled work.',
            },
          ],
          skillPatches: [
            {
              skillId: 'neondeck',
              summary: 'Add Valibot autopilot pitfall.',
              reason: 'Repeated PR feedback in handled work.',
              operation: {
                type: 'append-section',
                heading: 'Learning Guidance',
                content:
                  '- Before preparing TypeScript autopilot diffs, check API/action input changes for Valibot schemas at IO boundaries.\n',
              },
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      memoryCandidates: [expect.objectContaining({ target: 'memory' })],
      skillCandidates: [expect.objectContaining({ target: 'skill' })],
    });

    await expect(
      listMemoryCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          target: 'memory',
          repoId: 'neondeck',
          reviewId: prepared.reviewId,
        }),
      ],
    });
    await expect(
      listSkillPatchCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          target: 'skill',
          skillId: 'neondeck',
          reviewId: prepared.reviewId,
        }),
      ],
    });
  });

  it('reports skill-only PR retrospective candidates as changed', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig({ skillWriteMode: 'review' }, paths);
    await recordHandledPrEventAndMaybeQueueLearning(
      {
        eventType: 'ci-failure-workflow-completed',
        source: 'workflow',
        sourceId: 'neondeck#88:ci-failure-workflow-completed:run-1',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 88,
        summary: 'CI fixes repeatedly missed the configured check order.',
      },
      paths,
    );
    const prepared = await preparePrBatchLearningReview(
      { trigger: 'manual' },
      paths,
    );
    if (!prepared.ok) throw new Error(prepared.message);

    const result = await completeLearningReviewFromModelOutput(
      prepared,
      {
        summary: 'Skill-only procedural lesson.',
        memoryActions: [],
        skillPatches: [
          {
            skillId: 'neondeck',
            summary: 'Add check-order guidance.',
            operation: {
              type: 'append-section',
              heading: 'Learning Guidance',
              content:
                '- Verify configured required checks before summarizing CI autofix readiness.\n',
            },
          },
        ],
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      skillCandidates: [expect.objectContaining({ target: 'skill' })],
    });
    expect(listLearningReviews({ kind: 'pr-batch' }, paths)).toMatchObject({
      reviews: [
        expect.objectContaining({
          id: prepared.reviewId,
          result: expect.objectContaining({
            candidatesCreated: 1,
            memoryCandidatesCreated: 0,
            skillCandidatesCreated: 1,
          }),
        }),
      ],
    });
  });

  it('proposes, applies, and rejects skill patch candidates for user runtime skills', async () => {
    const paths = runtimePaths(await tempHome());
    await writeUserSkill(paths.home, 'test-skill');
    const proposed = await proposeSkillPatch(
      {
        skillId: 'test-skill',
        summary: 'Add verification guidance.',
        operation: {
          type: 'append-section',
          heading: 'Verification',
          content: '- Run npm run check before summarizing local changes.\n',
        },
      },
      paths,
    );
    expect(proposed).toMatchObject({
      ok: true,
      changed: true,
      candidate: expect.objectContaining({ skillId: 'test-skill' }),
    });
    const candidateId = (proposed as { candidate: { id: string } }).candidate
      .id;

    await expect(
      applySkillPatchCandidate({ id: candidateId }, paths, { source: 'neon' }),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['explicit-user-decision'],
    });
    await expect(
      applySkillPatchCandidate({ id: candidateId }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'skill_patch_apply',
    });
    await expect(
      restoreSkillPatchCandidate(
        {
          id: candidateId,
          confirm: true,
          reason: 'Model restore should be blocked.',
        },
        paths,
        { source: 'neon' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['explicit-user-decision'],
    });
    await expect(
      restoreSkillPatchCandidate(
        {
          id: candidateId,
          confirm: true,
          reason: 'Restore test patch.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'skill_patch_restore',
    });
    await expect(
      restoreSkillPatchCandidate(
        {
          id: candidateId,
          confirm: true,
          reason: 'Already restored.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['applied-skill-patch'],
    });

    await expect(
      proposeSkillPatch(
        {
          skillId: 'test-skill',
          summary: 'Add review guidance.',
          operation: {
            type: 'append-section',
            heading: 'Review',
            content: '- Prefer typed actions over direct config edits.\n',
          },
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    const listed = await listSkillPatchCandidates(
      { status: 'proposed', skillId: 'test-skill' },
      paths,
    );
    const rejectId = listed.candidates[0]?.id;
    expect(rejectId).toEqual(expect.any(String));
    await expect(
      rejectSkillPatchCandidate({ id: String(rejectId) }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'skill_patch_reject',
    });
    await expect(
      readLearningOperatorState({ candidateTarget: 'skill' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      action: 'learning_operator_state',
      summary: {
        candidates: expect.objectContaining({
          archived: expect.any(Number),
          rejected: expect.any(Number),
        }),
      },
      skillPatchCandidates: expect.arrayContaining([
        expect.objectContaining({ id: candidateId, status: 'archived' }),
        expect.objectContaining({ id: String(rejectId), status: 'rejected' }),
      ]),
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-'));
  tempRoots.push(home);
  return home;
}

function insertLegacyMemory(
  paths: ReturnType<typeof runtimePaths>,
  input: { scope: 'session' | 'watch'; key: string; value: string },
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO memories (
          id,
          scope,
          key,
          value_json,
          status,
          use_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'active', 0, ?, ?);
      `,
      )
      .run(id, input.scope, input.key, JSON.stringify(input.value), now, now);
  } finally {
    database.close();
  }
  return id;
}

async function writeUserSkill(home: string, id: string) {
  const directory = join(home, 'skills', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${id}`,
      'description: Test runtime skill.',
      '---',
      '',
      '# Test Skill',
      '',
      'Initial guidance.',
      '',
    ].join('\n'),
    'utf8',
  );
}
