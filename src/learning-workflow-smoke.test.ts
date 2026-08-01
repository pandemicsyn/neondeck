import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateLearningConfig } from './modules/config';
import {
  completeLearningReviewFromModelOutput,
  listLearningReviews,
  prepareConversationReflection,
  preparePrBatchLearningReview,
  recordHandledPrEventAndMaybeQueueLearning,
} from './modules/learning/reviews';
import { readLearningOperatorState } from './modules/learning';
import { listMemories } from './modules/memory';
import { runtimePaths } from './runtime-home';
import { createChatSession } from './modules/sessions';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

vi.setConfig({ testTimeout: 60_000 });
afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('learning review smoke', () => {
  it('completes conversation reflection and PR retrospective snapshots', async () => {
    const paths = await fixture();
    const session = await createChatSession(
      {
        title: 'Learning smoke',
        kind: 'main',
        activate: true,
        summary:
          'The user corrected Neon to run npm run check before summarizing Neondeck changes.',
      },
      paths,
    );
    if (!('session' in session)) throw new Error(session.message);

    const preparedConversation = await prepareConversationReflection(
      {
        sessionId: session.session.id,
        reason: 'learning review smoke',
        trigger: 'manual',
      },
      paths,
    );
    if (!preparedConversation.ok) {
      throw new Error(preparedConversation.message);
    }
    const conversation = await completeLearningReviewFromModelOutput(
      preparedConversation,
      {
        summary: 'Remember the local verification loop.',
        memoryActions: [
          {
            action: 'upsert',
            scope: 'local',
            key: 'verification.fast-loop',
            value: 'Run npm run check before summarizing Neondeck changes.',
            reason: 'Repeated user correction in conversation summary.',
          },
        ],
      },
      paths,
    );
    expect(conversation).toMatchObject({
      ok: true,
      action: 'learning_review_conversation',
      changed: true,
    });
    await expect(
      listMemories({ scope: 'local' }, paths),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ key: 'verification.fast-loop' })],
    });

    await recordHandledPrEventAndMaybeQueueLearning(
      {
        source: 'smoke',
        sourceId: 'smoke-pr-1',
        eventType: 'verification-passed',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 22,
        summary: 'Autopilot fix passed after adding Valibot API validation.',
      },
      paths,
    );
    const preparedRetrospective = await preparePrBatchLearningReview(
      { trigger: 'manual', reason: 'learning review smoke' },
      paths,
    );
    if (!preparedRetrospective.ok) {
      throw new Error(preparedRetrospective.message);
    }
    const retrospective = await completeLearningReviewFromModelOutput(
      preparedRetrospective,
      {
        summary: 'Capture the recurring Valibot API boundary lesson.',
        memoryActions: [
          {
            action: 'upsert',
            scope: 'project',
            repoId: 'neondeck',
            key: 'learning.valibot-boundaries',
            value:
              'Learning/operator APIs should validate inputs with Valibot before workflow admission.',
            reason: 'PR retrospective smoke fixture.',
          },
        ],
        skillPatches: [
          {
            skillId: 'neondeck',
            summary: 'Add learning API validation reminder.',
            reason: 'PR retrospective smoke fixture.',
            operation: {
              type: 'append-section',
              heading: 'Learning Operator Reminders',
              content:
                '- Validate learning/operator API inputs with Valibot before workflow admission.\n',
            },
          },
        ],
      },
      paths,
    );
    expect(retrospective).toMatchObject({
      ok: true,
      action: 'learning_review_pr_batch',
      changed: true,
      skillCandidates: [expect.objectContaining({ target: 'skill' })],
    });

    await expect(listLearningReviews({}, paths)).toMatchObject({
      reviews: expect.arrayContaining([
        expect.objectContaining({ kind: 'conversation', status: 'completed' }),
        expect.objectContaining({ kind: 'pr-batch', status: 'completed' }),
      ]),
    });
    await expect(readLearningOperatorState({}, paths)).resolves.toMatchObject({
      ok: true,
      summary: {
        handledPrEvents: 1,
        pendingDecisions: expect.any(Number),
      },
      skillPatchCandidates: [
        expect.objectContaining({ target: 'skill', status: 'proposed' }),
      ],
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-smoke-'));
  tempRoots.push(home);
  process.env = {
    ...originalEnv,
    NEONDECK_HOME: home,
    NEONDECK_DISABLE_SCHEDULER: '1',
  };
  const paths = runtimePaths(home);
  await updateLearningConfig(
    {
      memoryWriteMode: 'auto',
      skillWriteMode: 'review',
      prRetrospectiveThreshold: 10,
      maxPrBatchItems: 4,
    },
    paths,
  );
  return paths;
}
