import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { gitDiff, type RepoDiffFile } from './repo-edit/git';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type AppConfig,
  type RepoConfig,
  type RuntimePaths,
} from './runtime-home';
import { listWorktrees } from './worktrees';

export type AutopilotMode =
  | 'notify-only'
  | 'prepare-only'
  | 'autofix-with-approval'
  | 'autofix-push-when-safe';

export type AutopilotModeAlias =
  'draft-fix' | 'auto-fix-no-push' | 'auto-fix-push-after-checks';

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

type AutopilotFileRisk = {
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

type RepoAutopilotConfig = Partial<{
  mode: AutopilotMode | AutopilotModeAlias;
  reason: string;
  limits: Partial<AutopilotPolicyLimits>;
  concurrency: Partial<AutopilotConcurrencyPolicy>;
  watchOverrides: unknown[];
}>;

type ActiveRunRow = {
  run_id: string;
  workflow: string;
  status: string;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const modeSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
  'draft-fix',
  'auto-fix-no-push',
  'auto-fix-push-after-checks',
]);
const stringArraySchema = v.array(nonEmptyStringSchema);
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
const appAutopilotSchema = v.looseObject({
  autopilot: v.optional(
    v.looseObject({
      defaultMode: v.optional(modeSchema),
      mode: v.optional(modeSchema),
      limits: v.optional(autopilotPolicyLimitsSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
    }),
  ),
});
const metadataSchema = v.looseObject({
  autopilot: v.optional(
    v.looseObject({
      mode: v.optional(modeSchema),
      reason: v.optional(nonEmptyStringSchema),
      limits: v.optional(autopilotPolicyLimitsSchema),
      concurrency: v.optional(autopilotConcurrencySchema),
      watchOverrides: v.optional(v.array(v.unknown())),
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

const modeAliasMap: Record<AutopilotModeAlias, AutopilotMode> = {
  'draft-fix': 'prepare-only',
  'auto-fix-no-push': 'autofix-with-approval',
  'auto-fix-push-after-checks': 'autofix-push-when-safe',
};

const autopilotWorkflowNames = new Set([
  'triage-pr-event',
  'triage_pr_event',
  'prepare-pr-worktree',
  'prepare_pr_worktree',
  'fix-pr-review-feedback',
  'fix_pr_review_feedback',
  'fix-pr-ci-failure',
  'fix_pr_ci_failure',
  'verify-pr-worktree',
  'verify_pr_worktree',
  'push-pr-autofix',
  'push_pr_autofix',
  'comment-pr-autofix-result',
  'comment_pr_autofix_result',
  'cleanup-autopilot-worktree',
  'cleanup_autopilot_worktree',
]);
const mutationWorkflowNames = new Set([
  'prepare-pr-worktree',
  'prepare_pr_worktree',
  'fix-pr-review-feedback',
  'fix_pr_review_feedback',
  'fix-pr-ci-failure',
  'fix_pr_ci_failure',
  'verify-pr-worktree',
  'verify_pr_worktree',
  'push-pr-autofix',
  'push_pr_autofix',
  'comment-pr-autofix-result',
  'comment_pr_autofix_result',
  'cleanup-autopilot-worktree',
  'cleanup_autopilot_worktree',
]);
let activeLocalExecutions = 0;

export function normalizeAutopilotMode(
  mode: AutopilotMode | AutopilotModeAlias,
): AutopilotMode {
  if (mode in modeAliasMap) return modeAliasMap[mode as AutopilotModeAlias];
  return mode as AutopilotMode;
}

export function mergeAutopilotLimits(
  base: AutopilotPolicyLimits,
  override: Partial<AutopilotPolicyLimits> | undefined,
): AutopilotPolicyLimits {
  return {
    ...base,
    ...override,
    deniedFileGlobs: override?.deniedFileGlobs ?? base.deniedFileGlobs,
    approvalRequiredFileGlobs:
      override?.approvalRequiredFileGlobs ?? base.approvalRequiredFileGlobs,
    requiredChecks: override?.requiredChecks ?? base.requiredChecks,
    allowedPushDestinations:
      override?.allowedPushDestinations ?? base.allowedPushDestinations,
    highRiskClasses: override?.highRiskClasses ?? base.highRiskClasses,
    allowForcePush: override?.allowForcePush ?? base.allowForcePush,
    generatedFileSizeThresholdBytes:
      override?.generatedFileSizeThresholdBytes ??
      base.generatedFileSizeThresholdBytes,
  };
}

export function mergeAutopilotConcurrency(
  base: AutopilotConcurrencyPolicy,
  override: Partial<AutopilotConcurrencyPolicy> | undefined,
): AutopilotConcurrencyPolicy {
  return { ...base, ...override };
}

export function globalAutopilotPolicy(
  appConfig: unknown,
): AutopilotPolicyConfig {
  const parsed = v.safeParse(appAutopilotSchema, appConfig);
  const raw = parsed.success ? parsed.output.autopilot : undefined;
  return {
    mode: normalizeAutopilotMode(
      raw?.defaultMode ?? raw?.mode ?? 'notify-only',
    ),
    limits: mergeAutopilotLimits(defaultAutopilotPolicyLimits, raw?.limits),
    concurrency: mergeAutopilotConcurrency(
      defaultAutopilotConcurrency,
      raw?.concurrency,
    ),
  };
}

export function readRepoAutopilotConfig(
  repo: RepoConfig | undefined,
): RepoAutopilotConfig | undefined {
  if (!repo?.metadata) return undefined;
  const parsed = v.safeParse(metadataSchema, repo.metadata);
  if (!parsed.success) return undefined;
  return parsed.output.autopilot as RepoAutopilotConfig | undefined;
}

export function repoAutopilotPolicy(
  repo: RepoConfig,
  appConfig: AppConfig,
): AutopilotPolicyConfig {
  const global = globalAutopilotPolicy(appConfig);
  const repoPolicy = readRepoAutopilotConfig(repo);
  return {
    mode: repoPolicy?.mode
      ? normalizeAutopilotMode(repoPolicy.mode)
      : global.mode,
    limits: mergeAutopilotLimits(global.limits, repoPolicy?.limits),
    concurrency: mergeAutopilotConcurrency(
      global.concurrency,
      repoPolicy?.concurrency,
    ),
  };
}

export function pathDeniedByAutopilotPolicy(
  path: string,
  limits: AutopilotPolicyLimits,
) {
  return matchesAny(path, limits.deniedFileGlobs);
}

export async function checkAutopilotPolicy(
  input: {
    repoId?: string;
    worktreeId?: string;
    diffBaseRef?: string;
    pushDestination?: string;
    forcePush?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotPolicyDecision> {
  await ensureRuntimeHome(paths);
  const [registry, appConfig, worktreeSnapshot] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
    listWorktrees(paths),
  ]);
  const worktree = input.worktreeId
    ? worktreeSnapshot.worktrees.find((item) => item.id === input.worktreeId)
    : undefined;
  const repoId = input.repoId ?? worktree?.repoId;
  const repo = registry.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    return emptyPolicyFailure(
      repoId ?? 'unknown',
      'Repository is not configured.',
    );
  }
  const policy = repoAutopilotPolicy(repo, appConfig);
  const repoFullName = `${repo.github.owner}/${repo.github.name}`;
  const localPath = worktree?.localPath ?? repo.path;
  const diffBase = input.diffBaseRef ?? worktree?.headSha ?? 'HEAD';
  const diff = await gitDiff(localPath, {
    base: diffBase,
    includePatch: true,
    maxPatchBytes: 128 * 1024,
  });
  const files = await Promise.all(
    diff.files.map((file) => classifyFileRisk(localPath, file, policy.limits)),
  );
  const totalLines = diff.summary.additions + diff.summary.deletions;
  const reasons: string[] = [];
  const requires = new Set<string>();

  if (diff.summary.files > policy.limits.maxFilesChanged) {
    reasons.push(
      `Changed ${diff.summary.files} files, above maxFilesChanged=${policy.limits.maxFilesChanged}.`,
    );
    requires.add('maxFilesChanged');
  }
  if (totalLines > policy.limits.maxLinesChanged) {
    reasons.push(
      `Changed ${totalLines} lines, above maxLinesChanged=${policy.limits.maxLinesChanged}.`,
    );
    requires.add('maxLinesChanged');
  }
  const deniedFiles = files.filter((file) => file.denied);
  for (const file of deniedFiles) {
    reasons.push(`${file.path} matches denied autopilot policy.`);
    requires.add('deniedFileGlobs');
  }
  const riskyFiles = files.filter((file) => file.approvalRequired);
  for (const file of riskyFiles) {
    reasons.push(`${file.path} requires approval: ${file.reasons.join(', ')}.`);
    requires.add('approval');
  }
  if (input.forcePush && !policy.limits.allowForcePush) {
    reasons.push('Force-push is disabled by autopilot policy.');
    requires.add('allowForcePush');
  }
  const forcePushBlocked = Boolean(
    input.forcePush && !policy.limits.allowForcePush,
  );
  let pushDestinationBlocked = false;
  if (
    input.pushDestination &&
    !policy.limits.allowedPushDestinations.includes(input.pushDestination)
  ) {
    pushDestinationBlocked = true;
    reasons.push(
      `Push destination "${input.pushDestination}" is not in allowedPushDestinations.`,
    );
    requires.add('allowedPushDestinations');
  }
  if (policy.limits.requiredChecks.length > 0) {
    reasons.push(
      `Required checks before push: ${policy.limits.requiredChecks.join(', ')}.`,
    );
  }

  const blocked =
    deniedFiles.length > 0 || forcePushBlocked || pushDestinationBlocked;
  const approvalRequired =
    !blocked &&
    (riskyFiles.length > 0 ||
      diff.summary.files > policy.limits.maxFilesChanged ||
      totalLines > policy.limits.maxLinesChanged ||
      Boolean(input.forcePush && !policy.limits.allowForcePush));

  return {
    ok: true,
    action: 'autopilot_policy_check',
    changed: false,
    message: blocked
      ? 'Autopilot policy blocks this worktree diff.'
      : approvalRequired
        ? 'Autopilot policy requires explicit approval for this worktree diff.'
        : 'Autopilot policy allows this worktree diff to proceed to verification.',
    repoId: repo.id,
    repoFullName,
    prNumber: worktree?.prNumber ?? null,
    mode: policy.mode,
    limits: policy.limits,
    concurrency: policy.concurrency,
    diff: {
      base: diff.base,
      filesChanged: diff.summary.files,
      linesChanged: totalLines,
      additions: diff.summary.additions,
      deletions: diff.summary.deletions,
      binaryFiles: diff.summary.binaryFiles,
    },
    files,
    blocked,
    approvalRequired,
    canPush: !blocked && !approvalRequired,
    reasons,
    requires: [...requires],
    fetchedAt: new Date().toISOString(),
  };
}

export async function checkAutopilotConcurrency(
  input: {
    repoId: string;
    prNumber?: number | null;
    workflow: string;
    mutation?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotConcurrencyDecision> {
  await ensureRuntimeHome(paths);
  const appConfig = await readRuntimeJson(paths.config, parseAppConfig);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const worktreeSnapshot = await listWorktrees(paths);
  const repo = registry.repos.find(
    (candidate) => candidate.id === input.repoId,
  );
  const limits = repo
    ? repoAutopilotPolicy(repo, appConfig).concurrency
    : globalAutopilotPolicy(appConfig).concurrency;
  const activeRuns = readActiveAutopilotRuns(paths);
  const activeRunIds = new Set(activeRuns.map((run) => run.run_id));
  const activeWorkflowRuns = activeRuns.length;
  const activeWorktrees = worktreeSnapshot.worktrees.filter((worktree) =>
    worktree.owningWorkflowRunId
      ? activeRunIds.has(worktree.owningWorkflowRunId)
      : worktree.lifecycleStatus === 'busy',
  );
  const perRepoAutonomousJobs = activeWorktrees.filter(
    (worktree) => worktree.repoId === input.repoId,
  ).length;
  const samePrMutationWorkflows = activeWorktrees.filter(
    (worktree) =>
      input.prNumber !== null &&
      input.prNumber !== undefined &&
      worktree.repoId === input.repoId &&
      worktree.prNumber === input.prNumber &&
      (worktree.owningWorkflowRunId
        ? mutationWorkflowNames.has(
            normalizeWorkflowName(
              activeRuns.find(
                (run) => run.run_id === worktree.owningWorkflowRunId,
              )?.workflow ?? '',
            ),
          )
        : true),
  ).length;
  const reasons: string[] = [];
  if (activeWorkflowRuns >= limits.maxActiveWorkflowRuns) {
    reasons.push(
      `Active autopilot workflow limit reached (${activeWorkflowRuns}/${limits.maxActiveWorkflowRuns}).`,
    );
  }
  if (activeWorkflowRuns >= limits.maxAutonomousJobs) {
    reasons.push(
      `Global autonomous job limit reached (${activeWorkflowRuns}/${limits.maxAutonomousJobs}).`,
    );
  }
  if (perRepoAutonomousJobs >= limits.maxPerRepoAutonomousJobs) {
    reasons.push(
      `Per-repo autonomous job limit reached for ${input.repoId} (${perRepoAutonomousJobs}/${limits.maxPerRepoAutonomousJobs}).`,
    );
  }
  if (
    limits.singleMutationPerPr &&
    input.mutation !== false &&
    samePrMutationWorkflows > 0
  ) {
    reasons.push(
      `A mutation workflow is already active for ${input.repoId}#${input.prNumber}.`,
    );
  }

  return {
    ok: reasons.length === 0,
    action: 'autopilot_concurrency_check',
    changed: false,
    message:
      reasons.length === 0
        ? 'Autopilot concurrency allows admission.'
        : 'Autopilot concurrency blocks admission.',
    allowed: reasons.length === 0,
    repoId: input.repoId,
    prNumber: input.prNumber ?? null,
    workflow: input.workflow,
    mutation: input.mutation !== false,
    limits,
    usage: {
      autonomousJobs: activeWorkflowRuns,
      activeWorkflowRuns,
      perRepoAutonomousJobs,
      samePrMutationWorkflows,
      localExecutions: activeLocalExecutions,
    },
    reasons,
  };
}

export async function withAutopilotLocalExecutionSlot<T>(
  limits: AutopilotConcurrencyPolicy,
  run: () => Promise<T>,
): Promise<T | { blocked: true; message: string }> {
  if (activeLocalExecutions >= limits.localExecutionLimit) {
    return {
      blocked: true,
      message: `Local execution concurrency limit reached (${activeLocalExecutions}/${limits.localExecutionLimit}).`,
    };
  }
  activeLocalExecutions += 1;
  try {
    return await run();
  } finally {
    activeLocalExecutions -= 1;
  }
}

async function classifyFileRisk(
  root: string,
  file: RepoDiffFile,
  limits: AutopilotPolicyLimits,
): Promise<AutopilotFileRisk> {
  const path = normalizePath(file.path);
  const sizeBytes = await stat(join(root, path))
    .then((item) => item.size)
    .catch(() => null);
  const classes = new Set<string>();
  const reasons: string[] = [];
  const denied = matchesAny(path, limits.deniedFileGlobs);
  const approvalByGlob = matchesAny(path, limits.approvalRequiredFileGlobs);

  addClass(classes, reasons, isLockfile(path), 'lockfile', 'lockfile');
  addClass(
    classes,
    reasons,
    isDependencyManifestChange(path, file.patch),
    'dependency-manifest',
    'dependency manifest dependency change',
  );
  addClass(classes, reasons, isCiConfig(path), 'ci-config', 'CI/CD config');
  addClass(
    classes,
    reasons,
    isDeploymentConfig(path),
    'deployment-config',
    'deployment or infrastructure config',
  );
  addClass(
    classes,
    reasons,
    isSecuritySensitive(path),
    'security-sensitive-code',
    'auth/security-sensitive path',
  );
  addClass(
    classes,
    reasons,
    isSecretEnv(path),
    'secrets-env',
    'secret/env path',
  );
  addClass(
    classes,
    reasons,
    isMigration(path),
    'database-migration',
    'database migration',
  );
  addClass(classes, reasons, file.binary, 'binary-file', 'binary file');
  addClass(
    classes,
    reasons,
    isVendored(path),
    'vendored-code',
    'vendored code',
  );
  addClass(
    classes,
    reasons,
    Boolean(
      file.generatedLike &&
      sizeBytes !== null &&
      sizeBytes >= limits.generatedFileSizeThresholdBytes,
    ),
    'large-generated-file',
    'large generated-like file',
  );
  addClass(
    classes,
    reasons,
    approvalByGlob,
    'repo-glob',
    'approval-required glob',
  );

  const configuredHighRisk = [...classes].some((item) =>
    limits.highRiskClasses.includes(item),
  );

  return {
    path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    generatedLike: file.generatedLike,
    sizeBytes,
    denied,
    approvalRequired: approvalByGlob || configuredHighRisk,
    classes: [...classes],
    reasons,
  };
}

function emptyPolicyFailure(
  repoId: string,
  message: string,
): AutopilotPolicyDecision {
  return {
    ok: false,
    action: 'autopilot_policy_check',
    changed: false,
    message,
    repoId,
    repoFullName: 'unknown',
    prNumber: null,
    mode: 'notify-only',
    limits: defaultAutopilotPolicyLimits,
    concurrency: defaultAutopilotConcurrency,
    diff: {
      base: 'HEAD',
      filesChanged: 0,
      linesChanged: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
    },
    files: [],
    blocked: true,
    approvalRequired: false,
    canPush: false,
    reasons: [message],
    requires: ['repo'],
    fetchedAt: new Date().toISOString(),
  };
}

function readActiveAutopilotRuns(paths: RuntimePaths): ActiveRunRow[] {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT run_id, workflow, status
        FROM workflow_run_observations
        WHERE status = 'active'
        ORDER BY last_event_at DESC
        LIMIT 100;
      `,
      )
      .all()
      .map((row) =>
        v.parse(
          v.object({
            run_id: v.string(),
            workflow: v.string(),
            status: v.string(),
          }),
          row,
        ),
      )
      .filter((row) =>
        autopilotWorkflowNames.has(normalizeWorkflowName(row.workflow)),
      );
  } finally {
    database.close();
  }
}

function addClass(
  classes: Set<string>,
  reasons: string[],
  condition: boolean,
  className: string,
  reason: string,
) {
  if (!condition) return;
  classes.add(className);
  reasons.push(reason);
}

function normalizePath(path: string) {
  return path.replaceAll('\\', '/');
}

function isLockfile(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.endsWith('.lock') ||
    [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'Cargo.lock',
      'Gemfile.lock',
      'composer.lock',
    ].includes(name)
  );
}

function isDependencyManifestChange(path: string, patch: string | undefined) {
  const name = path.split('/').at(-1) ?? path;
  if (!isDependencyManifest(path)) return false;
  if (!patch) return true;
  if (
    ['requirements.txt', 'requirements-dev.txt', 'go.mod', 'Cargo.toml'].some(
      (item) => name === item,
    )
  ) {
    return changedContentLines(patch).length > 0;
  }
  return changedContentLines(patch).some((line) =>
    /"(dependencies|devDependencies|peerDependencies|optionalDependencies|resolutions|overrides)"|version\s*=|^[+-]\s*"?[\w@./-]+"?\s*[:=]\s*"?[~^<>=\d*]/.test(
      line,
    ),
  );
}

function isDependencyManifest(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'Gemfile',
  ].includes(name);
}

function changedContentLines(patch: string) {
  return patch
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    );
}

function isCiConfig(path: string) {
  return (
    path.startsWith('.github/') ||
    path.startsWith('.circleci/') ||
    path === '.gitlab-ci.yml' ||
    path === 'azure-pipelines.yml' ||
    path.startsWith('.buildkite/')
  );
}

function isDeploymentConfig(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name === 'Dockerfile' ||
    name.startsWith('Dockerfile.') ||
    name.startsWith('docker-compose') ||
    name === 'wrangler.jsonc' ||
    name === 'wrangler.toml' ||
    name === 'fly.toml' ||
    name === 'netlify.toml' ||
    name === 'vercel.json' ||
    path.startsWith('terraform/') ||
    path.endsWith('.tf') ||
    path.startsWith('infra/') ||
    path.startsWith('k8s/') ||
    path.startsWith('helm/')
  );
}

function isSecuritySensitive(path: string) {
  return /(^|\/)(auth|security|crypto|oauth|session|sessions|permissions?|rbac|jwt)(\/|\.|-|_)/i.test(
    path,
  );
}

function isSecretEnv(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.startsWith('.env') ||
    /secret|credential|private[-_]?key/i.test(path) ||
    /\.(pem|key|p12|pfx)$/i.test(path)
  );
}

function isMigration(path: string) {
  return /(^|\/)(migrations?|db\/migrate|schema\/migrations)(\/|$)/i.test(path);
}

function isVendored(path: string) {
  return /(^|\/)(vendor|third_party|node_modules)(\/|$)/i.test(path);
}

function matchesAny(path: string, patterns: string[]) {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string) {
  const expanded = pattern.replace(/\{([^}]+)\}/g, (_, body: string) => {
    return `(${body
      .split(',')
      .map((part) => escapeRegExp(part.trim()))
      .join('|')})`;
  });
  let source = '';
  for (let index = 0; index < expanded.length; index += 1) {
    const char = expanded[index];
    const next = expanded[index + 1];
    const afterNext = expanded[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '(' || char === ')' || char === '|') {
      source += char;
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function normalizeWorkflowName(name: string) {
  return name.replaceAll('_', '-');
}
