import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { type RepoDiffSummary } from '../../../repos';

export type KiloResultClassification =
  'discard' | 'needs-review' | 'ready-to-verify' | 'ready-to-push';

export type KiloVerificationStatus =
  'not-run' | 'running' | 'passed' | 'failed' | 'blocked';

export type KiloPromotionStatus =
  'not-requested' | 'blocked' | 'ready' | 'deferred';

export type KiloResultState = {
  taskId: string;
  preparedDiffId: string | null;
  classification: KiloResultClassification;
  verificationStatus: KiloVerificationStatus;
  promotionStatus: KiloPromotionStatus;
  diffFingerprint: string | null;
  verifiedDiffFingerprint: string | null;
  reviewSummary: JsonValue | null;
  diffSummary: JsonValue | null;
  policy: JsonValue | null;
  verification: JsonValue | null;
  promotion: JsonValue | null;
  pendingApprovals: JsonValue[];
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  verifiedAt: string | null;
  promotedAt: string | null;
};

export type KiloTaskLike = {
  id: string;
  title: string;
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  cwd: string;
  status: string;
};

export type KiloResultActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  task?: KiloTaskLike;
  resultState?: KiloResultState;
  diff?: RepoDiffSummary;
  data?: JsonValue;
  requires?: string[];
  errors?: string[];
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const taskIdInputSchema = v.object({
  taskId: nonEmptyStringSchema,
});
export const verifyInputSchema = v.strictObject({
  taskId: nonEmptyStringSchema,
  checks: v.optional(v.array(nonEmptyStringSchema)),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  lock: v.optional(v.boolean()),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const promoteInputSchema = v.strictObject({
  taskId: nonEmptyStringSchema,
});
export const stateListInputSchema = v.object({
  taskId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
export const taskRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  worktree_id: v.nullable(v.string()),
  cwd: v.string(),
  status: v.string(),
});
export const stateRowSchema = v.object({
  task_id: v.string(),
  prepared_diff_id: v.nullable(v.string()),
  classification: v.string(),
  verification_status: v.string(),
  promotion_status: v.string(),
  diff_fingerprint: v.nullable(v.string()),
  verified_diff_fingerprint: v.nullable(v.string()),
  review_summary_json: v.nullable(v.string()),
  diff_summary_json: v.nullable(v.string()),
  policy_json: v.nullable(v.string()),
  verification_json: v.nullable(v.string()),
  promotion_json: v.nullable(v.string()),
  pending_approvals_json: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
  reviewed_at: v.nullable(v.string()),
  verified_at: v.nullable(v.string()),
  promoted_at: v.nullable(v.string()),
});
