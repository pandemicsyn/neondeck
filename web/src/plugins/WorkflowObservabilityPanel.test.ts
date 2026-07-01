import { describe, expect, it } from 'vitest';
import type { WorkflowEventRecord, WorkflowObservability } from '../api';
import { workflowDrilldownItems } from './WorkflowObservabilityPanel';

describe('workflow observability drilldown', () => {
  it('dedupes categorized events while preserving filter-specific active runs', () => {
    const failure = event({
      id: 1,
      eventType: 'workflow:error',
      isError: true,
    });
    const progress = event({
      id: 2,
      eventType: 'run_end',
      message: 'Workflow completed in 1.2s.',
    });
    const log = event({ id: 3, eventType: 'log', message: 'called action' });
    const workflows: WorkflowObservability = {
      ok: true,
      action: 'workflow_observability_read',
      activeRuns: [
        {
          runId: 'run-active',
          workflow: 'command-run',
          startedAt: '2026-06-27T10:00:00.000Z',
          lastEventAt: '2026-06-27T10:04:00.000Z',
          lastMessage: 'running /review-queue',
          eventCount: 4,
          runUrl: '/api/flue/runs/run-active?meta',
        },
      ],
      recentFailures: [failure],
      recentData: [progress],
      recentLogs: [log],
      recentTools: [],
      recentOperations: [],
      recentEvents: [failure, progress, log],
      fetchedAt: '2026-06-27T10:05:00.000Z',
    };

    const all = workflowDrilldownItems(workflows, 'all');
    expect(all).toHaveLength(4);
    expect(all.map((item) => item.id)).toEqual([
      'active:run-active',
      'activity:3',
      'progress:2',
      'failed:1',
    ]);

    const progressOnly = workflowDrilldownItems(workflows, 'progress');
    expect(progressOnly).toHaveLength(1);
    expect(progressOnly[0]?.message).toBe('Workflow completed in 1.2s.');
  });
});

function event(
  overrides: Partial<WorkflowEventRecord> & Pick<WorkflowEventRecord, 'id'>,
): WorkflowEventRecord {
  return {
    id: overrides.id,
    runId: overrides.runId ?? 'run-1',
    workflow: overrides.workflow ?? 'command-run',
    eventType: overrides.eventType ?? 'log',
    eventIndex: overrides.eventIndex ?? overrides.id,
    level: overrides.level ?? 'info',
    message: overrides.message ?? 'event message',
    name: overrides.name ?? null,
    operationKind: overrides.operationKind ?? null,
    operationId: overrides.operationId ?? null,
    durationMs: overrides.durationMs ?? null,
    isError: overrides.isError ?? false,
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? `2026-06-27T10:0${overrides.id}:00.000Z`,
    runUrl: overrides.runUrl ?? '/api/flue/runs/run-1?meta',
  };
}
