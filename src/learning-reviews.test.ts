import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAgentModels, updateLearningConfig } from './config-actions';
import {
  completeLearningReviewFromModelOutput,
  listLearningReviews,
  prepareConversationReflection,
  prepareMemoryCurationReview,
  recordConversationTurnAndMaybeQueueLearning,
} from './learning-reviews';
import {
  listMemories,
  listMemoryCandidates,
  upsertMemory,
} from './memory-actions';
import { createChatSession } from './session-actions';
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
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-'));
  tempRoots.push(home);
  return home;
}
