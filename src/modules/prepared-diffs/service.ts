/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  reviewRevisionKey,
  type ReviewRevision,
} from '../../../shared/review-source';
import { addNotification } from '../app-state';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { openDb } from '../../lib/sqlite';
import {
  gitCurrentSha,
  gitDiff,
  gitWorktreeRevision,
} from '../../repo-edit/git';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  abandonInputSchema,
  approvePushInputSchema,
  fileDiffInputSchema,
  idInputSchema,
  listInputSchema,
  requestRevisionInputSchema,
  verificationInputSchema,
  type PreparedDiffActionResult,
  type PreparedDiffRecord,
  type PreparedDiffStatus,
  type PreparedDiffVerificationStatus,
  type WorktreeRecordLike,
} from './schemas';
import {
  assertTransition,
  ensurePendingApproval,
  insertApproval,
  listApprovalRecords,
  listPreparedDiffRecords,
  mergeSummary,
  readPreparedDiffByWorktreeId,
  readPreparedDiffRecord,
  resolvePendingApprovals,
  supersedeApprovals,
  updatePreparedDiffState,
  updatePreparedDiffVerificationWithLease,
  updateWorktreeLifecycle,
  upsertPreparedDiff,
} from './store';

export async function ensurePreparedDiffForWorktree(
  worktree: WorktreeRecordLike,
  paths: RuntimePaths = runtimePaths(),
  input: {
    title?: string;
    createdBy?: string;
    summary?: unknown;
    resetDecisionState?: boolean;
  } = {},
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const existing = readPreparedDiffByWorktreeId(worktree.id, paths);
  const shouldResetDecisionState = Boolean(
    existing && input.resetDecisionState,
  );
  if (
    existing?.status === 'abandoned' &&
    shouldResetDecisionState &&
    shouldKeepAbandonedRevision(existing.summary, input.createdBy)
  ) {
    updateWorktreeLifecycle(existing.worktreeId, 'cleanup-pending', paths);
    return existing;
  }
  if (existing && shouldResetDecisionState) {
    supersedeApprovals(
      existing.id,
      'push',
      'Prepared diff was regenerated; previous push decision is no longer current.',
      paths,
    );
  }
  const record: PreparedDiffRecord = {
    id: existing?.id ?? randomUUID(),
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    repoFullName: worktree.repoFullName,
    prNumber: worktree.prNumber,
    title:
      input.title ??
      existing?.title ??
      `${worktree.repoFullName}${worktree.prNumber ? `#${worktree.prNumber}` : ''}`,
    sourceWorktreePath: worktree.localPath,
    baseRef: worktree.baseRef,
    headRef: worktree.headRef,
    headSha: worktree.headSha,
    status:
      existing?.status === 'abandoned' || shouldResetDecisionState
        ? 'prepared'
        : (existing?.status ?? 'prepared'),
    pushApprovalStatus: shouldResetDecisionState
      ? 'pending'
      : (existing?.pushApprovalStatus ?? 'pending'),
    verificationStatus: shouldResetDecisionState
      ? 'not-run'
      : (existing?.verificationStatus ?? 'not-run'),
    summary:
      input.summary === undefined
        ? (existing?.summary ?? null)
        : asJsonValue(input.summary),
    sourceOfTruth: 'worktree',
    createdBy: existing?.createdBy ?? input.createdBy ?? 'neondeck',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    abandonedAt: null,
  };
  upsertPreparedDiff(record, paths);
  if (record.pushApprovalStatus === 'pending') {
    ensurePendingApproval(
      record,
      'push',
      'Prepared diff is waiting for push-back approval.',
      paths,
    );
  }
  return record;
}

export function readPreparedDiff(
  preparedDiffId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return readPreparedDiffRecord(preparedDiffId, paths) ?? null;
}

export function readPreparedDiffByWorktree(
  worktreeId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return readPreparedDiffByWorktreeId(worktreeId, paths) ?? null;
}

export async function recordPreparedDiffVerification(
  input: {
    preparedDiffId?: string;
    worktreeId?: string;
    lockId?: string;
    status: Extract<PreparedDiffVerificationStatus, 'passed' | 'failed'>;
    summary?: Record<string, unknown>;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const record = input.preparedDiffId
    ? readPreparedDiffRecord(input.preparedDiffId, paths)
    : input.worktreeId
      ? readPreparedDiffByWorktreeId(input.worktreeId, paths)
      : undefined;
  if (!record) return null;
  const verifiedCommitSha = await gitCurrentSha(
    record.sourceWorktreePath,
  ).catch(() => null);
  const verification = {
    status: input.status,
    verifiedCommitSha,
    recordedAt: new Date().toISOString(),
    ...input.summary,
  };
  if (input.lockId) {
    return updatePreparedDiffVerificationWithLease(
      record.id,
      {
        lockId: input.lockId,
        status: input.status,
        verification,
      },
      paths,
    );
  }
  return updatePreparedDiffState(
    record.id,
    {
      verificationStatus: input.status,
      summary: mergeSummary(record.summary, {
        verification,
      }),
    },
    paths,
  );
}

export function markPreparedDiffPushBlocked(
  preparedDiffId: string,
  input: { reason: string; gates?: unknown; recoveryOptions?: string[] },
  paths: RuntimePaths = runtimePaths(),
) {
  const current = readPreparedDiffRecord(preparedDiffId, paths);
  if (!current) return null;
  return updatePreparedDiffState(
    preparedDiffId,
    {
      status: 'push-blocked',
      summary: mergeSummary(current.summary, {
        push: {
          status: 'blocked',
          reason: input.reason,
          gates: input.gates ?? null,
          recoveryOptions: input.recoveryOptions ?? [],
          attemptedAt: new Date().toISOString(),
        },
      }),
    },
    paths,
  );
}

export function markPreparedDiffPushed(
  preparedDiffId: string,
  input: { commitSha: string; remote: string; branch: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const current = readPreparedDiffRecord(preparedDiffId, paths);
  if (!current) return null;
  return updatePreparedDiffState(
    preparedDiffId,
    {
      status: 'pushed',
      summary: mergeSummary(current.summary, {
        push: {
          status: 'pushed',
          commitSha: input.commitSha,
          remote: input.remote,
          branch: input.branch,
          pushedAt: new Date().toISOString(),
        },
      }),
    },
    paths,
  );
}

export async function listPreparedDiffs(
  rawInput: unknown = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(listInputSchema, rawInput, 'prepared_diff_list');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const preparedDiffs = listPreparedDiffRecords(parsed.input, paths);
  const approvals =
    preparedDiffs.length === 0
      ? []
      : listApprovalRecords(
          {
            status: 'pending',
            preparedDiffIds: preparedDiffs.map((item) => item.id),
          },
          paths,
        );
  return {
    ok: true,
    action: 'prepared_diff_list',
    changed: false,
    message: `Read ${preparedDiffs.length} prepared diff record(s).`,
    preparedDiffs,
    approvals,
  };
}

export async function readPreparedDiffSummary(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const loaded = await loadPreparedDiff(
    rawInput,
    'prepared_diff_summary',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  const diff = await gitDiff(loaded.record.sourceWorktreePath, {
    base: loaded.record.baseRef,
    includePatch: false,
  });
  const revision = await gitWorktreeRevision(loaded.record.sourceWorktreePath, {
    base: diff.base,
    files: diff.files,
  });
  return {
    ok: true,
    action: 'prepared_diff_summary',
    changed: false,
    message: `Read prepared diff ${loaded.record.id}.`,
    preparedDiff: loaded.record,
    revision,
    diffSummary: diff.summary,
    data: asJsonValue({
      sourceOfTruth: 'worktree',
      base: diff.base,
      summary: loaded.record.summary,
      auditSummary: buildPreparedDiffAuditSummary({
        preparedDiff: loaded.record,
      }),
    }),
  };
}

export async function readPreparedDiffChangedFiles(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const loaded = await loadPreparedDiff(
    rawInput,
    'prepared_diff_changed_files',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  const diff = await gitDiff(loaded.record.sourceWorktreePath, {
    base: loaded.record.baseRef,
    includePatch: false,
  });
  const revision = await gitWorktreeRevision(loaded.record.sourceWorktreePath, {
    base: diff.base,
    files: diff.files,
  });
  return {
    ok: true,
    action: 'prepared_diff_changed_files',
    changed: false,
    message: `Read ${diff.files.length} changed file(s).`,
    preparedDiff: loaded.record,
    revision,
    files: diff.files,
    diffSummary: diff.summary,
  };
}

export async function readPreparedDiffFileDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    fileDiffInputSchema,
    rawInput,
    'prepared_diff_file_diff',
  );
  if (!parsed.ok) return parsed.result;
  const record = readPreparedDiffRecord(parsed.input.preparedDiffId, paths);
  if (!record) {
    return failure(
      'prepared_diff_file_diff',
      `Prepared diff ${parsed.input.preparedDiffId} was not found.`,
      'PREPARED_DIFF_NOT_FOUND',
    );
  }
  const diff = await gitDiff(record.sourceWorktreePath, {
    base: record.baseRef,
    paths: [parsed.input.path],
    includePatch: true,
    maxPatchBytes: parsed.input.maxPatchBytes,
  });
  const file =
    diff.files.find((item) => item.path === parsed.input.path) ?? null;
  return {
    ok: true,
    action: 'prepared_diff_file_diff',
    changed: false,
    message: file
      ? `Read diff for ${parsed.input.path}.`
      : `No diff found for ${parsed.input.path}.`,
    preparedDiff: record,
    file,
    diff: file?.patch ?? '',
    diffSummary: diff.summary,
  };
}

export async function approvePreparedDiffPush(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  binding: {
    targetSha: string;
    policyHash: string;
    policyDecision: 'require-approval' | 'allow';
  },
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    approvePushInputSchema,
    rawInput,
    'prepared_diff_approve_push',
  );
  if (!parsed.ok) return parsed.result;
  if (parsed.input.confirm !== true) {
    return {
      ok: false,
      action: 'prepared_diff_approve_push',
      changed: false,
      message: 'Approving prepared diff push-back requires confirm=true.',
      requires: ['confirm'],
      errors: ['confirm=true is required.'],
    };
  }
  const record = requirePreparedDiff(
    parsed.input.preparedDiffId,
    'prepared_diff_approve_push',
    paths,
  );
  if (!record.ok) return record.result;
  const transition = assertTransition(
    record.record,
    'prepared_diff_approve_push',
    'approve-push',
    ['prepared', 'verification-requested', 'push-blocked'],
  );
  if (!transition.ok) return transition.result;
  const approvedCommitSha = await gitCurrentSha(
    record.record.sourceWorktreePath,
  ).catch(() => null);
  if (!approvedCommitSha) {
    return failure(
      'prepared_diff_approve_push',
      'Prepared diff approval requires a readable worktree commit SHA.',
      'PREPARED_DIFF_SHA_UNAVAILABLE',
    );
  }
  if (binding.targetSha !== approvedCommitSha) {
    return failure(
      'prepared_diff_approve_push',
      'Prepared diff changed before approval could be recorded.',
      'PREPARED_DIFF_APPROVAL_STALE',
    );
  }
  const updated = updatePreparedDiffState(
    record.record.id,
    {
      status: 'push-approved',
      pushApprovalStatus: 'approved',
      summary: mergeSummary(record.record.summary, {
        pushApproval: {
          approvedCommitSha,
          approvedAt: new Date().toISOString(),
          reason: parsed.input.reason ?? null,
        },
      }),
    },
    paths,
  );
  const approval = resolvePendingApprovals(
    updated,
    'push',
    'approved',
    parsed.input.reason,
    parsed.input.approverSurface,
    {
      targetSha: approvedCommitSha,
      policyHash: binding.policyHash,
      policyDecision: binding.policyDecision,
    },
    paths,
  );
  await addNotification(
    {
      level: 'ready',
      title: 'Prepared diff approved',
      message:
        'Push-back is approved in app state. The push_pr_autofix workflow is still responsible for policy checks and GitHub mutation.',
      source: 'autopilot',
      sourceId: `prepared-diff:${updated.id}:push-approved`,
      data: { preparedDiffId: updated.id, worktreeId: updated.worktreeId },
    },
    paths,
  );
  return {
    ok: true,
    action: 'prepared_diff_approve_push',
    changed: true,
    message:
      'Recorded prepared diff push approval. Actual push-back is handled by a later workflow.',
    preparedDiff: updated,
    approvals: [approval],
    data: asJsonValue({ nextWorkflow: 'push_pr_autofix' }),
  };
}

export async function requestPreparedDiffRevision(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    readCurrentRevision?: (
      record: PreparedDiffRecord,
    ) => Promise<ReviewRevision>;
  } = {},
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    requestRevisionInputSchema,
    rawInput,
    'prepared_diff_request_revision',
  );
  if (!parsed.ok) return parsed.result;
  const loaded = requirePreparedDiff(
    parsed.input.preparedDiffId,
    'prepared_diff_request_revision',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  const existingPromotion = objectField(loaded.record.summary).findingPromotion;
  if (
    parsed.input.findingPromotion &&
    objectField(existingPromotion).sourceFindingId ===
      parsed.input.findingPromotion.sourceFindingId
  ) {
    return {
      ok: true,
      action: 'prepared_diff_request_revision',
      changed: false,
      message:
        'This finding already seeded the prepared-diff revision request.',
      preparedDiff: loaded.record,
      approvals: listApprovalRecords(
        { preparedDiffIds: [loaded.record.id] },
        paths,
      ).filter((approval) => approval.approvalType === 'revision'),
    };
  }
  const expectedRevisionKey = parsed.input.findingPromotion?.revisionKey;
  if (expectedRevisionKey) {
    let currentRevision: ReviewRevision;
    try {
      currentRevision = await (
        dependencies.readCurrentRevision ?? preparedDiffWorktreeRevision
      )(loaded.record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        'prepared_diff_request_revision',
        `Could not verify the current prepared-diff revision: ${message}`,
        'PREPARED_DIFF_REVISION_UNAVAILABLE',
      );
    }
    if (reviewRevisionKey(currentRevision) !== expectedRevisionKey) {
      return failure(
        'prepared_diff_request_revision',
        'The prepared worktree changed after this finding was created. Refresh the diff and retry with a current finding.',
        'PREPARED_DIFF_STALE_REVISION',
      );
    }
  }
  const transition = assertTransition(
    loaded.record,
    'prepared_diff_request_revision',
    'request-revision',
    ['prepared', 'verification-requested', 'push-approved', 'push-blocked'],
  );
  if (!transition.ok) return transition.result;
  const updated = updatePreparedDiffState(
    loaded.record.id,
    {
      status: 'revision-requested',
      pushApprovalStatus: 'rejected',
      summary: mergeSummary(loaded.record.summary, {
        revisionReason: parsed.input.reason,
        ...(parsed.input.findingPromotion
          ? { findingPromotion: parsed.input.findingPromotion }
          : {}),
      }),
    },
    paths,
  );
  resolvePendingApprovals(
    updated,
    'push',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
    {},
    paths,
  );
  const approval = insertApproval(
    updated,
    'revision',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
    {},
    paths,
  );
  return {
    ok: true,
    action: 'prepared_diff_request_revision',
    changed: true,
    message: 'Recorded revision request for prepared diff.',
    preparedDiff: updated,
    approvals: [approval],
  };
}

async function preparedDiffWorktreeRevision(record: PreparedDiffRecord) {
  const diff = await gitDiff(record.sourceWorktreePath, {
    base: record.baseRef,
    includePatch: false,
  });
  return gitWorktreeRevision(record.sourceWorktreePath, {
    base: diff.base,
    files: diff.files,
  });
}

export async function abandonPreparedDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: { revisionRunAborted?: boolean } = {},
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    abandonInputSchema,
    rawInput,
    'prepared_diff_abandon',
  );
  if (!parsed.ok) return parsed.result;
  if (parsed.input.confirm !== true) {
    return {
      ok: false,
      action: 'prepared_diff_abandon',
      changed: false,
      message: 'Abandoning a prepared diff requires confirm=true.',
      requires: ['confirm'],
      errors: ['confirm=true is required.'],
    };
  }
  const loaded = requirePreparedDiff(
    parsed.input.preparedDiffId,
    'prepared_diff_abandon',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  const transition = assertTransition(
    loaded.record,
    'prepared_diff_abandon',
    'abandon',
    [
      'prepared',
      'verification-requested',
      'revision-requested',
      'revision-in-progress',
      'push-approved',
      'push-blocked',
    ],
  );
  if (!transition.ok) return transition.result;
  if (
    loaded.record.status === 'revision-in-progress' &&
    dependencies.revisionRunAborted !== true
  ) {
    return {
      ok: false,
      action: 'prepared_diff_abandon',
      changed: false,
      message:
        'Abandoning a running prepared-diff revision requires stopping the revision run first.',
      preparedDiff: loaded.record,
      requires: ['revisionRunAbort'],
      errors: ['revision run must be stopped before abandon.'],
      error: {
        code: 'REVISION_RUN_IN_PROGRESS',
        message:
          'Abandoning a running prepared-diff revision requires stopping the revision run first.',
      },
    };
  }
  const updated = updatePreparedDiffState(
    loaded.record.id,
    {
      status: 'abandoned',
      pushApprovalStatus: 'rejected',
      abandonedAt: new Date().toISOString(),
      summary: mergeSummary(loaded.record.summary, {
        abandonedReason: parsed.input.reason ?? null,
      }),
    },
    paths,
  );
  updateWorktreeLifecycle(updated.worktreeId, 'cleanup-pending', paths);
  resolvePendingApprovals(
    updated,
    'push',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
    {},
    paths,
  );
  const approval = insertApproval(
    updated,
    'abandon',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
    {},
    paths,
  );
  return {
    ok: true,
    action: 'prepared_diff_abandon',
    changed: true,
    message:
      'Abandoned prepared diff record. The source worktree is retained for cleanup policy handling.',
    preparedDiff: updated,
    approvals: [approval],
  };
}

export async function openPreparedDiffWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const loaded = await loadPreparedDiff(
    rawInput,
    'prepared_diff_open_worktree',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  return {
    ok: true,
    action: 'prepared_diff_open_worktree',
    changed: false,
    message: `Prepared diff worktree path is ${loaded.record.sourceWorktreePath}.`,
    preparedDiff: loaded.record,
    data: asJsonValue({ path: loaded.record.sourceWorktreePath }),
  };
}

export async function runPreparedDiffVerification(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    verificationInputSchema,
    rawInput,
    'prepared_diff_run_verification',
  );
  if (!parsed.ok) return parsed.result;
  const loaded = requirePreparedDiff(
    parsed.input.preparedDiffId,
    'prepared_diff_run_verification',
    paths,
  );
  if (!loaded.ok) return loaded.result;
  const transition = assertTransition(
    loaded.record,
    'prepared_diff_run_verification',
    'run-verification',
    ['prepared', 'push-approved'],
  );
  if (!transition.ok) return transition.result;
  const updated = updatePreparedDiffState(
    loaded.record.id,
    {
      status: 'verification-requested',
      verificationStatus: 'requested',
      summary: mergeSummary(loaded.record.summary, {
        requestedCheck: parsed.input.checkName ?? null,
      }),
    },
    paths,
  );
  return {
    ok: true,
    action: 'prepared_diff_run_verification',
    changed: true,
    message:
      'Recorded verification request. Actual command execution remains owned by verify_pr_worktree.',
    preparedDiff: updated,
    approvals: [],
    data: asJsonValue({ nextWorkflow: 'verify_pr_worktree' }),
  };
}

function parseInput<T>(
  schema: v.GenericSchema<T>,
  input: unknown,
  action: string,
):
  | { ok: true; input: T }
  | {
      ok: false;
      result: PreparedDiffActionResult;
    } {
  const parsed = v.safeParse(schema, input);
  if (parsed.success) return { ok: true, input: parsed.output };
  const message = parsed.issues.map((issue) => issue.message).join('; ');
  return {
    ok: false,
    result: failure(
      action,
      `Invalid prepared-diff input: ${message}`,
      'INVALID_INPUT',
    ),
  };
}

async function loadPreparedDiff(
  rawInput: unknown,
  action: string,
  paths: RuntimePaths,
): Promise<
  | { ok: true; record: PreparedDiffRecord }
  | { ok: false; result: PreparedDiffActionResult }
> {
  const parsed = parseInput(idInputSchema, rawInput, action);
  if (!parsed.ok) return parsed;
  const loaded = requirePreparedDiff(
    parsed.input.preparedDiffId,
    action,
    paths,
  );
  if (!loaded.ok) return loaded;
  return { ok: true, record: loaded.record };
}

function requirePreparedDiff(
  id: string,
  action: string,
  paths: RuntimePaths,
):
  | { ok: true; record: PreparedDiffRecord }
  | { ok: false; result: PreparedDiffActionResult } {
  const record = readPreparedDiffRecord(id, paths);
  if (!record) {
    return {
      ok: false,
      result: failure(
        action,
        `Prepared diff ${id} was not found.`,
        'PREPARED_DIFF_NOT_FOUND',
      ),
    };
  }
  return { ok: true, record };
}

function failure(action: string, message: string, code: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code, message },
  };
}

function shouldKeepAbandonedRevision(
  summary: unknown,
  createdBy: string | undefined,
) {
  if (!createdBy?.startsWith('kilo:')) return false;
  const taskId = createdBy.slice('kilo:'.length);
  const run = objectField(objectField(summary).revisionRun);
  return stringField(run.kiloTaskId) === taskId;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
