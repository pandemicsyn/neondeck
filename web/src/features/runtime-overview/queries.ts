import type { QueryClient, UseQueryResult } from '@tanstack/react-query';
import type {
  ExecutionApprovalsResponse,
  KiloTasksResponse,
  MemoryResponse,
  McpApprovalsResponse,
  McpServersResponse,
  NotificationResponse,
  RepoEditEventsResponse,
  RepoHealthResponse,
  RepoRegistryResponse,
  RuntimeSkillsResponse,
  RuntimeStatus,
  SafetyPolicy,
  SchedulerJobsResponse,
  WorkflowObservability,
  WorktreesResponse,
} from '../../api';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import { emptySafetyPolicy, emptyWorkflows } from './lib/format';
import type { RuntimeSnapshot } from './types';

type RuntimeSnapshotQueries = {
  registry: UseQueryResult<RepoRegistryResponse>;
  repoHealth: UseQueryResult<RepoHealthResponse>;
  jobs: UseQueryResult<SchedulerJobsResponse>;
  skills: UseQueryResult<RuntimeSkillsResponse>;
  memories: UseQueryResult<MemoryResponse>;
  notifications: UseQueryResult<NotificationResponse>;
  executionApprovals: UseQueryResult<ExecutionApprovalsResponse>;
  mcpServers: UseQueryResult<McpServersResponse>;
  mcpApprovals: UseQueryResult<McpApprovalsResponse>;
  safety: UseQueryResult<SafetyPolicy>;
  workflows: UseQueryResult<WorkflowObservability>;
  kiloTasks: UseQueryResult<KiloTasksResponse>;
  repoEditEvents: UseQueryResult<RepoEditEventsResponse>;
  worktrees: UseQueryResult<WorktreesResponse>;
};

export function runtimeSnapshotFromQueries(
  status: RuntimeStatus,
  queries: RuntimeSnapshotQueries,
): RuntimeSnapshot {
  const errors = [
    queryResultError(queries.registry),
    queryResultError(queries.repoHealth),
    queryResultError(queries.jobs),
    queryResultError(queries.skills),
    queryResultError(queries.memories),
    queryResultError(queries.notifications),
    queryResultError(queries.executionApprovals),
    queryResultError(queries.mcpServers),
    queryResultError(queries.mcpApprovals),
    queryResultError(queries.safety),
    queryResultError(queries.workflows),
    queryResultError(queries.kiloTasks),
    queryResultError(queries.repoEditEvents),
    queryResultError(queries.worktrees),
  ].filter((error): error is string => !!error);

  return {
    status,
    repos: queries.registry.data?.repos ?? [],
    repoHealth: queries.repoHealth.data ?? {
      home: status.home,
      path: status.paths.repos,
      repos: [],
      attention: [],
      count: 0,
      fetchedAt: status.fetchedAt,
    },
    jobs: queries.jobs.data?.jobs ?? [],
    skills: queries.skills.data ?? {
      roots: [],
      skills: [],
      ignored: [],
      duplicates: [],
      loadedAt: status.fetchedAt,
    },
    memories: queries.memories.data?.memories ?? [],
    notifications: queries.notifications.data ?? {
      items: [],
      policy: {
        info: 'Passive updates.',
        ready: 'Completed work.',
        attention: 'Actionable failures.',
        urgent: 'Production-facing failures.',
        reconcile: 'Repeated source events are reconciled.',
        autopilot: 'Autopilot state changes create actionable notifications.',
        kilo: 'Kilo task state changes create delegated-work notifications.',
      },
      fetchedAt: status.fetchedAt,
    },
    executionApprovals: queries.executionApprovals.data ?? {
      ok: false,
      action: 'execution_approvals_list',
      changed: false,
      approvals: [],
      fetchedAt: status.fetchedAt,
    },
    mcpServers: queries.mcpServers.data ?? {
      ok: false,
      action: 'mcp_servers_list',
      changed: false,
      message: 'MCP server status unavailable.',
      servers: [],
    },
    mcpApprovals: queries.mcpApprovals.data ?? {
      ok: false,
      action: 'mcp_approvals_list',
      changed: false,
      message: 'MCP approvals unavailable.',
      approvals: [],
    },
    safety: queries.safety.data ?? emptySafetyPolicy(status.fetchedAt),
    workflows: queries.workflows.data ?? emptyWorkflows(),
    kiloTasks: queries.kiloTasks.data ?? {
      ok: false,
      action: 'kilo_tasks_list',
      changed: false,
      message: 'Kilo tasks unavailable.',
      tasks: [],
      fetchedAt: status.fetchedAt,
    },
    repoEditEvents: queries.repoEditEvents.data ?? {
      ok: false,
      action: 'repo_edit_events_list',
      changed: false,
      message: 'Repo edit events unavailable.',
      events: [],
      fetchedAt: status.fetchedAt,
    },
    worktrees: queries.worktrees.data ?? {
      ok: false,
      action: 'worktrees_list',
      changed: false,
      message: 'Worktrees unavailable.',
      worktrees: [],
      activeLocks: [],
      staleLocks: [],
      cleanupFailures: [],
      fetchedAt: status.fetchedAt,
    },
    secondaryErrors: errors,
    fetchedAt: new Date().toISOString(),
  };
}

function queryResultError(result: { error: unknown }) {
  return result.error ? queryErrorMessage(result.error) : undefined;
}

export async function invalidateRuntimeQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoRegistry }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoHealth }),
    queryClient.invalidateQueries({ queryKey: queryKeys.schedulerJobs }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeSkills }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.workflowObservability,
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.kiloTasks }),
    queryClient.invalidateQueries({ queryKey: queryKeys.memories }),
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
    queryClient.invalidateQueries({ queryKey: queryKeys.executionApprovals }),
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers }),
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpApprovals }),
    queryClient.invalidateQueries({ queryKey: queryKeys.safetyPolicy }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoEditEvents }),
    queryClient.invalidateQueries({ queryKey: queryKeys.worktrees }),
  ]);
}
