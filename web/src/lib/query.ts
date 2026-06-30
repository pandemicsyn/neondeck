import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  dashboardConfig: ['dashboard-config'] as const,
  executionApprovals: ['execution-approvals'] as const,
  githubPrs: ['github-prs'] as const,
  hostMetrics: ['host-metrics'] as const,
  memories: ['memories'] as const,
  neonSession: ['neon-session'] as const,
  chatSessions: ['chat-sessions'] as const,
  prWatches: ['pr-watches'] as const,
  repoHealth: ['repo-health'] as const,
  repoEditEvents: ['repo-edit-events'] as const,
  repoRegistry: ['repo-registry'] as const,
  runtimeStatus: ['runtime-status'] as const,
  runtimeSkills: ['runtime-skills'] as const,
  safetyPolicy: ['safety-policy'] as const,
  schedulerJobs: ['scheduler-jobs'] as const,
  subagents: ['subagents'] as const,
  notifications: ['notifications'] as const,
  workflowObservability: ['workflow-observability'] as const,
  workflowSummaries: ['workflow-summaries'] as const,
  worktrees: ['worktrees'] as const,
};

export function queryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
