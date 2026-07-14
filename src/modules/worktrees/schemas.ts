import * as v from 'valibot';
import type { RepoConfig } from '../../runtime-home';

export type WorktreeStorageKind = 'home' | 'repo-local';
export type WorktreeLockScope = 'worktree' | 'pr';
export type WorktreeLifecycleStatus =
  | 'creating'
  | 'ready'
  | 'busy'
  | 'stale'
  | 'needs-sync'
  | 'failed'
  | 'prepared-diff'
  | 'succeeded'
  | 'cleanup-pending'
  | 'deleted';

export type WorktreeRecord = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number | null;
  baseRef: string;
  headOwner: string | null;
  headName: string | null;
  headRef: string;
  headSha: string | null;
  localPath: string;
  storageKind: WorktreeStorageKind;
  owningWorkflowRunId: string | null;
  lifecycleStatus: WorktreeLifecycleStatus;
  lastSyncedSha: string | null;
  lastPushedSha: string | null;
  cleanupPolicy: WorktreeCleanupPolicy;
  directPushAllowed: boolean;
  adopted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeLockRecord = {
  id: string;
  scope: WorktreeLockScope;
  scopeKey: string;
  worktreeId: string | null;
  repoId: string;
  prNumber: number | null;
  owner: string;
  workflowRunId: string | null;
  expiresAt: string;
  revokedAt: string | null;
  releasedAt: string | null;
  staleRecoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeCleanupPolicy = {
  retainFailed: boolean;
  retainPreparedDiff: boolean;
  successfulGraceHours: number;
  staleAgeHours: number;
};

export type RepoContext = {
  repo: RepoConfig;
  appDefaultStorage: WorktreeStorageKind | undefined;
  appCleanup: WorktreeCleanupPolicy;
};

export const lifecycleStatusSchema = v.picklist([
  'creating',
  'ready',
  'busy',
  'stale',
  'needs-sync',
  'failed',
  'prepared-diff',
  'succeeded',
  'cleanup-pending',
  'deleted',
]);
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const repoIdSchema = nonEmptyStringSchema;
export const positiveIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);
export const safeGitRefSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    return (
      !value.startsWith('-') &&
      !value.includes('\u0000') &&
      !/[\s\\~^:?*[\]]/.test(value)
    );
  }, 'Expected a safe git ref or SHA.'),
);
export const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const createInputSchema = v.object({
  repoId: repoIdSchema,
  prNumber: v.optional(positiveIntegerSchema),
  baseRef: v.optional(safeGitRefSchema),
  headOwner: v.optional(nonEmptyStringSchema),
  headName: v.optional(nonEmptyStringSchema),
  headRef: v.optional(safeGitRefSchema),
  headSha: v.optional(safeGitRefSchema),
  localPath: v.optional(nonEmptyStringSchema),
  storage: v.optional(v.picklist(['home', 'repo-local'])),
  adopted: v.optional(v.boolean()),
  workflowRunId: v.optional(nonEmptyStringSchema),
  directPushAllowed: v.optional(v.boolean()),
  createdBy: v.optional(v.picklist(['neondeck', 'user', 'external'])),
});

export const syncInputSchema = v.object({
  worktreeId: nonEmptyStringSchema,
  lockId: v.optional(nonEmptyStringSchema),
  headRef: v.optional(safeGitRefSchema),
  headSha: v.optional(safeGitRefSchema),
  fetch: v.optional(v.boolean()),
  force: v.optional(v.boolean()),
  strategy: v.optional(v.picklist(['checkout', 'rebase'])),
});

export const statusInputSchema = v.object({
  worktreeId: nonEmptyStringSchema,
});

export const lockInputSchema = v.object({
  worktreeId: v.optional(nonEmptyStringSchema),
  repoId: v.optional(repoIdSchema),
  prNumber: v.optional(positiveIntegerSchema),
  scope: v.optional(v.picklist(['worktree', 'pr'])),
  owner: nonEmptyStringSchema,
  workflowRunId: v.optional(nonEmptyStringSchema),
  ttlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});

export const releaseInputSchema = v.object({
  lockId: nonEmptyStringSchema,
  owner: v.optional(nonEmptyStringSchema),
  finalStatus: v.optional(
    v.picklist([
      'ready',
      'stale',
      'needs-sync',
      'failed',
      'prepared-diff',
      'succeeded',
      'cleanup-pending',
    ]),
  ),
});

export const cleanupInputSchema = v.object({
  worktreeId: v.optional(nonEmptyStringSchema),
  dryRun: v.optional(v.boolean()),
  confirmAdopted: v.optional(v.boolean()),
  confirmPreparedDiff: v.optional(v.boolean()),
  force: v.optional(v.boolean()),
});
export const rowNullableStringSchema = v.nullable(v.string());
export const rowNullableNumberSchema = v.nullable(v.number());
export const worktreeCleanupPolicySchema = v.object({
  retainFailed: v.optional(v.boolean()),
  retainPreparedDiff: v.optional(v.boolean()),
  successfulGraceHours: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  staleAgeHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const worktreeRowSchema = v.object({
  id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  github_owner: v.string(),
  github_name: v.string(),
  pr_number: rowNullableNumberSchema,
  base_ref: v.string(),
  head_owner: rowNullableStringSchema,
  head_name: rowNullableStringSchema,
  head_ref: v.string(),
  head_sha: rowNullableStringSchema,
  local_path: v.string(),
  storage_kind: v.string(),
  owning_workflow_run_id: rowNullableStringSchema,
  lifecycle_status: v.string(),
  last_synced_sha: rowNullableStringSchema,
  last_pushed_sha: rowNullableStringSchema,
  cleanup_policy_json: rowNullableStringSchema,
  direct_push_allowed: v.number(),
  adopted: v.number(),
  created_by: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
});
export const lockRowSchema = v.object({
  id: v.string(),
  scope: v.string(),
  scope_key: v.string(),
  worktree_id: rowNullableStringSchema,
  repo_id: v.string(),
  pr_number: rowNullableNumberSchema,
  owner: v.string(),
  workflow_run_id: rowNullableStringSchema,
  expires_at: v.string(),
  revoked_at: rowNullableStringSchema,
  released_at: rowNullableStringSchema,
  stale_recovered_at: rowNullableStringSchema,
  created_at: v.string(),
  updated_at: v.string(),
});
export const cleanupAttemptRowSchema = v.object({
  id: v.string(),
  worktree_id: v.string(),
  repo_id: v.string(),
  action: v.string(),
  outcome: v.string(),
  reason: v.string(),
  error: rowNullableStringSchema,
  deleted: v.number(),
  attempted_at: v.string(),
});
