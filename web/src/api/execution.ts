/* eslint-disable no-unused-vars */
import type {
  GitHubPullRequest,
  GitHubQueueIssue,
  GitHubPullRequestResponse,
  RepoConfig,
  WorktreeLink,
  RepoRegistryResponse,
  RepoHealth,
  RepoHealthResponse,
  RuntimeHealth,
  ConfigChangeEvent,
  RuntimeStatusCheck,
  RuntimeStatus,
  ExecutionApproval,
  ExecutionApprovalsResponse,
  RepoEditEvent,
  RepoEditEventsResponse,
  WorktreeRecord,
  WorktreeLockRecord,
  WorktreeCleanupFailure,
  WorktreesResponse,
  KiloTaskStatus,
  KiloChildSessionNode,
  KiloNotificationFact,
  KiloResultPlaceholder,
  KiloTaskRecord,
  KiloTasksResponse,
  AutopilotMode,
  AutopilotPolicyLimits,
  AutopilotConcurrencyPolicy,
  AutopilotQueueItem,
  AutopilotRepoPolicy,
  AutopilotWatchPolicy,
  AutopilotPreparedDiff,
  AutopilotApproval,
  AutopilotRunningCheck,
  AutopilotActivity,
  AutopilotState,
  AutopilotRecoveryActionId,
  AutopilotRecoveryOption,
  AutopilotRecoveryResponse,
  ConfigActionResult,
  AgentModelUpdate,
  ProviderUpdate,
  NeonSessionRecord,
  ChatSessionKind,
  ChatSessionRecord,
  NeonSessionState,
  ChatSessionListResponse,
  ChatSessionMutationResponse,
  ChatSessionChangeEvent,
  WorkflowEventRecord,
  WorkflowObservability,
  WorkflowSummary,
  WorkflowSummaryResponse,
  SchedulerJob,
  SchedulerJobsResponse,
  MemoryScope,
  MemoryRecord,
  MemoryResponse,
  LearningWriteMode,
  LearningConfig,
  LearningReviewRecord,
  LearningCandidateStatus,
  LearningCandidate,
  LearningAuditEvent,
  LearningOperatorState,
  NotificationLevel,
  NotificationRecord,
  NotificationResponse,
  NotificationChangeEvent,
  SafetyClass,
  SafetyPolicyEntry,
  SafetyPolicy,
  RuntimeSkill,
  RuntimeSkillRoot,
  RuntimeSkillIssue,
  RuntimeSkillsResponse,
  NeonCommandResult,
  PrWatch,
  PrWatchResponse,
  HostMetrics,
} from './types';
import { getJson, postJson } from './http';

export async function getExecutionApprovals(
  input: { includeResolved?: boolean } = {},
) {
  const query = input.includeResolved ? '?includeResolved=1' : '';
  return getJson<ExecutionApprovalsResponse>(
    `/api/execution/approvals${query}`,
  );
}

export async function resolveExecutionApproval(
  id: string,
  decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny',
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    approval?: ExecutionApproval;
  }>(`/api/execution/approvals/${id}/resolve`, {
    decision,
    approverSurface: 'dashboard',
  });
}
