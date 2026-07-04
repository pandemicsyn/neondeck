import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateLearningConfig } from './modules/config';
import {
  listLearningReviews,
  recordHandledPrEventAndMaybeQueueLearning,
} from './modules/learning/reviews';
import { readLearningOperatorState } from './modules/learning';
import { listMemories } from './modules/memory';
import { runtimePaths } from './runtime-home';
import { createChatSession } from './modules/sessions';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

vi.setConfig({ testTimeout: 60_000 });
vi.mock('./skills/github-gh/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'github-gh',
      description: 'GitHub fixture skill for learning workflow smoke tests.',
    }),
  };
});
vi.mock('./skills/neondeck/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'neondeck',
      description: 'Neondeck fixture skill for learning workflow smoke tests.',
    }),
  };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('learning Flue workflow smoke', () => {
  it('runs conversation reflection and PR retrospective with fake model output', async () => {
    const workflows = await loadWorkflows();
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

    const conversation = await runWorkflow(
      workflows.reviewConversationForLearning,
      {
        sessionId: session.session.id,
        reason: 'workflow smoke',
        trigger: 'manual',
      },
      fakeHarness({
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
      }),
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
    const retrospective = await runWorkflow(
      workflows.reviewPrBatchForLearning,
      { trigger: 'manual', reason: 'workflow smoke' },
      fakeHarness({
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
      }),
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
      prRetrospectiveThreshold: 1,
      maxPrBatchItems: 4,
    },
    paths,
  );
  return paths;
}

function fakeHarness(output: unknown) {
  return {
    async session() {
      return {
        async task() {
          return { data: output };
        },
      };
    },
  };
}

async function runWorkflow(
  workflow: unknown,
  input: unknown,
  harness: unknown,
) {
  const runnable = workflow as {
    action: {
      run(context: { harness: unknown; input: unknown }): unknown;
    };
  };
  return Promise.resolve(runnable.action.run({ harness, input }));
}

async function loadWorkflows() {
  const [reviewConversationForLearning, reviewPrBatchForLearning] =
    await Promise.all([
      import('./workflows/review_conversation_for_learning'),
      import('./workflows/review_pr_batch_for_learning'),
    ]);
  return {
    reviewConversationForLearning: reviewConversationForLearning.default,
    reviewPrBatchForLearning: reviewPrBatchForLearning.default,
  };
}
