/* eslint-disable no-unused-vars */
import type { DashboardConfig, GitHubPullRequest, GitHubQueueIssue, GitHubPullRequestResponse, RepoConfig, WorktreeLink, RepoRegistryResponse, RepoHealth, RepoHealthResponse, RuntimeHealth, ConfigChangeEvent, RuntimeStatusCheck, RuntimeStatus, ExecutionApproval, ExecutionApprovalsResponse, RepoEditEvent, RepoEditEventsResponse, WorktreeRecord, WorktreeLockRecord, WorktreeCleanupFailure, WorktreesResponse, KiloTaskStatus, KiloChildSessionNode, KiloNotificationFact, KiloResultPlaceholder, KiloTaskRecord, KiloTasksResponse, AutopilotMode, AutopilotPolicyLimits, AutopilotConcurrencyPolicy, AutopilotQueueItem, AutopilotRepoPolicy, AutopilotWatchPolicy, AutopilotPreparedDiff, AutopilotApproval, AutopilotRunningCheck, AutopilotActivity, AutopilotState, AutopilotRecoveryActionId, AutopilotRecoveryOption, AutopilotRecoveryResponse, ConfigActionResult, AgentModelUpdate, ProviderUpdate, NeonSessionRecord, ChatSessionKind, ChatSessionRecord, NeonSessionState, ChatSessionListResponse, ChatSessionMutationResponse, ChatSessionChangeEvent, WorkflowEventRecord, WorkflowObservability, WorkflowSummary, WorkflowSummaryResponse, SchedulerJob, SchedulerJobsResponse, MemoryScope, MemoryRecord, MemoryResponse, LearningWriteMode, LearningConfig, LearningReviewRecord, LearningCandidateStatus, LearningCandidate, LearningAuditEvent, LearningOperatorState, NotificationLevel, NotificationRecord, NotificationResponse, NotificationChangeEvent, SafetyClass, SafetyPolicyEntry, SafetyPolicy, RuntimeSkill, RuntimeSkillRoot, RuntimeSkillIssue, RuntimeSkillsResponse, NeonCommandResult, PrWatch, PrWatchResponse, HostMetrics } from './types';
import { getJson, postJson } from './http';

export async function getDashboardConfig() {
  return getJson<DashboardConfig>('/api/dashboard/config');
}

export async function updateDashboardConfig(input: DashboardConfig) {
  return postJson<ConfigActionResult>('/api/dashboard/config', input);
}

export async function applyDashboardPreset(input: {
  preset: 'classic' | 'cockpit';
  statuslinePosition?: 'top' | 'bottom';
}) {
  return postJson<ConfigActionResult>('/api/dashboard/preset', input);
}

export async function updateAgentModels(input: AgentModelUpdate) {
  return postJson<ConfigActionResult>('/api/models', input);
}

export async function updateProvider(provider: string, input: ProviderUpdate) {
  return postJson<ConfigActionResult>(`/api/providers/${provider}`, input);
}
