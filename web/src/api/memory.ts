/* eslint-disable no-unused-vars */
import type { GitHubPullRequest, GitHubQueueIssue, GitHubPullRequestResponse, RepoConfig, WorktreeLink, RepoRegistryResponse, RepoHealth, RepoHealthResponse, RuntimeHealth, ConfigChangeEvent, RuntimeStatusCheck, RuntimeStatus, ExecutionApproval, ExecutionApprovalsResponse, RepoEditEvent, RepoEditEventsResponse, WorktreeRecord, WorktreeLockRecord, WorktreeCleanupFailure, WorktreesResponse, KiloTaskStatus, KiloChildSessionNode, KiloNotificationFact, KiloResultPlaceholder, KiloTaskRecord, KiloTasksResponse, AutopilotMode, AutopilotPolicyLimits, AutopilotConcurrencyPolicy, AutopilotQueueItem, AutopilotRepoPolicy, AutopilotWatchPolicy, AutopilotPreparedDiff, AutopilotApproval, AutopilotRunningCheck, AutopilotActivity, AutopilotState, AutopilotRecoveryActionId, AutopilotRecoveryOption, AutopilotRecoveryResponse, ConfigActionResult, AgentModelUpdate, ProviderUpdate, NeonSessionRecord, ChatSessionKind, ChatSessionRecord, NeonSessionState, ChatSessionListResponse, ChatSessionMutationResponse, ChatSessionChangeEvent, WorkflowEventRecord, WorkflowObservability, WorkflowSummary, WorkflowSummaryResponse, SchedulerJob, SchedulerJobsResponse, MemoryScope, MemoryRecord, MemoryResponse, LearningWriteMode, LearningConfig, LearningReviewRecord, LearningCandidateStatus, LearningCandidate, LearningAuditEvent, LearningOperatorState, NotificationLevel, NotificationRecord, NotificationResponse, NotificationChangeEvent, SafetyClass, SafetyPolicyEntry, SafetyPolicy, RuntimeSkill, RuntimeSkillRoot, RuntimeSkillIssue, RuntimeSkillsResponse, NeonCommandResult, PrWatch, PrWatchResponse, HostMetrics } from './types';
import { getJson, postJson } from './http';

export async function getMemories(
  input: {
    scope?: MemoryScope;
    status?: 'active' | 'archived';
    includeArchived?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', input.scope);
  if (input.status) params.set('status', input.status);
  if (input.includeArchived) params.set('includeArchived', 'true');
  const query = params.toString();
  return getJson<MemoryResponse>(`/api/memories${query ? `?${query}` : ''}`);
}

export async function upsertMemory(input: {
  scope: 'user' | 'local' | 'project';
  key: string;
  value: unknown;
  repoId?: string;
  reason?: string;
}) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    memory?: MemoryRecord;
    errors?: string[];
    requires?: string[];
  }>('/api/memories', input);
}
