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

export async function getAutopilotState() {
  return getJson<AutopilotState>('/api/autopilot/state');
}

export async function getAutopilotRecoveryOptions(preparedDiffId: string) {
  return getJson<AutopilotRecoveryResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/recovery`,
  );
}

export async function runAutopilotRecovery(input: {
  preparedDiffId: string;
  recoveryAction: AutopilotRecoveryActionId;
  reason?: string;
  confirm?: boolean;
  checks?: string[];
  headRef?: string;
  headSha?: string;
  fetch?: boolean;
  dryRun?: boolean;
}) {
  const { preparedDiffId, ...body } = input;
  return postJson<AutopilotRecoveryResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/recovery/run`,
    body,
  );
}
