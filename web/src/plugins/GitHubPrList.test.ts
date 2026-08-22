import { describe, expect, it } from 'vitest';
import type { ActivityObservability } from '../api';
import {
  isTerminalWatchStatus,
  neonReviewActionLabel,
  prDiffActionLabel,
  reviewWorkflowCompletionState,
  reviewWorkflowRefreshDecision,
} from './GitHubPrList';

describe('GitHubPrList review workflow state', () => {
  it('distinguishes viewing the diff from running Neon review', () => {
    expect(prDiffActionLabel(false)).toBe('view diff');
    expect(prDiffActionLabel(true)).toBe('hide diff');
    expect(neonReviewActionLabel()).toBe('run review');
  });

  it('treats green PR watches as terminal for dashboard re-watch affordances', () => {
    expect(isTerminalWatchStatus('green')).toBe(true);
    expect(isTerminalWatchStatus('merged')).toBe(true);
    expect(isTerminalWatchStatus('closed')).toBe(true);
    expect(isTerminalWatchStatus('watching')).toBe(false);
  });

  it('refreshes when an admitted review submission settles', () => {
    expect(
      reviewWorkflowCompletionState(
        activityObservability({
          recentSettlements: [
            workflowEvent({
              submissionId: 'run-review',
              eventType: 'submission_settled',
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
        activityObservability(),
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
        activityObservability({
          activeSubmissions: [
            {
              submissionId: 'run-review',
              kind: 'dispatch',
              agentName: 'review-pr-for-human',
              instanceId: 'review-1',
              status: 'running',
              queuedAt: '2026-07-05T19:59:59.000Z',
              startedAt: '2026-07-05T20:00:00.000Z',
              lastEventAt: '2026-07-05T20:00:10.000Z',
              lastMessage: 'Running review.',
              eventCount: 2,
              attemptCount: 1,
              detailUrl: '/activity?submissionId=run-review',
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

  it('does not use fallback refresh while the admitted review run is active', () => {
    expect(
      reviewWorkflowRefreshDecision(
        activityObservability({
          activeSubmissions: [
            {
              submissionId: 'run-review',
              kind: 'dispatch',
              agentName: 'review-pr-for-human',
              instanceId: 'review-1',
              status: 'running',
              queuedAt: '2026-07-05T19:59:59.000Z',
              startedAt: '2026-07-05T20:00:00.000Z',
              lastEventAt: '2026-07-05T20:00:10.000Z',
              lastMessage: 'Running review.',
              eventCount: 2,
              attemptCount: 1,
              detailUrl: '/activity?submissionId=run-review',
            },
          ],
        }),
        'run-review',
        true,
        true,
      ),
    ).toEqual({
      terminal: false,
      sawActiveRun: true,
      shouldRefresh: false,
      done: false,
    });
  });

  it('uses fallback refresh when the admitted run was never observed', () => {
    expect(
      reviewWorkflowRefreshDecision(
        activityObservability(),
        'run-review',
        false,
        true,
      ),
    ).toEqual({
      terminal: false,
      sawActiveRun: false,
      shouldRefresh: true,
      done: true,
    });
  });
});

function activityObservability(
  overrides: Partial<ActivityObservability> = {},
): ActivityObservability {
  return {
    ok: true,
    action: 'activity_observability_read',
    activeSubmissions: [],
    recentFailures: [],
    recentSettlements: [],
    recentLogs: [],
    recentTools: [],
    recentOperations: [],
    recentEvents: [],
    fetchedAt: '2026-07-05T20:01:00.000Z',
    ...overrides,
  };
}

function workflowEvent(
  overrides: Partial<ActivityObservability['recentEvents'][number]> = {},
): ActivityObservability['recentEvents'][number] {
  return {
    id: 1,
    submissionId: 'run-review',
    eventType: 'submission_settled',
    eventIndex: 2,
    level: null,
    message: 'Workflow completed.',
    name: 'review-pr-for-human',
    operationKind: null,
    operationId: null,
    agentName: 'review-pr-for-human',
    instanceId: null,
    conversationId: null,
    durationMs: 120_000,
    isError: false,
    summary: null,
    createdAt: '2026-07-05T20:02:00.000Z',
    detailUrl: '/activity?submissionId=run-review',
    ...overrides,
  };
}
