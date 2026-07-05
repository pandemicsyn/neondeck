/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { addNotification } from '../app-state';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { openDb } from '../../lib/sqlite';
import { gitCurrentSha, gitDiff, type RepoDiffFile } from '../../repo-edit/git';
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
  return updatePreparedDiffState(
    record.id,
    {
      verificationStatus: input.status,
      summary: mergeSummary(record.summary, {
        verification: {
          status: input.status,
          verifiedCommitSha,
          recordedAt: new Date().toISOString(),
          ...input.summary,
        },
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
  return {
    ok: true,
    action: 'prepared_diff_summary',
    changed: false,
    message: `Read prepared diff ${loaded.record.id}.`,
    preparedDiff: loaded.record,
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
  return {
    ok: true,
    action: 'prepared_diff_changed_files',
    changed: false,
    message: `Read ${diff.files.length} changed file(s).`,
    preparedDiff: loaded.record,
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
    ['prepared', 'verification-requested'],
  );
  if (!transition.ok) return transition.result;
  const approvedCommitSha = await gitCurrentSha(
    record.record.sourceWorktreePath,
  ).catch(() => null);
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
    paths,
  );
  const approval = insertApproval(
    updated,
    'revision',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
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

export async function abandonPreparedDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
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
    paths,
  );
  const approval = insertApproval(
    updated,
    'abandon',
    'rejected',
    parsed.input.reason,
    parsed.input.approverSurface,
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
