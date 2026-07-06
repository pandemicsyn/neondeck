import { describe, expect, it } from 'vitest';
import type { WorkflowObservability } from '../api';
import { reviewWorkflowCompletionState } from './GitHubPrList';

describe('GitHubPrList review workflow state', () => {
  it('refreshes when an admitted review run reaches terminal observability', () => {
    expect(
      reviewWorkflowCompletionState(
        workflowObservability({
          recentData: [
            workflowEvent({
              runId: 'run-review',
              eventType: 'run_end',
              isError: false,
            }),
          ],
        }),
        'run-review',
        false,
      ),
    ).toEqual({
      terminal: true,
      sawActiveRun: false,
      shouldRefresh: true,
    });
  });

  it('refreshes when a previously active review run disappears', () => {
    expect(
      reviewWorkflowCompletionState(
        workflowObservability(),
        'run-review',
        true,
      ),
    ).toEqual({
      terminal: false,
      sawActiveRun: true,
      shouldRefresh: true,
    });
  });

  it('keeps observing while the admitted review run is active', () => {
    expect(
      reviewWorkflowCompletionState(
        workflowObservability({
          activeRuns: [
            {
              runId: 'run-review',
              workflow: 'review-pr-for-human',
              startedAt: '2026-07-05T20:00:00.000Z',
              lastEventAt: '2026-07-05T20:00:10.000Z',
              lastMessage: 'Running review.',
              eventCount: 2,
              runUrl: '/api/flue/runs/run-review',
            },
          ],
        }),
        'run-review',
        false,
      ),
    ).toEqual({
      terminal: false,
      sawActiveRun: true,
      shouldRefresh: false,
    });
  });
});

function workflowObservability(
  overrides: Partial<WorkflowObservability> = {},
): WorkflowObservability {
  return {
    ok: true,
    action: 'workflow_observability_read',
    activeRuns: [],
    recentFailures: [],
    recentData: [],
    recentLogs: [],
    recentTools: [],
    recentOperations: [],
    recentEvents: [],
    fetchedAt: '2026-07-05T20:01:00.000Z',
    ...overrides,
  };
}

function workflowEvent(
  overrides: Partial<WorkflowObservability['recentEvents'][number]> = {},
): WorkflowObservability['recentEvents'][number] {
  return {
    id: 1,
    runId: 'run-review',
    workflow: 'review-pr-for-human',
    eventType: 'run_end',
    eventIndex: 2,
    level: null,
    message: 'Workflow completed.',
    name: 'review-pr-for-human',
    operationKind: null,
    operationId: null,
    durationMs: 120_000,
    isError: false,
    summary: null,
    createdAt: '2026-07-05T20:02:00.000Z',
    runUrl: '/api/flue/runs/run-review',
    ...overrides,
  };
}
