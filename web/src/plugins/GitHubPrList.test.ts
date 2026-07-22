import { describe, expect, it } from 'vitest';
import type { GitHubPullRequest, WorkflowObservability } from '../api';
import {
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

  it('does not use fallback refresh while the admitted review run is active', () => {
    expect(
      reviewWorkflowRefreshDecision(
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
        workflowObservability(),
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
