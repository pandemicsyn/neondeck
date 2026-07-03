/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { addNotification } from '../../app-state';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { openDb } from '../../lib/sqlite';
import { gitCurrentSha, gitDiff, type RepoDiffFile } from '../../repo-edit/git';
import { type RuntimePaths, ensureRuntimeHome, runtimePaths } from '../../runtime-home';

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

export type WorktreeRecordLike = {
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

export type PreparedDiffActionResult = {
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

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const repoRelativePathSchema = v.pipe(
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
export const preparedDiffStatusSchema = v.picklist([
  'prepared',
  'verification-requested',
  'revision-requested',
  'push-approved',
  'push-blocked',
  'pushed',
  'abandoned',
]);
export const preparedDiffApprovalStatusSchema = v.picklist([
  'not-requested',
  'pending',
  'approved',
  'rejected',
]);
export const preparedDiffVerificationStatusSchema = v.picklist([
  'not-run',
  'requested',
  'running',
  'passed',
  'failed',
]);
export const preparedDiffRecordSchema = v.object({
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
export const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
export const listInputSchema = v.object({
  status: v.optional(preparedDiffStatusSchema),
  includeTerminal: v.optional(v.boolean()),
  repoId: v.optional(nonEmptyStringSchema),
});
export const idInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
});
export const fileDiffInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  path: repoRelativePathSchema,
  maxPatchBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * 1024)),
  ),
});
export const approvePushInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  approverSurface: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});
export const requestRevisionInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  approverSurface: v.optional(nonEmptyStringSchema),
});
export const abandonInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  approverSurface: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});
export const verificationInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  checkName: v.optional(nonEmptyStringSchema),
  approverSurface: v.optional(nonEmptyStringSchema),
});
export const worktreeRowSchema = v.object({
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
export const preparedDiffRowSchema = v.object({
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
export const approvalRowSchema = v.object({
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
