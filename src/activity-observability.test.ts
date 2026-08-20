import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readActivityObservability,
  readActivitySubmission,
  readActivitySubmissionEvents,
  readPrReviewPerformance,
  recordFlueObservation,
} from './modules/learning';
import { openDb } from './lib/sqlite';
import { prReviewerWorkspaceToolCallLimit } from './modules/pr-reviewer';
import { runtimePaths, type RuntimePaths } from './runtime-home';
import { createActivityRoutes } from './server/routes/activity';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Flue v3 activity observability', () => {
  it('projects queued, running, and authoritative settlement events', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'submission_running',
        kind: 'dispatch',
        attemptCount: 1,
        maxAttempts: 3,
      },
      paths,
    );

    await expect(readActivityObservability(paths)).resolves.toMatchObject({
      action: 'activity_observability_read',
      activeSubmissions: [
        {
          submissionId: 'submission-1',
          agentName: 'display-assistant',
          instanceId: 'session-1',
          status: 'running',
          attemptCount: 1,
          eventCount: 2,
        },
      ],
    });

    await recordFlueObservation(
      { ...base(3), type: 'submission_settled', outcome: 'completed' },
      paths,
    );
    await expect(readActivityObservability(paths)).resolves.toMatchObject({
      activeSubmissions: [],
      recentSettlements: [
        {
          submissionId: 'submission-1',
          eventType: 'submission_settled',
          isError: false,
        },
      ],
    });
    await expect(
      readActivitySubmission('submission-1', paths),
    ).resolves.toMatchObject({ status: 'completed', eventCount: 3 });

    await recordFlueObservation(
      {
        ...base(2),
        type: 'submission_running',
        kind: 'dispatch',
        attemptCount: 1,
        maxAttempts: 3,
      },
      paths,
    );
    await expect(
      readActivitySubmission('submission-1', paths),
    ).resolves.toMatchObject({ status: 'completed', eventCount: 4 });
  });

  it('treats failed and aborted settlements as terminal failures', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'submission_settled',
        outcome: 'failed',
        error: { message: 'provider rejected request', type: 'provider_error' },
      },
      paths,
    );

    const snapshot = await readActivityObservability(paths);
    expect(snapshot.activeSubmissions).toEqual([]);
    expect(snapshot.recentFailures).toEqual([
      expect.objectContaining({
        eventType: 'submission_settled',
        isError: true,
        message: 'Submission failed.',
      }),
    ]);
  });

  it('stores only sanitized event summaries', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'log',
        level: 'info',
        message: 'token=super-secret-value',
        attributes: {
          safe: 'visible',
          authorization: 'Bearer secret',
        },
      },
      paths,
    );
    const history = await readActivitySubmissionEvents('submission-1', paths);
    expect(history.events[1]).toMatchObject({
      message: '[redacted]',
      agentName: 'display-assistant',
      instanceId: 'session-1',
      conversationId: 'conversation-1',
    });
    expect(JSON.stringify(history.events[1]?.summary)).not.toContain(
      'Bearer secret',
    );
  });

  it('retains safe typed review-workspace evidence without source contents', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'tool',
        toolName: 'neondeck_review_workspace_read',
        durationMs: 25,
        isError: false,
        result: { output: 'transport wrapper' },
        effectiveResult: {
          revisionKind: 'head',
          path: 'src/app.ts',
          startLine: 10,
          endLine: 40,
          totalLines: 120,
          content: 'secret implementation contents',
          truncated: false,
          workspaceToolCallsRemaining: prReviewerWorkspaceToolCallLimit - 1,
          workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
        },
      } as never,
      paths,
    );
    const query = 'exact source fragment that must not be persisted';
    await recordFlueObservation(
      {
        ...base(3),
        type: 'tool_start',
        toolName: 'neondeck_review_workspace_search',
        origin: 'model',
        args: {
          query,
          path: 'src/very-long-but-legitimate-repository-path.ts',
        },
      } as never,
      paths,
    );
    await recordFlueObservation(
      {
        ...base(4),
        type: 'tool',
        toolName: 'neondeck_review_workspace_search',
        durationMs: 10,
        isError: false,
        effectiveResult: {
          query,
          matches: ['src/app.ts:10:exact source fragment'],
          workspaceToolCallsRemaining: prReviewerWorkspaceToolCallLimit - 2,
          workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
        },
      } as never,
      paths,
    );
    await recordFlueObservation(
      {
        ...base(5),
        type: 'tool_start',
        toolName: 'neondeck_review_workspace_search',
        origin: 'model',
        args: {
          path: 'src/very-long-but-legitimate-repository-path.ts',
          query,
        },
      } as never,
      paths,
    );
    await recordFlueObservation(
      {
        ...base(6),
        type: 'tool',
        toolName: 'neondeck_review_workspace_search',
        durationMs: 8,
        isError: false,
        effectiveResult: {
          query,
          matches: ['src/app.ts:10:exact source fragment'],
          outputRef: 'ephemeral-output-ref',
          outputHint: 'ephemeral output hint',
          workspaceToolCallsRemaining: prReviewerWorkspaceToolCallLimit - 3,
          workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
        },
      } as never,
      paths,
    );

    const history = await readActivitySubmissionEvents('submission-1', paths);
    expect(history.events[1]).toMatchObject({
      message: 'Review workspace read completed for src/app.ts in 25ms.',
      name: 'neondeck_review_workspace_read',
      summary: {
        category: 'review-workspace',
        operation: 'read',
        phase: 'completed',
        revisionKind: 'head',
        path: 'src/app.ts',
        startLine: 10,
        endLine: 40,
        totalLines: 120,
        resultBytes: expect.any(Number),
        resultHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        workspaceToolCallsRemaining: prReviewerWorkspaceToolCallLimit - 1,
        workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
      },
    });
    expect(history.events[1]?.summary).not.toHaveProperty('query');
    expect(history.events[1]?.summary).not.toHaveProperty('rightLine');
    expect(history.events[2]).toMatchObject({
      summary: {
        category: 'review-workspace',
        operation: 'search',
        path: 'src/very-long-but-legitimate-repository-path.ts',
        queryLength: query.length,
        queryHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(history.events[3]).toMatchObject({
      summary: {
        category: 'review-workspace',
        operation: 'search',
        queryLength: query.length,
        queryHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        resultHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        returnedMatches: 1,
        resultBytes: expect.any(Number),
      },
    });
    expect(JSON.stringify(history.events[1]?.summary)).not.toContain(
      'secret implementation contents',
    );
    const firstSearchStart = history.events[2];
    const firstSearchResult = history.events[3];
    const repeatedSearchStart = history.events[4];
    const repeatedSearchResult = history.events[5];
    expect(firstSearchStart).toBeDefined();
    expect(firstSearchResult).toBeDefined();
    expect(repeatedSearchStart).toBeDefined();
    expect(repeatedSearchResult).toBeDefined();
    expect(
      (firstSearchStart!.summary as Record<string, unknown>).inputHash,
    ).toBe((repeatedSearchStart!.summary as Record<string, unknown>).inputHash);
    expect(
      (firstSearchResult!.summary as Record<string, unknown>).resultHash,
    ).toBe(
      (repeatedSearchResult!.summary as Record<string, unknown>).resultHash,
    );
    expect(JSON.stringify(history.events)).not.toContain(query);
  });

  it('records hashed Explore scope metadata without retaining task prompts', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    const prompt = [
      'Question: Does the cache invalidate after a rename?',
      'Revision: head abc123 against merge-base def456',
      'Scope: src/cache.ts, src/rename.ts',
      'Exclusions: docs/, generated files',
      'Known facts: The PR changes both scoped files.',
      'Expected evidence: Exact callers and changed-line evidence.',
      'Thoroughness: medium',
    ].join('\n');
    await recordFlueObservation(
      {
        ...base(2),
        type: 'task_start',
        taskId: 'task-1',
        agent: 'explore',
        prompt,
      } as never,
      paths,
    );

    const history = await readActivitySubmissionEvents('submission-1', paths);
    expect(history.events[1]).toMatchObject({
      name: 'explore',
      summary: {
        taskId: 'task-1',
        agent: 'explore',
        promptLength: prompt.length,
        promptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        questionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        revisionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        scopeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        scopeItemCount: 2,
        exclusionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        exclusionItemCount: 2,
        expectedEvidenceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        thoroughness: 'medium',
      },
    });
    expect(JSON.stringify(history.events[1]?.summary)).not.toContain(
      'cache invalidate',
    );
    expect(JSON.stringify(history.events[1]?.summary)).not.toContain(
      'src/cache.ts',
    );
  });

  it('projects Flue 2 usage fields and cost breakdowns', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'turn',
        purpose: 'agent',
        turnId: 'turn-1',
        durationMs: 1_000,
        isError: false,
        request: { providerId: 'provider', requestedModel: 'requested-model' },
        response: {
          responseModel: 'actual-model',
          finishReason: 'stop',
          usage: {
            input: 1_000,
            output: 200,
            cacheRead: 800,
            cacheWrite: 50,
            totalTokens: 2_050,
            cost: {
              input: 0.01,
              output: 0.02,
              cacheRead: 0.003,
              cacheWrite: 0.004,
              total: 0.037,
            },
          },
        },
      } as never,
      paths,
    );

    const history = await readActivitySubmissionEvents('submission-1', paths);
    expect(history.events[1]?.summary).toMatchObject({
      responseModel: 'actual-model',
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 800,
        cacheWriteTokens: 50,
        totalTokens: 2_050,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.003,
          cacheWrite: 0.004,
          total: 0.037,
        },
      },
    });
  });

  it('derives concurrent Explore critical paths from sanitized review activity', async () => {
    const paths = await tempPaths();
    await ensureReviewBinding(paths);
    await recordFlueObservation(
      { ...queued(1), instanceId: 'pr-review:review-1:attempt-1' },
      paths,
    );
    await recordFlueObservation(
      {
        ...base(2),
        instanceId: 'pr-review:review-1:attempt-1',
        type: 'turn_start',
        purpose: 'agent',
        turnId: 'parent-turn-1',
      } as never,
      paths,
    );
    const prompt = [
      'Question: Check one bounded concern.',
      'Revision: head against merge-base',
      'Scope: src/app.ts',
      'Exclusions: docs/',
      'Known facts: one changed file',
      'Expected evidence: changed-line evidence',
      'Thoroughness: medium',
    ].join('\n');
    for (const taskId of ['task-1', 'task-2']) {
      await recordFlueObservation(
        {
          ...base(taskId === 'task-1' ? 3 : 4),
          type: 'task_start',
          taskId,
          agent: 'explore',
          prompt,
          turnId: 'parent-turn-1',
        } as never,
        paths,
      );
      await recordFlueObservation(
        {
          ...base(taskId === 'task-1' ? 5 : 6),
          type: 'turn',
          taskId,
          purpose: 'agent',
          turnId: `${taskId}-turn`,
          durationMs: 100,
          isError: false,
          request: {
            providerId: 'provider',
            requestedModel: 'explore-model',
            reasoningLevel: 'medium',
          },
          response: {
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: {
                input: 1,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                total: 3,
              },
            },
          },
        } as never,
        paths,
      );
      await recordFlueObservation(
        {
          ...base(taskId === 'task-1' ? 7 : 8),
          type: 'task',
          taskId,
          agent: 'explore',
          durationMs: taskId === 'task-1' ? 4_000 : 5_000,
          isError: false,
          result:
            'Answer: yes\nEvidence:\n- src/app.ts:1 — app — observed\nUnresolved: none\nInspected: src/app.ts\nStop reason: answered',
        } as never,
        paths,
      );
    }
    await recordFlueObservation(
      {
        ...base(9),
        type: 'tool_start',
        toolName: 'neondeck_submit_pr_review',
        origin: 'model',
        args: {},
      } as never,
      paths,
    );

    await expect(
      readPrReviewPerformance('review-1', paths),
    ).resolves.toMatchObject({
      review: {
        attemptId: 'attempt-1',
        headSha: 'head-sha',
        baseSha: 'base-sha',
        mergeBase: null,
      },
      correlation: {
        retainedObservationComplete: true,
        observedSubmissionQueued: true,
        metricsCoverage: 'anchored-best-effort',
        waveCorrelationAvailable: true,
      },
      models: {
        explore: { models: ['explore-model'], thinkingLevels: ['medium'] },
      },
      taskWaves: [
        {
          taskCount: 2,
          summedTaskDurationMs: 9_000,
          concurrencyEfficiency: expect.any(Number),
        },
      ],
      tasks: [
        { taskId: 'task-1', resultContract: true, stopReason: 'answered' },
        { taskId: 'task-2', resultContract: true, stopReason: 'answered' },
      ],
      turns: { child: 2 },
      usage: { child: { totalTokens: 30, cost: { total: 6 } } },
      taskBriefs: { allRequiredFieldsPresent: true },
      timings: {
        admittedToFirstParentTurnMs: 1_000,
        finalTaskToReviewSubmitMs: expect.any(Number),
      },
    });

    const response = await createActivityRoutes(paths).request(
      '/pr-reviews/review-1/performance',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: 'pr_review_performance_read',
      review: { reviewId: 'review-1', attemptId: 'attempt-1' },
      taskWaves: [{ taskCount: 2 }],
    });

    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `UPDATE activity_submissions SET event_count = event_count + 1
           WHERE submission_id = ?;`,
        )
        .run('submission-1');
    } finally {
      database.close();
    }
    await expect(
      readPrReviewPerformance('review-1', paths),
    ).resolves.toMatchObject({
      correlation: {
        retainedObservationComplete: false,
        observedSubmissionQueued: true,
        metricsCoverage: 'partial',
        retainedEventCount: 9,
        observedEventCount: 10,
      },
      taskWaves: null,
      tasks: null,
      turns: { parent: null, child: null },
      usage: { parent: null, child: null },
      repetition: {
        promptHashesWithinAttempt: null,
        repeatedWorkspaceQueries: null,
        parentReplaySignals: null,
      },
    });

    const incompleteDatabase = openDb(paths.neondeckDatabase);
    try {
      incompleteDatabase
        .prepare(
          `UPDATE activity_submissions SET event_count = event_count - 1
           WHERE submission_id = ?;`,
        )
        .run('submission-1');
      incompleteDatabase
        .prepare(
          `UPDATE activity_events SET event_type = 'log'
           WHERE submission_id = ? AND event_type = 'submission_queued';`,
        )
        .run('submission-1');
    } finally {
      incompleteDatabase.close();
    }
    await expect(
      readPrReviewPerformance('review-1', paths),
    ).resolves.toMatchObject({
      correlation: {
        retainedObservationComplete: true,
        observedSubmissionQueued: false,
        metricsCoverage: 'partial',
      },
      taskWaves: null,
      tasks: null,
      turns: { parent: null, child: null },
    });
  });

  it('returns incremental retained history in event order', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(2),
        type: 'operation_start',
        operationId: 'operation-1',
        operationKind: 'prompt',
      },
      paths,
    );
    await recordFlueObservation(
      {
        ...base(3),
        type: 'operation',
        operationId: 'operation-1',
        operationKind: 'prompt',
        durationMs: 25,
        isError: false,
      },
      paths,
    );

    const initial = await readActivitySubmissionEvents('submission-1', paths);
    expect(initial.events.map((event) => event.eventIndex)).toEqual([1, 2, 3]);
    const incremental = await readActivitySubmissionEvents(
      'submission-1',
      paths,
      { afterEventId: initial.events[0]?.id },
    );
    expect(incremental.events.map((event) => event.eventIndex)).toEqual([2, 3]);
    expect(incremental.totalEventCount).toBe(3);
  });

  it('orders cross-context events by emission time and never regresses the projection', async () => {
    const paths = await tempPaths();
    await recordFlueObservation(queued(1), paths);
    await recordFlueObservation(
      {
        ...base(1),
        timestamp: '2026-08-01T10:00:03.000Z',
        type: 'submission_running',
        kind: 'dispatch',
        attemptCount: 2,
        maxAttempts: 3,
      },
      paths,
    );
    await recordFlueObservation(
      {
        ...base(4),
        timestamp: '2026-08-01T10:00:04.000Z',
        type: 'submission_settled',
        outcome: 'completed',
      },
      paths,
    );
    await recordFlueObservation(
      {
        ...base(99),
        timestamp: '2026-08-01T10:00:02.000Z',
        type: 'submission_running',
        kind: 'dispatch',
        attemptCount: 1,
        maxAttempts: 3,
      },
      paths,
    );

    await expect(
      readActivitySubmission('submission-1', paths),
    ).resolves.toMatchObject({
      status: 'completed',
      attemptCount: 2,
      lastEventAt: '2026-08-01T10:00:04.000Z',
      lastMessage: 'Submission completed.',
    });
    const history = await readActivitySubmissionEvents('submission-1', paths);
    expect(history.events.map((event) => event.eventIndex)).toEqual([
      1, 99, 1, 4,
    ]);
  });
});

async function tempPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-activity-'));
  roots.push(root);
  return runtimePaths(root);
}

function base(eventIndex: number) {
  return {
    v: 3 as const,
    eventIndex,
    timestamp: `2026-08-01T10:00:0${eventIndex}.000Z`,
    submissionId: 'submission-1',
    agentName: 'display-assistant',
    instanceId: 'session-1',
    conversationId: 'conversation-1',
  } as const;
}

function queued(eventIndex: number) {
  return {
    ...base(eventIndex),
    type: 'submission_queued' as const,
    kind: 'dispatch' as const,
  };
}

async function ensureReviewBinding(paths: RuntimePaths) {
  await (await import('./runtime-home')).ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO pr_reviews (
      id, ref, repo_full_name, pr_number, title, pr_url, status, attempt_id,
      run_id, head_sha, base_sha, base_ref, origin, review_url, trust_boundary,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        'review-1',
        'example/project#1',
        'example/project',
        1,
        'Example',
        'https://example.test/pr/1',
        'ready',
        'attempt-1',
        'submission-1',
        'head-sha',
        'base-sha',
        'main',
        'api',
        '/reviews/review-1',
        'local only',
        '2026-08-01T10:00:00.000Z',
        '2026-08-01T10:00:09.000Z',
      );
  } finally {
    database.close();
  }
}
