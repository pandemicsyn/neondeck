import * as v from 'valibot';
import type { AutopilotMode } from '../../autopilot-policy';

export const autopilotAdmissionStates = [
  'triage-admitted',
  'triaged',
  'prepare-admitted',
  'prepared',
  'owner-turn-admitted',
  'owner-turn-running',
  'fix-prepared',
  'verify-admitted',
  'verified',
  'approval-pending',
  'push-admitted',
  'pushed',
  'comment-admitted',
  'completed',
  'cleanup-pending',
  'archived',
  'blocked',
  'manual-review',
  'failed',
  'stopped',
  'superseded',
] as const;

export const autopilotOwnerStatuses = [
  'awaiting-event',
  'active',
  'draining',
  'archived',
  'failed',
] as const;

export const autopilotStages = [
  'triage',
  'prepare-worktree',
  'owner-turn',
  'verify',
  'push',
  'comment-result',
  'cleanup',
] as const;

export const autopilotStageAttemptStatuses = [
  'reserved',
  'running',
  'completed',
  'blocked',
  'failed',
  'cancelled',
] as const;

export const autopilotAdmissionStateSchema = v.picklist(
  autopilotAdmissionStates,
);
export const autopilotOwnerStatusSchema = v.picklist(autopilotOwnerStatuses);
export const autopilotStageSchema = v.picklist(autopilotStages);
export const autopilotStageAttemptStatusSchema = v.picklist(
  autopilotStageAttemptStatuses,
);
export const autopilotRetryClassSchema = v.picklist([
  'transient',
  'permanent',
  'uncertain',
]);
export const autopilotStageOutcomeSchema = v.object({
  stage: autopilotStageSchema,
  result: v.picklist(['completed', 'failed', 'blocked', 'cancelled']),
  retryClass: v.optional(autopilotRetryClassSchema),
  concurrencyWaitCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  retryStage: v.optional(autopilotStageSchema),
  resumeState: v.optional(autopilotAdmissionStateSchema),
  shouldPrepare: v.optional(v.boolean()),
  worktreeId: v.optional(v.string()),
  preparedDiffId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  message: v.optional(v.string()),
  artifact: v.optional(v.record(v.string(), v.unknown())),
});
export const autopilotTerminalObservationSchema = v.object({
  workflow: v.string(),
  failed: v.boolean(),
  shouldPrepare: v.optional(v.boolean()),
  worktreeId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  error: v.optional(v.string()),
  artifact: v.optional(v.record(v.string(), v.unknown())),
});

export type AutopilotAdmissionState = v.InferOutput<
  typeof autopilotAdmissionStateSchema
>;
export type AutopilotOwnerStatus = v.InferOutput<
  typeof autopilotOwnerStatusSchema
>;
export type AutopilotStage = v.InferOutput<typeof autopilotStageSchema>;
export type AutopilotStageAttemptStatus = v.InferOutput<
  typeof autopilotStageAttemptStatusSchema
>;

export type AutopilotPrOwner = {
  id: string;
  watchId: string;
  repoId: string;
  prNumber: number;
  flueAgent: string;
  flueInstanceId: string | null;
  chatSessionId: string | null;
  worktreeId: string | null;
  generation: number;
  groundingConfigHistoryId: number;
  groundingMemoryEventAt: string | null;
  groundingMemoryEventId: string | null;
  groundingMemoryEventRowId: number;
  groundingMemoryIds: string[];
  status: AutopilotOwnerStatus;
  currentHeadSha: string | null;
  lastDispatchedSequence: number;
  lastSettledSequence: number;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type AutopilotAdmission = {
  id: string;
  ownerId: string;
  watchId: string;
  eventFingerprint: string;
  eventSequence: number;
  repoId: string;
  prNumber: number;
  mode: AutopilotMode;
  input: Record<string, unknown>;
  state: AutopilotAdmissionState;
  priority: number;
  currentWorkflow: string | null;
  currentRunId: string | null;
  currentStageAttemptId: string | null;
  worktreeId: string | null;
  preparedDiffId: string | null;
  fixerKind: 'neon-owner' | 'kilo' | null;
  version: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastOutcome: AutopilotStageOutcome | null;
  stopRequestedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutopilotStageAttempt = {
  id: string;
  admissionId: string;
  ownerId: string;
  stage: AutopilotStage;
  attemptNumber: number;
  workflow: string | null;
  runId: string | null;
  flueInstanceId: string | null;
  ownerGeneration: number | null;
  eventSequence: number | null;
  dispatchId: string | null;
  status: AutopilotStageAttemptStatus;
  inputFingerprint: string;
  artifact: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AutopilotAdmissionEvent = {
  id: number;
  admissionId: string;
  fromState: AutopilotAdmissionState | null;
  toState: AutopilotAdmissionState;
  reason: string;
  workflow: string | null;
  runId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
};

export type AutopilotStageOutcome = v.InferOutput<
  typeof autopilotStageOutcomeSchema
>;

export type AutopilotTerminalObservation = v.InferOutput<
  typeof autopilotTerminalObservationSchema
>;

export function readAutopilotAdmission(row: unknown) {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  const state = v.safeParse(autopilotAdmissionStateSchema, value.state);
  if (!state.success) return undefined;
  return {
    id: String(value.id),
    ownerId: String(value.owner_id),
    watchId: String(value.watch_id),
    eventFingerprint: String(value.event_fingerprint),
    eventSequence: Number(value.event_sequence),
    repoId: String(value.repo_id),
    prNumber: Number(value.pr_number),
    mode: value.mode as AutopilotMode,
    input: readJsonRecord(value.input_json),
    state: state.output,
    priority: Number(value.priority ?? 0),
    currentWorkflow: nullableString(value.current_workflow),
    currentRunId: nullableString(value.current_run_id),
    currentStageAttemptId: nullableString(value.current_stage_attempt_id),
    worktreeId: nullableString(value.worktree_id),
    preparedDiffId: nullableString(value.prepared_diff_id),
    fixerKind:
      value.fixer_kind === 'neon-owner' || value.fixer_kind === 'kilo'
        ? value.fixer_kind
        : null,
    version: Number(value.version),
    attemptCount: Number(value.attempt_count ?? 0),
    nextAttemptAt: nullableString(value.next_attempt_at),
    lastError: nullableString(value.last_error),
    lastOutcome: readStageOutcome(value.last_outcome_json),
    stopRequestedAt: nullableString(value.stop_requested_at),
    completedAt: nullableString(value.completed_at),
    archivedAt: nullableString(value.archived_at),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  } satisfies AutopilotAdmission;
}

export function readAutopilotStageAttempt(row: unknown) {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  const stage = v.safeParse(autopilotStageSchema, value.stage);
  const status = v.safeParse(autopilotStageAttemptStatusSchema, value.status);
  if (!stage.success || !status.success) return undefined;
  return {
    id: String(value.id),
    admissionId: String(value.admission_id),
    ownerId: String(value.owner_id),
    stage: stage.output,
    attemptNumber: Number(value.attempt_number),
    workflow: nullableString(value.workflow),
    runId: nullableString(value.run_id),
    flueInstanceId: nullableString(value.flue_instance_id),
    ownerGeneration: nullableNumber(value.owner_generation),
    eventSequence: nullableNumber(value.event_sequence),
    dispatchId: nullableString(value.dispatch_id),
    status: status.output,
    inputFingerprint: String(value.input_fingerprint),
    artifact: readJsonRecord(value.artifact_json),
    error: nullableString(value.error),
    createdAt: String(value.created_at),
    startedAt: nullableString(value.started_at),
    finishedAt: nullableString(value.finished_at),
  } satisfies AutopilotStageAttempt;
}

export function readAutopilotPrOwner(row: unknown) {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  const status = v.safeParse(autopilotOwnerStatusSchema, value.status);
  if (!status.success) return undefined;
  return {
    id: String(value.id),
    watchId: String(value.watch_id),
    repoId: String(value.repo_id),
    prNumber: Number(value.pr_number),
    flueAgent: String(value.flue_agent),
    flueInstanceId: nullableString(value.flue_instance_id),
    chatSessionId: nullableString(value.chat_session_id),
    worktreeId: nullableString(value.worktree_id),
    generation: Number(value.generation),
    groundingConfigHistoryId: Number(value.grounding_config_history_id),
    groundingMemoryEventAt: nullableString(value.grounding_memory_event_at),
    groundingMemoryEventId: nullableString(value.grounding_memory_event_id),
    groundingMemoryEventRowId: Number(value.grounding_memory_event_rowid ?? 0),
    groundingMemoryIds: readStringArray(value.grounding_memory_ids_json),
    status: status.output,
    currentHeadSha: nullableString(value.current_head_sha),
    lastDispatchedSequence: Number(value.last_dispatched_sequence),
    lastSettledSequence: Number(value.last_settled_sequence),
    lastEventAt: nullableString(value.last_event_at),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    archivedAt: nullableString(value.archived_at),
  } satisfies AutopilotPrOwner;
}

export function readStageOutcome(value: unknown) {
  const record = readJsonRecord(value);
  const parsed = v.safeParse(autopilotStageOutcomeSchema, record);
  return parsed.success ? parsed.output : null;
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' ? value : null;
}
