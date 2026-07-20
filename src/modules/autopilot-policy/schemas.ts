import * as v from 'valibot';
import {
  defaultRepoGuardrails,
  repoGuardrailsSchema,
  type RepoGuardrails,
} from '../../runtime-home';

export {
  defaultRepoGuardrails,
  repoGuardrailsSchema,
  type RepoGuardrails,
  type RepoGuardrailsConfig,
} from '../../runtime-home';

export type AutopilotMode =
  | 'notify-only'
  | 'prepare-only'
  | 'autofix-with-approval'
  | 'autofix-push-when-safe';

export type AutopilotConcurrencyPolicy = {
  maxAutonomousJobs: number;
  maxActiveWorkflowRuns: number;
  maxPerRepoAutonomousJobs: number;
  singleMutationPerPr: boolean;
  localExecutionLimit: number;
};

export type AutopilotPolicyConfig = {
  mode: AutopilotMode;
  concurrency: AutopilotConcurrencyPolicy;
};

export type AutopilotPolicyDecision = {
  ok: boolean;
  action: 'autopilot_policy_check';
  changed: false;
  message: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  mode: AutopilotMode;
  limits: RepoGuardrails;
  concurrency: AutopilotConcurrencyPolicy;
  diff: {
    base: string;
    filesChanged: number;
    linesChanged: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
  };
  files: AutopilotFileRisk[];
  decision: 'deny' | 'require-approval' | 'allow';
  approvalClass: string | null;
  policyHash: string;
  blocked: boolean;
  approvalRequired: boolean;
  canPush: boolean;
  reasons: string[];
  requires: string[];
  fetchedAt: string;
};

export type AutopilotConcurrencyDecision = {
  ok: boolean;
  action: 'autopilot_concurrency_check';
  changed: false;
  message: string;
  allowed: boolean;
  repoId: string;
  prNumber: number | null;
  workflow: string;
  mutation: boolean;
  limits: AutopilotConcurrencyPolicy;
  usage: {
    autonomousJobs: number;
    activeWorkflowRuns: number;
    perRepoAutonomousJobs: number;
    samePrMutationWorkflows: number;
    localExecutions: number;
  };
  reasons: string[];
};

export type AutopilotFileRisk = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generatedLike: boolean;
  sizeBytes: number | null;
  denied: boolean;
  approvalRequired: boolean;
  classes: string[];
  reasons: string[];
};

export type RepoAutopilotConfig = Partial<{
  mode: AutopilotMode;
  reason: string;
  concurrency: Partial<AutopilotConcurrencyPolicy>;
  watchOverrides: Array<{
    watchId?: string;
    prNumber?: number;
    mode?: AutopilotMode;
    reason?: string;
  }>;
}>;

export type ActiveRunRow = {
  run_id: string;
  workflow: string;
  status: string;
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const modeSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
]);
export const watchOverrideSchema = v.looseObject({
  watchId: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  mode: v.optional(modeSchema),
  reason: v.optional(nonEmptyStringSchema),
});
export const autopilotConcurrencySchema = v.looseObject({
  maxAutonomousJobs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxActiveWorkflowRuns: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  maxPerRepoAutonomousJobs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  singleMutationPerPr: v.optional(v.boolean()),
  localExecutionLimit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
});
export const appAutopilotSchema = v.looseObject({
  guardrails: v.optional(repoGuardrailsSchema),
  autopilot: v.optional(
    v.looseObject({
      defaultMode: v.optional(modeSchema),
      mode: v.optional(modeSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
    }),
  ),
});
export const metadataSchema = v.looseObject({
  guardrails: v.optional(repoGuardrailsSchema),
  autopilot: v.optional(
    v.looseObject({
      mode: v.optional(modeSchema),
      reason: v.optional(nonEmptyStringSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
      watchOverrides: v.optional(v.array(watchOverrideSchema)),
    }),
  ),
});

/** @deprecated Use RepoGuardrails. Kept for stable policy-result consumers. */
export type AutopilotPolicyLimits = RepoGuardrails;
/** @deprecated Use repoGuardrailsSchema. */
export const autopilotPolicyLimitsSchema = repoGuardrailsSchema;
/** @deprecated Use defaultRepoGuardrails. */
export const defaultAutopilotPolicyLimits = defaultRepoGuardrails;

export const defaultAutopilotConcurrency: AutopilotConcurrencyPolicy = {
  maxAutonomousJobs: 3,
  maxActiveWorkflowRuns: 3,
  maxPerRepoAutonomousJobs: 1,
  singleMutationPerPr: true,
  localExecutionLimit: 1,
};

export const autopilotWorkflowNames = new Set([
  'fix-pr-ci',
  'fix_pr_ci',
  'ci-fix-run',
  'ci_fix_run',
]);
export const mutationWorkflowNames = new Set([
  'fix-pr-ci',
  'fix_pr_ci',
  'ci-fix-run',
  'ci_fix_run',
]);
