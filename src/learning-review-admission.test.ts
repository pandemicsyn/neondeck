import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolStep } from '@flue/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateLearningConfig } from './modules/config';
import { openDb, withImmediateTransaction } from './lib/sqlite';
import {
  admitPreparedLearningReview,
  createSubmitLearningReviewTool,
  getLearningReview,
  insertLearningReviewAdmissionIntent,
  listPendingLearningReviewAdmissionIntents,
  listRecoverableLearningReviews,
  recoverInterruptedLearningReviews,
  resetLearningReviewSettlementWatchersForTests,
  startLearningReview,
  type PreparedLearningReview,
} from './modules/learning/reviews';
import { listMemoryCandidates } from './modules/memory';
import { createChatSession } from './modules/sessions';
import { runtimePaths, type RuntimePaths } from './runtime-home';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  resetLearningReviewSettlementWatchersForTests();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('learning review admission', () => {
  it('persists the exact bounded snapshot before dispatch and attaches the submission', async () => {
    const paths = await fixture();
    const prepared = preparedReview(paths);
    let releaseSettlement: (() => void) | undefined;
    const settlement = new Promise<{ failed: false }>((resolve) => {
      releaseSettlement = () => resolve({ failed: false });
    });
    const dispatch = vi.fn<
      (
        input: PreparedLearningReview,
        agentId: string,
      ) => Promise<{ submissionId: string }>
    >(async (input: PreparedLearningReview, agentId: string) => {
      expect(input).toEqual(prepared);
      expect(agentId).toBe(`learning-review:${prepared.reviewId}`);
      expect(listRecoverableLearningReviews(paths)).toEqual([
        expect.objectContaining({ prepared }),
      ]);
      return { submissionId: 'submission-1' };
    });

    await expect(
      admitPreparedLearningReview(prepared, paths, {
        dispatch,
        readSettlement: async () => settlement,
      }),
    ).resolves.toMatchObject({
      reviewId: prepared.reviewId,
      agentId: `learning-review:${prepared.reviewId}`,
      submissionId: 'submission-1',
    });
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'running',
      submissionId: 'submission-1',
      dispatchError: null,
    });
    releaseSettlement?.();
  });

  it('rejects malformed non-record admission input before dispatch', async () => {
    const paths = await fixture();
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `INSERT INTO learning_review_admissions (
            id, kind, session_id, input_json, status, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?);`,
        )
        .run(
          'learning-intent:malformed-array',
          'conversation',
          null,
          '[]',
          'pending',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
        );
    } finally {
      database.close();
    }

    expect(() => listPendingLearningReviewAdmissionIntents(paths)).toThrow(
      'learning-intent:malformed-array',
    );
  });

  it('keyed-redispatches the persisted snapshot after an interrupted admission', async () => {
    const paths = await fixture();
    const prepared = preparedReview(paths);
    await expect(
      admitPreparedLearningReview(prepared, paths, {
        dispatch: async () => {
          throw new Error('receipt was not attached');
        },
      }),
    ).rejects.toThrow('receipt was not attached');
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'running',
      submissionId: null,
      dispatchError: 'receipt was not attached',
    });

    const dispatch = vi.fn<
      (
        input: PreparedLearningReview,
        agentId: string,
      ) => Promise<{ submissionId: string }>
    >(async (input: PreparedLearningReview, agentId: string) => {
      expect(input).toEqual(prepared);
      expect(agentId).toBe(`learning-review:${prepared.reviewId}`);
      return { submissionId: 'submission-recovered' };
    });
    await expect(
      recoverInterruptedLearningReviews(paths, {
        dispatch,
        readSettlement: async () => ({
          failed: true,
          error: 'canonical settlement failed',
        }),
      }),
    ).resolves.toEqual({ recovered: [prepared.reviewId], failed: [] });
    await vi.waitFor(() => {
      expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
        status: 'failed',
        submissionId: 'submission-recovered',
        error: 'canonical settlement failed',
      });
    });
  });

  it('recovers a cadence intent committed before review preparation', async () => {
    const paths = await fixture();
    const session = await createChatSession(
      { title: 'Cadence outbox recovery' },
      paths,
    );
    if (!session.ok || !('session' in session)) {
      throw new Error(session.message);
    }
    const intentId = 'learning-intent:test-recovery';
    const database = openDb(paths.neondeckDatabase);
    withImmediateTransaction(database, () => {
      insertLearningReviewAdmissionIntent(database, {
        id: intentId,
        kind: 'conversation',
        sessionId: session.session.id,
        reviewInput: {
          sessionId: session.session.id,
          trigger: 'turn-threshold',
          turnCount: 10,
        },
        createdAt: new Date().toISOString(),
      });
    });
    database.close();
    let releaseSettlement: (() => void) | undefined;
    const settlement = new Promise<{ failed: false }>((resolve) => {
      releaseSettlement = () => resolve({ failed: false });
    });
    const dispatch = vi.fn<
      (
        prepared: PreparedLearningReview,
        agentId: string,
      ) => Promise<{ submissionId: string }>
    >(async (prepared, agentId) => {
      expect(prepared.reviewId).toBe(intentId);
      expect(agentId).toBe(`learning-review:${intentId}`);
      return { submissionId: 'submission-from-outbox' };
    });

    await expect(
      recoverInterruptedLearningReviews(paths, {
        dispatch,
        readSettlement: async () => settlement,
      }),
    ).resolves.toMatchObject({ recovered: [intentId], failed: [] });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(listPendingLearningReviewAdmissionIntents(paths)).toEqual([]);
    expect(getLearningReview(intentId, paths)).toMatchObject({
      status: 'running',
      submissionId: 'submission-from-outbox',
    });
    releaseSettlement?.();
  });

  it('fails closed when a completed submission has no validated review result', async () => {
    const paths = await fixture();
    const prepared = preparedReview(paths);
    await admitPreparedLearningReview(prepared, paths, {
      dispatch: async () => ({ submissionId: 'submission-empty' }),
      readSettlement: async () => ({ failed: false }),
    });
    await vi.waitFor(() => {
      expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
        status: 'failed',
        error: 'Learning review submission settled without a validated result.',
      });
    });
  });

  it('retries transient settlement reads instead of leaving the review running', async () => {
    const paths = await fixture();
    const prepared = preparedReview(paths);
    const readSettlement = vi
      .fn<
        (
          agentId: string,
          submissionId: string,
        ) => Promise<{ failed: false } | { failed: true; error: string }>
      >()
      .mockRejectedValueOnce(new Error('temporary Flue read failure'))
      .mockResolvedValueOnce({
        failed: true as const,
        error: 'canonical submission failure',
      });

    await admitPreparedLearningReview(prepared, paths, {
      dispatch: async () => ({ submissionId: 'submission-retry' }),
      readSettlement,
      settlementRetryDelayMs: 0,
    });

    await vi.waitFor(() => {
      expect(readSettlement).toHaveBeenCalledTimes(2);
      expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
        status: 'failed',
        error: 'canonical submission failure',
      });
    });
  });

  it('applies validated structured input without opening a nested harness prompt', async () => {
    const paths = await fixture();
    process.env.NEONDECK_HOME = paths.home;
    const prepared = preparedReview(paths);
    const tool = createSubmitLearningReviewTool(prepared);
    const run = tool.run;
    if (!run) throw new Error('Learning review tool has no run handler.');
    const result = await run(
      toolRunContext({
        summary: 'No durable learning was justified.',
        memoryActions: [],
        skillPatches: [],
      }),
    );

    expect(result).toMatchObject({
      terminate: true,
      output: { ok: true, action: 'learning_review_conversation' },
    });
    expect(tool).not.toHaveProperty('harness', true);
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'completed',
    });
  });

  it('single-flights duplicate submit calls from the same Flue tool batch', async () => {
    const paths = await fixture();
    process.env.NEONDECK_HOME = paths.home;
    const prepared = preparedReview(paths);
    const tool = createSubmitLearningReviewTool(prepared);
    const run = tool.run;
    if (!run) throw new Error('Learning review tool has no run handler.');
    const step = immediateToolStep();
    const stepDo = vi.spyOn(step, 'do');
    const context = toolRunContext(
      {
        summary: 'No durable learning was justified.',
        memoryActions: [],
        skillPatches: [],
      },
      step,
    );

    const [first, duplicate] = await Promise.all([run(context), run(context)]);

    expect(duplicate).toEqual(first);
    expect(stepDo.mock.calls.map(([name]) => name)).toEqual([
      'complete-review',
    ]);
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'completed',
    });
  });

  it('records committed effects when a later durable step fails', async () => {
    const paths = await fixture();
    process.env.NEONDECK_HOME = paths.home;
    const prepared = preparedReview(paths);
    const tool = createSubmitLearningReviewTool(prepared);
    const run = tool.run;
    if (!run) throw new Error('Learning review tool has no run handler.');
    const result = await run(
      toolRunContext(
        {
          summary: 'A local validation preference was observed.',
          memoryActions: [
            {
              action: 'upsert',
              scope: 'local',
              key: 'validation-command',
              value: 'npm run check',
              reason: 'Repeated local preference.',
            },
          ],
          skillPatches: [],
        },
        {
          async do<Result>(
            name: string,
            effect: () => Result | Promise<Result>,
          ) {
            if (name === 'complete-review') {
              throw new Error('forced completion checkpoint failure');
            }
            return effect();
          },
        },
      ),
    );

    expect(result).toMatchObject({
      terminate: true,
      output: {
        ok: false,
        changed: true,
        partial: true,
        outcomeUnknown: true,
        uncertainEffect: 'complete-review',
        completedEffects: [
          {
            name: 'memory-candidate:0',
            changed: true,
            identifiers: {
              id: `learning:${prepared.reviewId}:memory:0`,
            },
          },
        ],
      },
    });
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'failed',
      error: 'forced completion checkpoint failure',
      result: {
        failed: true,
        partial: true,
        changed: true,
        outcomeUnknown: true,
        uncertainEffect: 'complete-review',
        completedEffects: [
          expect.objectContaining({ name: 'memory-candidate:0' }),
        ],
      },
    });
    await expect(
      listMemoryCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          id: `learning:${prepared.reviewId}:memory:0`,
        }),
      ],
    });
  });

  it('marks an effect outcome unknown when mutation succeeds before its checkpoint rejects', async () => {
    const paths = await fixture();
    process.env.NEONDECK_HOME = paths.home;
    const prepared = preparedReview(paths);
    const tool = createSubmitLearningReviewTool(prepared);
    const run = tool.run;
    if (!run) throw new Error('Learning review tool has no run handler.');
    const result = await run(
      toolRunContext(
        {
          summary: 'A local validation preference was observed.',
          memoryActions: [
            {
              action: 'upsert',
              scope: 'local',
              key: 'validation-command',
              value: 'npm run check',
              reason: 'Repeated local preference.',
            },
          ],
          skillPatches: [],
        },
        {
          async do<Result>(
            name: string,
            effect: () => Result | Promise<Result>,
          ) {
            const effectResult = await effect();
            if (name === 'memory-candidate:0') {
              throw new Error('forced checkpoint persistence failure');
            }
            return effectResult;
          },
        },
      ),
    );

    expect(result).toMatchObject({
      terminate: true,
      output: {
        ok: false,
        changed: false,
        partial: true,
        outcomeUnknown: true,
        uncertainEffect: 'memory-candidate:0',
        completedEffects: [],
      },
    });
    expect(getLearningReview(prepared.reviewId, paths)).toMatchObject({
      status: 'failed',
      error: 'forced checkpoint persistence failure',
      result: {
        failed: true,
        partial: true,
        changed: false,
        outcomeUnknown: true,
        uncertainEffect: 'memory-candidate:0',
        completedEffects: [],
      },
    });
    await expect(
      listMemoryCandidates({ status: 'proposed' }, paths),
    ).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          id: `learning:${prepared.reviewId}:memory:0`,
        }),
      ],
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-admission-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await updateLearningConfig({}, paths);
  return paths;
}

type SubmitReviewRun = NonNullable<
  ReturnType<typeof createSubmitLearningReviewTool>['run']
>;
type SubmitReviewRunContext = Parameters<SubmitReviewRun>[0];

function toolRunContext(
  data: SubmitReviewRunContext['data'],
  step: ToolStep = immediateToolStep(),
): SubmitReviewRunContext {
  return {
    toolCallId: 'learning-review-test-call',
    data,
    log: {
      error: vi.fn<SubmitReviewRunContext['log']['error']>(),
      warn: vi.fn<SubmitReviewRunContext['log']['warn']>(),
      info: vi.fn<SubmitReviewRunContext['log']['info']>(),
    },
    step,
  };
}

function immediateToolStep(): ToolStep {
  return {
    async do<Result>(_name: string, effect: () => Result | Promise<Result>) {
      return effect();
    },
  };
}

function preparedReview(paths: RuntimePaths): PreparedLearningReview {
  const inputSummary = { evidence: 'bounded' };
  const reviewId = startLearningReview(
    {
      kind: 'conversation',
      model: 'openai/gpt-test',
      thinkingLevel: 'low',
      trigger: { type: 'manual' },
      inputSummary,
    },
    paths,
  );
  return {
    ok: true,
    reviewId,
    kind: 'conversation',
    mode: 'review',
    skillMode: 'review',
    model: 'openai/gpt-test',
    thinkingLevel: 'low',
    inputSummary,
    prompt: 'Review only this bounded evidence.',
    allowedMemoryIds: [],
    memorySnapshots: [],
    allowedProjectRepoIds: [null],
    allowedSkillIds: ['neondeck'],
    skillSnapshots: [
      { id: 'neondeck', sha256: 'prepared-neondeck-skill-hash' },
    ],
  };
}
