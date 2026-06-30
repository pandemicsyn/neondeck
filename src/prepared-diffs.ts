import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { addNotification } from './app-state';
import { buildPreparedDiffAuditSummary } from './autonomous-audit';
import { gitCurrentSha, gitDiff, type RepoDiffFile } from './repo-edit/git';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';

export type PreparedDiffStatus =
  | 'prepared'
  | 'verification-requested'
  | 'revision-requested'
  | 'push-approved'
  | 'push-blocked'
  | 'pushed'
  | 'abandoned';

export type PreparedDiffApprovalStatus =
  'not-requested' | 'pending' | 'approved' | 'rejected';

export type PreparedDiffVerificationStatus =
  'not-run' | 'requested' | 'running' | 'passed' | 'failed';

export type PreparedDiffRecord = {
  id: string;
  worktreeId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  title: string;
  sourceWorktreePath: string;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  status: PreparedDiffStatus;
  pushApprovalStatus: PreparedDiffApprovalStatus;
  verificationStatus: PreparedDiffVerificationStatus;
  summary: JsonValue | null;
  sourceOfTruth: 'worktree';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  abandonedAt: string | null;
};

export type PreparedDiffApprovalRecord = {
  id: string;
  preparedDiffId: string;
  worktreeId: string;
  approvalType: 'push' | 'revision' | 'abandon' | 'verification';
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  reason: string | null;
  approverSurface: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
};

type WorktreeRecordLike = {
  id: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  localPath: string;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  lifecycleStatus: string;
};

type PreparedDiffActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  preparedDiff?: PreparedDiffRecord;
  preparedDiffs?: PreparedDiffRecord[];
  approvals?: PreparedDiffApprovalRecord[];
  files?: RepoDiffFile[];
  file?: RepoDiffFile | null;
  diff?: string;
  diffSummary?: {
    files: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
  };
  data?: JsonValue;
  error?: { code: string; message: string };
  requires?: string[];
  errors?: string[];
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const repoRelativePathSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    const trimmed = value.trim();
    return (
      trimmed === '.' ||
      (!trimmed.startsWith('/') &&
        !trimmed.startsWith('-') &&
        !trimmed.split(/[\\/]/).includes('..'))
    );
  }, 'Expected a safe repo-relative path.'),
);
const preparedDiffStatusSchema = v.picklist([
  'prepared',
  'verification-requested',
  'revision-requested',
  'push-approved',
  'push-blocked',
  'pushed',
  'abandoned',
]);
const preparedDiffApprovalStatusSchema = v.picklist([
  'not-requested',
  'pending',
  'approved',
  'rejected',
]);
const preparedDiffVerificationStatusSchema = v.picklist([
  'not-run',
  'requested',
  'running',
  'passed',
  'failed',
]);
const preparedDiffRecordSchema = v.object({
  id: v.string(),
  worktreeId: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.nullable(v.number()),
  title: v.string(),
  sourceWorktreePath: v.string(),
  baseRef: v.string(),
  headRef: v.string(),
  headSha: v.nullable(v.string()),
  status: preparedDiffStatusSchema,
  pushApprovalStatus: preparedDiffApprovalStatusSchema,
  verificationStatus: preparedDiffVerificationStatusSchema,
  summary: v.nullable(v.unknown()),
  sourceOfTruth: v.literal('worktree'),
  createdBy: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
  abandonedAt: v.nullable(v.string()),
});
const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
const listInputSchema = v.object({
  status: v.optional(preparedDiffStatusSchema),
  includeTerminal: v.optional(v.boolean()),
  repoId: v.optional(nonEmptyStringSchema),
});
const idInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
});
const fileDiffInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  path: repoRelativePathSchema,
  maxPatchBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * 1024)),
  ),
});
const approvePushInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  approverSurface: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});
const requestRevisionInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  approverSurface: v.optional(nonEmptyStringSchema),
});
const abandonInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  approverSurface: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});
const verificationInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  checkName: v.optional(nonEmptyStringSchema),
  approverSurface: v.optional(nonEmptyStringSchema),
});
const worktreeRowSchema = v.object({
  id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  pr_number: v.nullable(v.number()),
  local_path: v.string(),
  base_ref: v.string(),
  head_ref: v.string(),
  head_sha: v.nullable(v.string()),
  lifecycle_status: v.string(),
});
const preparedDiffRowSchema = v.object({
  id: v.string(),
  worktree_id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  pr_number: v.nullable(v.number()),
  title: v.string(),
  source_worktree_path: v.string(),
  base_ref: v.string(),
  head_ref: v.string(),
  head_sha: v.nullable(v.string()),
  status: v.string(),
  push_approval_status: v.string(),
  verification_status: v.string(),
  summary_json: v.nullable(v.string()),
  created_by: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
  abandoned_at: v.nullable(v.string()),
});
const approvalRowSchema = v.object({
  id: v.string(),
  prepared_diff_id: v.string(),
  worktree_id: v.string(),
  approval_type: v.string(),
  status: v.string(),
  reason: v.nullable(v.string()),
  approver_surface: v.nullable(v.string()),
  requested_at: v.string(),
  resolved_at: v.nullable(v.string()),
  updated_at: v.string(),
});

export const preparedDiffsLookupTool = defineTool({
  name: 'neondeck_prepared_diffs_lookup',
  description:
    'List prepared-diff records and pending push/revision/abandon approvals. File-level diffs remain sourced from the managed worktree.',
  input: listInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listPreparedDiffs(input);
  },
});

export const preparedDiffListAction = defineAction({
  name: 'neondeck_prepared_diff_list',
  description:
    'List prepared diffs from Neondeck app state. The source worktree is the file-level source of truth.',
  input: listInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listPreparedDiffs(input);
  },
});

export const preparedDiffSummaryAction = defineAction({
  name: 'neondeck_prepared_diff_summary',
  description:
    'Read one prepared-diff record and recompute its diff summary from the managed source worktree.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffSummary(input);
  },
});

export const preparedDiffChangedFilesAction = defineAction({
  name: 'neondeck_prepared_diff_changed_files',
  description:
    'Read changed files for one prepared diff by running backend git diff against its source worktree.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffChangedFiles(input);
  },
});

export const preparedDiffFileDiffAction = defineAction({
  name: 'neondeck_prepared_diff_file_diff',
  description:
    'Read one file patch for a prepared diff by running backend git diff against its source worktree.',
  input: fileDiffInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffFileDiff(input);
  },
});

export const preparedDiffApprovePushAction = defineAction({
  name: 'neondeck_prepared_diff_approve_push',
  description:
    'Approve push-back for a prepared diff. This records approval only; the later push workflow performs the GitHub mutation.',
  input: approvePushInputSchema,
  output: outputSchema,
  async run({ input }) {
    return approvePreparedDiffPush(input);
  },
});

export const preparedDiffRequestRevisionAction = defineAction({
  name: 'neondeck_prepared_diff_request_revision',
  description:
    'Request a revision for a prepared diff and keep the source worktree available for follow-up work.',
  input: requestRevisionInputSchema,
  output: outputSchema,
  async run({ input }) {
    return requestPreparedDiffRevision(input);
  },
});

export const preparedDiffAbandonAction = defineAction({
  name: 'neondeck_prepared_diff_abandon',
  description:
    'Abandon a prepared-diff record without deleting its source worktree.',
  input: abandonInputSchema,
  output: outputSchema,
  async run({ input }) {
    return abandonPreparedDiff(input);
  },
});

export const preparedDiffOpenWorktreeAction = defineAction({
  name: 'neondeck_prepared_diff_open_worktree',
  description:
    'Return the managed source worktree path for a prepared diff so a web or TUI client can open it.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return openPreparedDiffWorktree(input);
  },
});

export const preparedDiffRunVerificationAction = defineAction({
  name: 'neondeck_prepared_diff_run_verification',
  description:
    'Record a verification request for a prepared diff. The later verify_pr_worktree workflow owns actual command execution.',
  input: verificationInputSchema,
  output: outputSchema,
  async run({ input }) {
    return runPreparedDiffVerification(input);
  },
});

export const neondeckPreparedDiffActions = [
  preparedDiffListAction,
  preparedDiffSummaryAction,
  preparedDiffChangedFilesAction,
  preparedDiffFileDiffAction,
  preparedDiffApprovePushAction,
  preparedDiffRequestRevisionAction,
  preparedDiffAbandonAction,
  preparedDiffOpenWorktreeAction,
  preparedDiffRunVerificationAction,
];

export const neondeckPreparedDiffTools = [preparedDiffsLookupTool];

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

function listPreparedDiffRecords(
  input: v.InferOutput<typeof listInputSchema>,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (input.status) {
      clauses.push('status = ?');
      args.push(input.status);
    } else if (!input.includeTerminal) {
      clauses.push("status NOT IN ('abandoned', 'pushed')");
    }
    if (input.repoId) {
      clauses.push('repo_id = ?');
      args.push(input.repoId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare(
        `
        SELECT *
        FROM prepared_diffs
        ${where}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100;
      `,
      )
      .all(...args)
      .map(readPreparedDiffRow);
  } finally {
    database.close();
  }
}

export function readPreparedDiffRecord(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diffs WHERE id = ?;')
      .get(id);
    return row ? readPreparedDiffRow(row) : undefined;
  } finally {
    database.close();
  }
}

function readPreparedDiffByWorktreeId(worktreeId: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diffs WHERE worktree_id = ?;')
      .get(worktreeId);
    return row ? readPreparedDiffRow(row) : undefined;
  } finally {
    database.close();
  }
}

function upsertPreparedDiff(record: PreparedDiffRecord, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diffs (
          id, worktree_id, repo_id, repo_full_name, pr_number, title,
          source_worktree_path, base_ref, head_ref, head_sha, status,
          push_approval_status, verification_status, summary_json, created_by,
          created_at, updated_at, abandoned_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_id) DO UPDATE SET
          repo_id = excluded.repo_id,
          repo_full_name = excluded.repo_full_name,
          pr_number = excluded.pr_number,
          title = excluded.title,
          source_worktree_path = excluded.source_worktree_path,
          base_ref = excluded.base_ref,
          head_ref = excluded.head_ref,
          head_sha = excluded.head_sha,
          status = excluded.status,
          push_approval_status = excluded.push_approval_status,
          verification_status = excluded.verification_status,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at,
          abandoned_at = excluded.abandoned_at;
      `,
      )
      .run(
        record.id,
        record.worktreeId,
        record.repoId,
        record.repoFullName,
        record.prNumber,
        record.title,
        record.sourceWorktreePath,
        record.baseRef,
        record.headRef,
        record.headSha,
        record.status,
        record.pushApprovalStatus,
        record.verificationStatus,
        record.summary === null ? null : JSON.stringify(record.summary),
        record.createdBy,
        record.createdAt,
        record.updatedAt,
        record.abandonedAt,
      );
  } finally {
    database.close();
  }
}

function updatePreparedDiffState(
  id: string,
  input: Partial<
    Pick<
      PreparedDiffRecord,
      | 'status'
      | 'pushApprovalStatus'
      | 'verificationStatus'
      | 'summary'
      | 'abandonedAt'
    >
  >,
  paths: RuntimePaths,
) {
  const current = readPreparedDiffRecord(id, paths);
  if (!current) {
    throw new Error(`Prepared diff ${id} was not found.`);
  }
  const updated: PreparedDiffRecord = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  upsertPreparedDiff(updated, paths);
  return updated;
}

function assertTransition(
  record: PreparedDiffRecord,
  action: string,
  transition: string,
  allowedFrom: PreparedDiffStatus[],
):
  | { ok: true }
  | {
      ok: false;
      result: PreparedDiffActionResult;
    } {
  if (allowedFrom.includes(record.status)) return { ok: true };
  return {
    ok: false,
    result: failure(
      action,
      `Cannot ${transition} prepared diff ${record.id} from status ${record.status}.`,
      'INVALID_TRANSITION',
    ),
  };
}

function ensurePendingApproval(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  reason: string,
  paths: RuntimePaths,
) {
  const existing = pendingApproval(record.id, approvalType, paths);
  if (existing) return existing;
  return insertApproval(
    record,
    approvalType,
    'pending',
    reason,
    undefined,
    paths,
  );
}

function supersedeApprovals(
  preparedDiffId: string,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  reason: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET status = 'superseded',
            reason = ?,
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status IN ('pending', 'approved', 'rejected');
      `,
      )
      .run(reason, now, now, preparedDiffId, approvalType);
  } finally {
    database.close();
  }
}

function resolvePendingApprovals(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  status: 'approved' | 'rejected' | 'superseded',
  reason: string | undefined,
  approverSurface: string | undefined,
  paths: RuntimePaths,
) {
  const pending = pendingApproval(record.id, approvalType, paths);
  if (!pending) {
    return insertApproval(
      record,
      approvalType,
      status,
      reason,
      approverSurface,
      paths,
    );
  }

  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET
          status = ?,
          reason = COALESCE(?, reason),
          approver_surface = COALESCE(?, approver_surface),
          resolved_at = ?,
          updated_at = ?
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status = 'pending';
      `,
      )
      .run(
        status,
        reason ?? null,
        approverSurface ?? null,
        now,
        now,
        record.id,
        approvalType,
      );
  } finally {
    database.close();
  }

  return (
    readApprovalRecord(pending.id, paths) ??
    insertApproval(record, approvalType, status, reason, approverSurface, paths)
  );
}

function pendingApproval(
  preparedDiffId: string,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM prepared_diff_approvals
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status = 'pending'
        ORDER BY requested_at DESC
        LIMIT 1;
      `,
      )
      .get(preparedDiffId, approvalType);
    return row ? readApprovalRow(row) : undefined;
  } finally {
    database.close();
  }
}

function readApprovalRecord(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diff_approvals WHERE id = ?;')
      .get(id);
    return row ? readApprovalRow(row) : undefined;
  } finally {
    database.close();
  }
}

function insertApproval(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  status: PreparedDiffApprovalRecord['status'],
  reason: string | undefined,
  approverSurface: string | undefined,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const approval: PreparedDiffApprovalRecord = {
    id: randomUUID(),
    preparedDiffId: record.id,
    worktreeId: record.worktreeId,
    approvalType,
    status,
    reason: reason ?? null,
    approverSurface: approverSurface ?? null,
    requestedAt: now,
    resolvedAt: status === 'pending' ? null : now,
    updatedAt: now,
  };
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diff_approvals (
          id, prepared_diff_id, worktree_id, approval_type, status, reason,
          approver_surface, requested_at, resolved_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        approval.id,
        approval.preparedDiffId,
        approval.worktreeId,
        approval.approvalType,
        approval.status,
        approval.reason,
        approval.approverSurface,
        approval.requestedAt,
        approval.resolvedAt,
        approval.updatedAt,
      );
  } finally {
    database.close();
  }
  return approval;
}

function listApprovalRecords(
  input: { status?: string; preparedDiffIds?: string[] },
  paths: RuntimePaths,
) {
  if (input.preparedDiffIds && input.preparedDiffIds.length === 0) {
    return [];
  }
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (input.status) {
      clauses.push('status = ?');
      args.push(input.status);
    }
    if (input.preparedDiffIds?.length) {
      clauses.push(
        `prepared_diff_id IN (${input.preparedDiffIds.map(() => '?').join(', ')})`,
      );
      args.push(...input.preparedDiffIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare(
        `
        SELECT *
        FROM prepared_diff_approvals
        ${where}
        ORDER BY updated_at DESC
        LIMIT 100;
      `,
      )
      .all(...args)
      .map(readApprovalRow);
  } finally {
    database.close();
  }
}

function updateWorktreeLifecycle(
  worktreeId: string,
  status: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM worktrees WHERE id = ?;')
      .get(worktreeId);
    const worktree = row ? readWorktreeRow(row) : undefined;
    database
      .prepare(
        `
        UPDATE worktrees
        SET lifecycle_status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, now, worktreeId);
    if (worktree) {
      database
        .prepare(
          `
          INSERT INTO worktree_events (
            id, worktree_id, repo_id, event_type, status, message, data_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `,
        )
        .run(
          randomUUID(),
          worktree.id,
          worktree.repoId,
          'prepared_diff_abandoned',
          status,
          'Prepared diff was abandoned; worktree retained for cleanup policy.',
          null,
          now,
        );
    }
  } finally {
    database.close();
  }
}

function readPreparedDiffRow(row: unknown): PreparedDiffRecord {
  const item = v.parse(preparedDiffRowSchema, row);
  return v.parse(preparedDiffRecordSchema, {
    id: item.id,
    worktreeId: item.worktree_id,
    repoId: item.repo_id,
    repoFullName: item.repo_full_name,
    prNumber: item.pr_number,
    title: item.title,
    sourceWorktreePath: item.source_worktree_path,
    baseRef: item.base_ref,
    headRef: item.head_ref,
    headSha: item.head_sha,
    status: item.status,
    pushApprovalStatus: item.push_approval_status,
    verificationStatus: item.verification_status,
    summary:
      item.summary_json === null
        ? null
        : (JSON.parse(item.summary_json) as JsonValue),
    sourceOfTruth: 'worktree',
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    abandonedAt: item.abandoned_at,
  }) as PreparedDiffRecord;
}

function readApprovalRow(row: unknown): PreparedDiffApprovalRecord {
  const item = v.parse(approvalRowSchema, row);
  return {
    id: item.id,
    preparedDiffId: item.prepared_diff_id,
    worktreeId: item.worktree_id,
    approvalType:
      item.approval_type === 'revision' ||
      item.approval_type === 'abandon' ||
      item.approval_type === 'verification'
        ? item.approval_type
        : 'push',
    status:
      item.status === 'approved' ||
      item.status === 'rejected' ||
      item.status === 'superseded'
        ? item.status
        : 'pending',
    reason: item.reason,
    approverSurface: item.approver_surface,
    requestedAt: item.requested_at,
    resolvedAt: item.resolved_at,
    updatedAt: item.updated_at,
  };
}

function readWorktreeRow(row: unknown): WorktreeRecordLike {
  const item = v.parse(worktreeRowSchema, row);
  return {
    id: item.id,
    repoId: item.repo_id,
    repoFullName: item.repo_full_name,
    prNumber: item.pr_number,
    localPath: item.local_path,
    baseRef: item.base_ref,
    headRef: item.head_ref,
    headSha: item.head_sha,
    lifecycleStatus: item.lifecycle_status,
  };
}

function mergeSummary(
  current: JsonValue | null,
  next: Record<string, unknown>,
) {
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return asJsonValue({ ...base, ...next });
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

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
