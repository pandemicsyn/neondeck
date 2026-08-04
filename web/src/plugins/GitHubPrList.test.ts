import { describe, expect, it } from 'vitest';
import type { GitHubPullRequest, ActivityObservability } from '../api';
import {
  ciFixOperationRefreshDecision,
  isCiFixCandidate,
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

  it('shows the fix CI affordance only for failing or unknown check states', () => {
    expect(isCiFixCandidate(githubPr({ checks: 'failure' }))).toBe(true);
    expect(isCiFixCandidate(githubPr({ checkError: 'token denied' }))).toBe(
      true,
    );
    expect(isCiFixCandidate(githubPr({ checks: 'success' }))).toBe(false);
    expect(isCiFixCandidate(githubPr({ checks: 'pending' }))).toBe(false);
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

  it('tracks CI fixes through app-owned operation summaries, not submission ids', () => {
    const running = ciFixOperationRefreshDecision(
      {
        items: [
          {
            id: 'operation-1',
            workflow: 'ci_fix_run',
            runId: 'legacy-workflow-run',
            status: 'running',
            summary: { pr: 'pandemicsyn/neondeck#123' },
            createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-08-01T10:00:00.000Z',
          },
        ],
        fetchedAt: '2026-08-01T10:00:01.000Z',
      },
      'operation-1',
      false,
      false,
    );
    expect(running).toEqual({
      terminal: false,
      sawActiveOperation: true,
      shouldRefresh: false,
      done: false,
    });

    expect(
      ciFixOperationRefreshDecision(
        {
          items: [
            {
              id: 'operation-1',
              workflow: 'ci_fix_run',
              runId: 'legacy-workflow-run',
              status: 'completed',
              summary: { pr: 'pandemicsyn/neondeck#123' },
              createdAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-08-01T10:05:00.000Z',
            },
          ],
          fetchedAt: '2026-08-01T10:05:01.000Z',
        },
        'operation-1',
        true,
        false,
      ),
    ).toEqual({
      terminal: true,
      sawActiveOperation: true,
      shouldRefresh: true,
      done: true,
    });
  });

  it('keeps concurrent CI-fix pollers bound to their admitted operation', () => {
    const decision = ciFixOperationRefreshDecision(
      {
        items: [
          {
            id: 'newer-operation',
            workflow: 'ci_fix_run',
            runId: null,
            status: 'completed',
            summary: { pr: 'pandemicsyn/neondeck#123' },
            createdAt: '2026-08-01T10:01:00.000Z',
            updatedAt: '2026-08-01T10:02:00.000Z',
          },
          {
            id: 'admitted-operation',
            workflow: 'ci_fix_run',
            runId: null,
            status: 'running',
            summary: { pr: 'pandemicsyn/neondeck#123' },
            createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-08-01T10:03:00.000Z',
          },
        ],
        fetchedAt: '2026-08-01T10:03:01.000Z',
      },
      'admitted-operation',
      false,
      false,
    );

    expect(decision).toEqual({
      terminal: false,
      sawActiveOperation: true,
      shouldRefresh: false,
      done: false,
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

function githubPr(
  overrides: Omit<Partial<GitHubPullRequest>, 'checks'> & {
    checks?: NonNullable<GitHubPullRequest['checks']>['status'];
  } = {},
): GitHubPullRequest {
  const checks: GitHubPullRequest['checks'] =
    overrides.checks === undefined
      ? null
      : {
          status: overrides.checks,
          total: 2,
          successful: overrides.checks === 'success' ? 2 : 1,
          failed: overrides.checks === 'failure' ? 1 : 0,
          pending: overrides.checks === 'pending' ? 1 : 0,
          statusContexts: 0,
          checkedAt: '2026-07-05T20:00:00.000Z',
        };
  return {
    id: 1,
    title: 'Add thing',
    repo: 'pandemicsyn/neondeck',
    number: 10,
    url: 'https://github.com/pandemicsyn/neondeck/pull/10',
    state: 'open',
    author: 'pandemicsyn',
    labels: [],
    comments: 0,
    updatedAt: '2026-07-05T20:00:00.000Z',
    createdAt: '2026-07-05T19:00:00.000Z',
    relations: ['configured-repo'],
    ageDays: 0,
    stale: false,
    headSha: 'abc123',
    baseRef: 'main',
    ...overrides,
    checks,
  };
}
