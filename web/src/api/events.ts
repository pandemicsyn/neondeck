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

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/config');
  source.addEventListener('config-change', (event) => {
    parseEventData('config-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/notifications');
  source.addEventListener('notification-change', (event) => {
    parseEventData('notification-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/sessions');
  source.addEventListener('chat-session-change', (event) => {
    parseEventData('chat-session-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

function parseEventData<T>(
  eventName: string,
  event: MessageEvent,
  onEvent: (event: T) => void,
  onError?: (error?: Error | Event) => void,
) {
  try {
    onEvent(JSON.parse(event.data) as T);
  } catch (cause) {
    const error = new Error(
      `Invalid ${eventName} event payload: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    if (onError) onError(error);
    else console.warn(error.message);
  }
}
