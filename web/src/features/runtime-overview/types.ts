import type {
  ExecutionApprovalsResponse,
  KiloTasksResponse,
  MemoryRecord,
  McpApprovalsResponse,
  McpServersResponse,
  NotificationResponse,
  RepoConfig,
  RepoEditEventsResponse,
  RepoHealthResponse,
  RuntimeSkillsResponse,
  RuntimeStatus,
  SafetyPolicy,
  ScheduledTask,
  WorkflowObservability,
  WorktreesResponse,
} from '../../api';

export type RuntimeOverviewConfig = {
  repoLimit: number;
  jobLimit: number;
  skillLimit: number;
  memoryLimit: number;
  notificationLimit: number;
  workflowEventLimit: number;
  repoEditLimit: number;
  mcpLimit: number;
};

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  repos: RepoConfig[];
  repoHealth: RepoHealthResponse;
  jobs: ScheduledTask[];
  skills: RuntimeSkillsResponse;
  memories: MemoryRecord[];
  notifications: NotificationResponse;
  executionApprovals: ExecutionApprovalsResponse;
  mcpServers: McpServersResponse;
  mcpApprovals: McpApprovalsResponse;
  safety: SafetyPolicy;
  workflows: WorkflowObservability;
  kiloTasks: KiloTasksResponse;
  repoEditEvents: RepoEditEventsResponse;
  worktrees: WorktreesResponse;
  secondaryErrors: string[];
  fetchedAt: string;
};

export type SetupStep = {
  action: string;
  docsHref: string;
  docsLabel: string;
  surface: string;
  detail: string;
};

export const runtimeOverviewDefaultConfig = {
  repoLimit: 5,
  jobLimit: 5,
  skillLimit: 5,
  memoryLimit: 5,
  notificationLimit: 5,
  workflowEventLimit: 6,
  repoEditLimit: 5,
  mcpLimit: 5,
};
