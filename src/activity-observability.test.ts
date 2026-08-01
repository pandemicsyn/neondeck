import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readActivityObservability,
  readActivitySubmission,
  readActivitySubmissionEvents,
  recordFlueObservation,
} from './modules/learning';
import { runtimePaths, type RuntimePaths } from './runtime-home';

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
