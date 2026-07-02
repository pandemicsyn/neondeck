import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
