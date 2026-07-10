import * as v from 'valibot';

export type AutopilotMode =
  | 'notify-only'
  | 'prepare-only'
  | 'autofix-with-approval'
  | 'autofix-push-when-safe';

export type AutopilotPolicyLimits = {
  maxFilesChanged: number;
  maxLinesChanged: number;
  deniedFileGlobs: string[];
  approvalRequiredFileGlobs: string[];
  requiredChecks: string[];
  allowedPushDestinations: string[];
  allowForcePush: boolean;
  highRiskClasses: string[];
  generatedFileSizeThresholdBytes: number;
};

export type AutopilotConcurrencyPolicy = {
  maxAutonomousJobs: number;
  maxActiveWorkflowRuns: number;
  maxPerRepoAutonomousJobs: number;
  singleMutationPerPr: boolean;
  localExecutionLimit: number;
};

export type AutopilotPolicyConfig = {
  mode: AutopilotMode;
  limits: AutopilotPolicyLimits;
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
  limits: AutopilotPolicyLimits;
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
  limits: Partial<AutopilotPolicyLimits>;
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
export const stringArraySchema = v.array(nonEmptyStringSchema);
export const watchOverrideSchema = v.looseObject({
  watchId: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  mode: v.optional(modeSchema),
  reason: v.optional(nonEmptyStringSchema),
});
export const autopilotPolicyLimitsSchema = v.looseObject({
  maxFilesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxLinesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  deniedFileGlobs: v.optional(stringArraySchema),
  approvalRequiredFileGlobs: v.optional(stringArraySchema),
  requiredChecks: v.optional(stringArraySchema),
  allowedPushDestinations: v.optional(stringArraySchema),
  allowForcePush: v.optional(v.boolean()),
  highRiskClasses: v.optional(stringArraySchema),
  generatedFileSizeThresholdBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
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
  autopilot: v.optional(
    v.looseObject({
      defaultMode: v.optional(modeSchema),
      mode: v.optional(modeSchema),
      pushOnApproval: v.optional(
        v.picklist(['push', 'verify-then-push', 'off']),
      ),
      limits: v.optional(autopilotPolicyLimitsSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
    }),
  ),
});
export const metadataSchema = v.looseObject({
  autopilot: v.optional(
    v.looseObject({
      mode: v.optional(modeSchema),
      reason: v.optional(nonEmptyStringSchema),
      limits: v.optional(autopilotPolicyLimitsSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
      watchOverrides: v.optional(v.array(watchOverrideSchema)),
    }),
  ),
});

export const defaultAutopilotPolicyLimits: AutopilotPolicyLimits = {
  maxFilesChanged: 12,
  maxLinesChanged: 500,
  deniedFileGlobs: [
    '.git/**',
    '.env*',
    '**/.env*',
    '*.{pem,key,p12,pfx}',
    '**/*.{pem,key,p12,pfx}',
    '**/*secret*',
  ],
  approvalRequiredFileGlobs: [
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/bun.lock',
    '**/Cargo.lock',
    '**/package.json',
    '.github/**',
    '.gitlab-ci.yml',
    '**/migrations/**',
    '**/*.{png,jpg,jpeg,gif,webp,zip}',
    'vendor/**',
    '**/vendor/**',
    'third_party/**',
    '**/third_party/**',
  ],
  requiredChecks: [],
  allowedPushDestinations: ['pull-request-head'],
  allowForcePush: false,
  highRiskClasses: [
    'lockfile',
    'dependency-manifest',
    'ci-config',
    'deployment-config',
    'security-sensitive-code',
    'secrets-env',
    'database-migration',
    'large-generated-file',
    'binary-file',
    'vendored-code',
    'repo-glob',
  ],
  generatedFileSizeThresholdBytes: 256 * 1024,
};

export const defaultAutopilotConcurrency: AutopilotConcurrencyPolicy = {
  maxAutonomousJobs: 3,
  maxActiveWorkflowRuns: 3,
  maxPerRepoAutonomousJobs: 1,
  singleMutationPerPr: true,
  localExecutionLimit: 1,
};

export const autopilotWorkflowNames = new Set([
  'triage-pr-event',
  'triage_pr_event',
  'prepare-pr-worktree',
  'prepare_pr_worktree',
  'fix-pr-review-feedback',
  'fix_pr_review_feedback',
  'fix-pr-ci',
  'fix_pr_ci',
  'ci-fix-run',
  'ci_fix_run',
  'fix-pr-ci-failure',
  'fix_pr_ci_failure',
  'verify-pr-worktree',
  'verify_pr_worktree',
  'push-pr-autofix',
  'push_pr_autofix',
  'verify-then-push-pr-autofix',
  'verify_then_push_pr_autofix',
  'comment-pr-autofix-result',
  'comment_pr_autofix_result',
  'cleanup-autopilot-worktree',
  'cleanup_autopilot_worktree',
]);
export const mutationWorkflowNames = new Set([
  'prepare-pr-worktree',
  'prepare_pr_worktree',
  'fix-pr-review-feedback',
  'fix_pr_review_feedback',
  'fix-pr-ci',
  'fix_pr_ci',
  'ci-fix-run',
  'ci_fix_run',
  'fix-pr-ci-failure',
  'fix_pr_ci_failure',
  'verify-pr-worktree',
  'verify_pr_worktree',
  'push-pr-autofix',
  'push_pr_autofix',
  'verify-then-push-pr-autofix',
  'verify_then_push_pr_autofix',
  'comment-pr-autofix-result',
  'comment_pr_autofix_result',
  'cleanup-autopilot-worktree',
  'cleanup_autopilot_worktree',
]);
