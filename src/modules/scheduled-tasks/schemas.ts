import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimeSkillSessionSnapshot } from '../runtime';

export type AutomationTrigger =
  | { kind: 'interval'; everySeconds: number }
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

export type ScheduledTaskSpec =
  | { kind: 'poll-pr-watch'; watchId: string }
  | { kind: 'run-briefing'; briefingId: string }
  | {
      kind: 'run-agent-instruction';
      prompt: string;
      target: { kind: 'agent' } | { kind: 'agent-session'; sessionId: string };
      repoId?: string;
      cwd?: string;
      skills: string[];
      workspace?: ScheduledWorkspacePolicy;
    };

export type ScheduledWorkspacePolicy =
  | { kind: 'virtual' }
  | {
      kind: 'repository';
      repoId: string;
      providerId: string;
      subdirectory?: string;
      resource: {
        lifecycle: 'per-run' | 'reuse-task' | 'existing';
        existingResourceId?: string;
      };
      revision: {
        ref: string;
        mode: 'latest-each-run' | 'pinned' | 'continue';
        sha?: string;
      };
      git: {
        mode: 'run-branch' | 'task-branch' | 'direct-branch';
        branch?: string;
        acknowledgeDirectBranch?: boolean;
      };
      authority: 'read-only' | 'trusted-workspace' | 'delivery-enabled';
      retention?: 'cleanup-success' | 'retain-always';
      overlap?: 'skip' | 'queue-one' | 'allow-parallel';
    };

export type ScheduledTaskRecord = {
  id: string;
  spec: ScheduledTaskSpec;
  trigger: AutomationTrigger;
  enabled: boolean;
  nextRunAt: string | null;
  claimId: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
};

export type ScheduledTaskRunRecord = {
  id: string;
  taskId: string;
  status: 'claimed' | 'active' | 'completed' | 'failed';
  outcome: 'recorded' | 'silent' | 'failed';
  message: string;
  submissionId: string | null;
  sessionId: string | null;
  dispatchKey: string | null;
  dispatchPayload: ScheduledInstructionDispatchPayload | null;
  result: JsonValue | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledInstructionDispatchPayload = {
  prompt: string;
  taskId: string;
  runId?: string;
  workspaceId?: string;
  cwd?: string;
  lockOwner?: string;
  skillSnapshots?: RuntimeSkillSessionSnapshot[];
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const safeGitRefSchema = v.pipe(
  nonEmptyStringSchema,
  v.check(
    (value) =>
      !value.startsWith('-') &&
      !value.includes('\u0000') &&
      !/[\s\\~^:?*[\]]/.test(value),
    'Expected a safe Git ref or SHA.',
  ),
);
const fullCommitShaSchema = v.pipe(
  v.string(),
  v.regex(
    /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/,
    'Pinned revisions require a full 40- or 64-character commit SHA.',
  ),
);
const uniqueSkillIdsSchema = v.pipe(
  v.array(nonEmptyStringSchema),
  v.check(
    (skills) => new Set(skills).size === skills.length,
    'Scheduled task skill ids must be unique.',
  ),
);
const relativeSubdirectorySchema = v.pipe(
  nonEmptyStringSchema,
  v.check(
    (value) =>
      !value.startsWith('/') &&
      !value.split('/').some((segment) => segment === '..' || segment === '.'),
    'Workspace subdirectory must be a safe repo-relative path.',
  ),
);
export const scheduledWorkspacePolicySchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('virtual') }),
  v.strictObject({
    kind: v.literal('repository'),
    repoId: nonEmptyStringSchema,
    providerId: v.pipe(
      nonEmptyStringSchema,
      v.regex(/^[a-z][a-z0-9.-]{0,62}$/),
    ),
    subdirectory: v.optional(relativeSubdirectorySchema),
    resource: v.strictObject({
      lifecycle: v.picklist(['per-run', 'reuse-task', 'existing']),
      existingResourceId: v.optional(nonEmptyStringSchema),
    }),
    revision: v.strictObject({
      ref: safeGitRefSchema,
      mode: v.picklist(['latest-each-run', 'pinned', 'continue']),
      sha: v.optional(fullCommitShaSchema),
    }),
    git: v.strictObject({
      mode: v.picklist(['run-branch', 'task-branch', 'direct-branch']),
      branch: v.optional(safeGitRefSchema),
      acknowledgeDirectBranch: v.optional(v.boolean()),
    }),
    authority: v.picklist([
      'read-only',
      'trusted-workspace',
      'delivery-enabled',
    ]),
    retention: v.optional(v.picklist(['cleanup-success', 'retain-always'])),
    overlap: v.optional(v.picklist(['skip', 'queue-one', 'allow-parallel'])),
  }),
]);
export const automationTriggerSchema = v.variant('kind', [
  v.object({
    kind: v.literal('interval'),
    everySeconds: v.pipe(v.number(), v.integer(), v.minValue(60)),
  }),
  v.object({
    kind: v.literal('once'),
    at: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('cron'),
    expression: nonEmptyStringSchema,
    timezone: nonEmptyStringSchema,
  }),
]);

export const scheduledTaskSpecSchema = v.variant('kind', [
  v.object({
    kind: v.literal('poll-pr-watch'),
    watchId: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('run-briefing'),
    briefingId: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('run-agent-instruction'),
    prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000)),
    target: v.variant('kind', [
      v.object({ kind: v.literal('agent') }),
      v.object({
        kind: v.literal('agent-session'),
        sessionId: nonEmptyStringSchema,
      }),
    ]),
    repoId: v.optional(nonEmptyStringSchema),
    cwd: v.optional(nonEmptyStringSchema),
    skills: uniqueSkillIdsSchema,
    workspace: v.optional(scheduledWorkspacePolicySchema),
  }),
]);

export function scheduledWorkspacePolicyIssue(
  policy: ScheduledWorkspacePolicy | undefined,
) {
  if (!policy || policy.kind === 'virtual') return undefined;
  if (
    policy.resource.lifecycle === 'existing' &&
    !policy.resource.existingResourceId
  ) {
    return 'Existing workspace lifecycle requires existingResourceId.';
  }
  if (
    policy.resource.lifecycle !== 'existing' &&
    policy.resource.existingResourceId
  ) {
    return 'existingResourceId is valid only for an existing workspace.';
  }
  if (policy.revision.mode === 'pinned' && !policy.revision.sha) {
    return 'Pinned revision mode requires a full commit SHA.';
  }
  if (
    policy.revision.mode === 'continue' &&
    (policy.git.mode !== 'task-branch' ||
      policy.resource.lifecycle === 'per-run')
  ) {
    return 'Continue mode requires a persistent task branch and reusable or existing workspace.';
  }
  if (
    policy.git.mode === 'task-branch' &&
    policy.revision.mode !== 'continue'
  ) {
    return 'Persistent task branches require continue revision mode.';
  }
  if (
    policy.revision.mode === 'continue' &&
    policy.git.mode !== 'task-branch'
  ) {
    return 'Continue revision mode requires a persistent task branch.';
  }
  if (
    policy.git.mode === 'direct-branch' &&
    (policy.resource.lifecycle === 'per-run' ||
      policy.overlap === 'allow-parallel' ||
      policy.git.acknowledgeDirectBranch !== true)
  ) {
    return 'Direct branch mode requires a reusable or existing serialized workspace and explicit acknowledgement.';
  }
  if (
    policy.overlap === 'allow-parallel' &&
    (policy.resource.lifecycle !== 'per-run' ||
      policy.git.mode !== 'run-branch')
  ) {
    return 'Parallel runs require a per-run workspace and run branch.';
  }
  if (policy.git.mode === 'direct-branch' && !policy.git.branch) {
    return 'direct-branch requires an explicit branch.';
  }
  if (policy.git.mode === 'run-branch' && policy.git.branch) {
    return 'Run branches use a unique generated branch name for each occurrence.';
  }
  return undefined;
}

export function scheduledTaskSpecIssue(spec: ScheduledTaskSpec) {
  if (spec.kind !== 'run-agent-instruction') return undefined;
  if (new Set(spec.skills).size !== spec.skills.length) {
    return 'Scheduled task skill ids must be unique.';
  }
  if (spec.workspace?.kind !== 'repository') return undefined;
  if (spec.repoId !== undefined || spec.cwd !== undefined) {
    return 'Repository workspace tasks must use workspace.repoId and workspace.subdirectory; legacy repoId/cwd fields are not accepted.';
  }
  if (
    spec.target.kind === 'agent-session' &&
    spec.workspace.overlap === 'allow-parallel'
  ) {
    return 'Repository agent-session targets require serialized overlap.';
  }
  return scheduledWorkspacePolicyIssue(spec.workspace);
}
