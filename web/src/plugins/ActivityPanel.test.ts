import { describe, expect, it } from 'vitest';
import type { ActivityEventRecord, ActivityObservability } from '../api';
import { activityItems } from './ActivityPanel';

describe('activity drilldown', () => {
  it('keeps the all feed submission-level and reserves raw events for activity', () => {
    const failure = event({
      id: 1,
      eventType: 'submission_settled',
      isError: true,
    });
    const progress = event({
      id: 2,
      eventType: 'submission_settled',
      message: 'Submission completed.',
      agentName: 'command-run',
    });
    const log = event({
      id: 3,
      eventType: 'log',
      message: 'called action',
      agentName: 'pr-autopilot-owner',
      instanceId: 'pr-owner-42',
    });
    const workflows: ActivityObservability = {
      ok: true,
      action: 'activity_observability_read',
      activeSubmissions: [
        {
          submissionId: 'run-active',
          kind: 'dispatch',
          agentName: 'command-run',
          instanceId: 'command-1',
          status: 'running',
          queuedAt: '2026-06-27T09:59:59.000Z',
          startedAt: '2026-06-27T10:00:00.000Z',
          lastEventAt: '2026-06-27T10:04:00.000Z',
          lastMessage: 'running /review-queue',
          eventCount: 4,
          attemptCount: 1,
          detailUrl: '/activity?submissionId=run-active',
        },
      ],
      recentFailures: [failure],
      recentSettlements: [progress],
      recentLogs: [log],
      recentTools: [],
      recentOperations: [],
      recentEvents: [failure, progress, log],
      fetchedAt: '2026-06-27T10:05:00.000Z',
    };

    const all = activityItems(workflows, 'all', [
      {
        ownerInstanceId: 'pr-owner-42',
        repoFullName: 'owner/repo',
        prNumber: 42,
      },
    ]);
    expect(all).toHaveLength(3);
    expect(all.map((item) => item.id)).toEqual([
      'active:run-active',
      'settled:2',
      'failed:1',
    ]);
    expect(all.some((item) => item.id === 'activity:3')).toBe(false);

    const activityOnly = activityItems(workflows, 'activity', [
      {
        ownerInstanceId: 'pr-owner-42',
        repoFullName: 'owner/repo',
        prNumber: 42,
      },
    ]);
    expect(activityOnly).toHaveLength(3);
    expect(
      activityOnly.find((item) => item.id === 'activity:3')?.contextLabel,
    ).toBe('owner/repo#42 · PR owner');
    expect(all.find((item) => item.id === 'settled:2')?.contextLabel).toBe(
      'command-run',
    );

    const settledOnly = activityItems(workflows, 'settled');
    expect(settledOnly).toHaveLength(1);
    expect(settledOnly[0]?.message).toBe('Submission completed.');
  });
});

function event(
  overrides: Partial<ActivityEventRecord> & Pick<ActivityEventRecord, 'id'>,
): ActivityEventRecord {
  return {
    id: overrides.id,
    submissionId: overrides.submissionId ?? 'run-1',
    eventType: overrides.eventType ?? 'log',
    eventIndex: overrides.eventIndex ?? overrides.id,
    level: overrides.level ?? 'info',
    message: overrides.message ?? 'event message',
    name: overrides.name ?? null,
    operationKind: overrides.operationKind ?? null,
    operationId: overrides.operationId ?? null,
    agentName: overrides.agentName ?? null,
    instanceId: overrides.instanceId ?? null,
    conversationId: overrides.conversationId ?? null,
    durationMs: overrides.durationMs ?? null,
    isError: overrides.isError ?? false,
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? `2026-06-27T10:0${overrides.id}:00.000Z`,
    detailUrl: overrides.detailUrl ?? '/activity?submissionId=run-1',
  };
}
