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

export async function getLearningOperatorState(
  input: {
    limit?: number;
    candidateStatus?: LearningCandidateStatus;
    candidateTarget?: 'memory' | 'skill';
  } = {},
) {
  return getJson<LearningOperatorState>(learningOperatorStateUrl(input));
}

export function learningOperatorStateUrl(
  input: {
    limit?: number;
    candidateStatus?: LearningCandidateStatus;
    candidateTarget?: 'memory' | 'skill';
  } = {},
) {
  const params = new URLSearchParams();
  if (input.candidateStatus) {
    params.set('candidateStatus', input.candidateStatus);
  }
  if (input.candidateTarget) {
    params.set('candidateTarget', input.candidateTarget);
  }
  if (input.limit) params.set('limit', String(input.limit));
  const query = params.toString();
  return `/api/learning/state${query ? `?${query}` : ''}`;
}

export async function decideLearningCandidate(
  id: string,
  decision: 'approve' | 'reject',
  reason?: string,
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/learning/candidates/${id}/${decision}`, {
    reason: reason || undefined,
  });
}

export async function restoreSkillPatch(id: string, reason?: string) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/skills/patches/${id}/restore`, {
    confirm: true,
    reason: reason || 'Dashboard skill patch restore.',
  });
}

export async function queueLearningReview(kind: 'conversation' | 'pr-batch') {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    runId?: string;
    message: string;
  }>(
    kind === 'conversation'
      ? '/api/learning/reviews/conversation'
      : '/api/learning/reviews/prs',
    { reason: 'Dashboard manual learning review.' },
  );
}
