import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { checkAutopilotPolicy } from './autopilot-policy';
import { verifyPrWorktree } from './autopilot-workflows';
import { getGitHubPrBranchPermissions } from './pr-event-state';
import { ensurePreparedDiffForWorktree } from './prepared-diffs';
import { gitDiff } from './repo-edit/git';
import { type RepoDiffSummary } from './repos';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { listWorktrees, type WorktreeRecord } from './worktrees';

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

type KiloTaskLike = {
  id: string;
  title: string;
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  cwd: string;
  status: string;
};

type KiloResultActionResult = {
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

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const taskIdInputSchema = v.object({
  taskId: nonEmptyStringSchema,
});
const verifyInputSchema = v.strictObject({
  taskId: nonEmptyStringSchema,
  checks: v.optional(v.array(nonEmptyStringSchema)),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  lock: v.optional(v.boolean()),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const promoteInputSchema = v.strictObject({
  taskId: nonEmptyStringSchema,
});
const stateListInputSchema = v.object({
  taskId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
const taskRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  worktree_id: v.nullable(v.string()),
  cwd: v.string(),
  status: v.string(),
});
const stateRowSchema = v.object({
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

export const kiloResultStateLookupTool = defineTool({
  name: 'neondeck_kilo_result_state_lookup',
  description:
    'Read persisted Kilo review, verification, promotion, and pending approval state without mutating tasks.',
  input: stateListInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listKiloResultStates(input);
  },
});

export const reviewKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_review',
  description:
    'Inspect a Kilo task workspace diff, classify risk with autopilot policy, and persist Kilo result review state.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return reviewKiloResult(input);
  },
});

export const verifyKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_verify',
  description:
    'Run configured checks for a Kilo task worktree through Neondeck execution approval policy and persist verification state.',
  input: verifyInputSchema,
  output: outputSchema,
  async run({ input }) {
    return verifyKiloResult(input);
  },
});

export const promoteKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_promote',
  description:
    'Decide whether a Kilo result is admissible for promotion. This records the safe decision layer and does not commit, push, or comment.',
  input: promoteInputSchema,
  output: outputSchema,
  async run({ input }) {
    return promoteKiloResult(input);
  },
});

export const neondeckKiloResultActions = [
  reviewKiloResultAction,
  verifyKiloResultAction,
  promoteKiloResultAction,
];

export const neondeckKiloResultTools = [kiloResultStateLookupTool];

export async function reviewKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_result_review');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_review', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_review');
  if (!reviewAdmission.ok) return reviewAdmission.result;

  const diff = await readTaskDiff(task);
  const worktree = await findTaskWorktree(task, paths);
  const hasReviewableDiff = diff.ok && diff.fileCount > 0;
  const previous = readKiloResultState(task.id, paths);
  const fingerprint = await diffFingerprintForTask(task, diff);
  const diffChanged = Boolean(
    previous?.diffFingerprint && previous.diffFingerprint !== fingerprint,
  );
  const preparedDiff =
    worktree && hasReviewableDiff
      ? await ensurePreparedDiffForWorktree(worktree, paths, {
          title: `Kilo: ${task.title}`,
          createdBy: 'kilo',
          summary: {
            kiloTaskId: task.id,
            source: 'review_kilo_result',
          },
        })
      : null;
  const adoptedExistingPreparedDiff = Boolean(preparedDiff && !previous);
  if (preparedDiff && (diffChanged || adoptedExistingPreparedDiff)) {
    resetPreparedDiffApproval(
      preparedDiff.id,
      diffChanged
        ? 'Kilo result diff changed after earlier review.'
        : 'Kilo adopted this prepared diff; previous push decision is no longer current.',
      paths,
    );
  }
  const preparedDiffForState =
    preparedDiff && (diffChanged || adoptedExistingPreparedDiff)
      ? { ...preparedDiff, pushApprovalStatus: 'pending' }
      : preparedDiff;
  const policy = worktree
    ? await checkAutopilotPolicy({ worktreeId: worktree.id }, paths)
    : null;
  const classification = classifyReview(task, diff, worktree, policy);
  const summary = {
    classification,
    reasons: reviewReasons(task, diff, worktree, policy),
    changedFiles: diff.files.map((file) => file.path),
  };
  const state = upsertKiloResultState(
    task.id,
    {
      preparedDiffId: preparedDiffForState?.id ?? null,
      classification,
      verificationStatus: 'not-run',
      promotionStatus: 'not-requested',
      diffFingerprint: fingerprint,
      verifiedDiffFingerprint: null,
      reviewSummary: summary,
      diffSummary: diff,
      policy,
      verification: null,
      promotion: null,
      pendingApprovals: pendingApprovalsFor(preparedDiffForState, policy),
      reviewedAt: new Date().toISOString(),
      verifiedAt: null,
      promotedAt: null,
    },
    paths,
  );
  updateKiloTaskStatus(
    task.id,
    taskStatusForClassification(classification),
    paths,
  );
  insertKiloResultEvent(
    task.id,
    'review',
    `Kilo result classified as ${classification}.`,
    {
      classification,
      preparedDiffId: preparedDiffForState?.id ?? null,
      diffFingerprint: fingerprint,
      diffChanged,
      summary,
    },
    paths,
  );

  return {
    ok: true,
    action: 'kilo_result_review',
    changed: true,
    message: `Kilo result classified as ${classification}.`,
    task: readKiloTask(task.id, paths) ?? task,
    resultState: state,
    diff,
    data: asJsonValue({
      nextWorkflow:
        classification === 'ready-to-verify'
          ? 'verify_kilo_result'
          : classification === 'ready-to-push'
            ? 'promote_kilo_result'
            : null,
      preparedDiff: preparedDiffForState,
      policy,
    }),
  };
}

export async function verifyKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(verifyInputSchema, rawInput, 'kilo_result_verify');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_verify', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_verify');
  if (!reviewAdmission.ok) return reviewAdmission.result;
  const stateBefore = readKiloResultState(task.id, paths);
  const reviewGate = await assertVerificationGate(task, stateBefore, paths);
  if (!reviewGate.ok) {
    const state = upsertKiloResultState(
      task.id,
      {
        verificationStatus: 'blocked',
        verification: { reason: reviewGate.message },
      },
      paths,
    );
    return {
      ok: false,
      action: 'kilo_result_verify',
      changed: true,
      message: reviewGate.message,
      task,
      resultState: state,
      requires: reviewGate.requires,
    };
  }
  if (!task.worktreeId) {
    const state = upsertKiloResultState(
      task.id,
      {
        verificationStatus: 'blocked',
        verification: {
          reason: 'Kilo verification requires a managed worktree.',
        },
      },
      paths,
    );
    return {
      ok: false,
      action: 'kilo_result_verify',
      changed: true,
      message: 'Kilo verification requires a managed worktree.',
      task,
      resultState: state,
      requires: ['worktreeId'],
    };
  }

  upsertKiloResultState(
    task.id,
    {
      verificationStatus: 'running',
      verification: { startedAt: new Date().toISOString() },
    },
    paths,
  );
  insertKiloResultEvent(
    task.id,
    'verification.started',
    'Started Kilo result verification through the autopilot verifier.',
    { worktreeId: task.worktreeId, checks: parsed.input.checks ?? null },
    paths,
  );

  const result = await verifyPrWorktree(
    {
      worktreeId: task.worktreeId,
      checks: parsed.input.checks,
      backend: parsed.input.backend,
      context: parsed.input.context,
      lock: parsed.input.lock,
      timeoutMs: parsed.input.timeoutMs,
      maxOutputBytes: parsed.input.maxOutputBytes,
    },
    paths,
  );
  const blocked = Array.isArray(result.requires) && result.requires.length > 0;
  const verificationStatus: KiloVerificationStatus = result.ok
    ? 'passed'
    : blocked
      ? 'blocked'
      : 'failed';
  const policy = task.worktreeId
    ? await checkAutopilotPolicy(
        { worktreeId: task.worktreeId, pushDestination: 'pull-request-head' },
        paths,
      )
    : null;
  const nextClassification: KiloResultClassification =
    result.ok && policy?.mode === 'autofix-push-when-safe'
      ? 'ready-to-push'
      : 'needs-review';
  const state = upsertKiloResultState(
    task.id,
    {
      classification: nextClassification,
      verificationStatus,
      verification: result,
      verifiedDiffFingerprint: result.ok ? reviewGate.fingerprint : null,
      verifiedAt: new Date().toISOString(),
    },
    paths,
  );
  updateKiloTaskStatus(task.id, nextClassification, paths);
  insertKiloResultEvent(
    task.id,
    `verification.${verificationStatus}`,
    result.message,
    result,
    paths,
  );

  return {
    ok: result.ok,
    action: 'kilo_result_verify',
    changed: true,
    message: result.ok ? 'Kilo result verification passed.' : result.message,
    task: readKiloTask(task.id, paths) ?? task,
    resultState: state,
    data: asJsonValue({ verification: result }),
    ...(result.requires ? { requires: result.requires } : {}),
    ...(result.errors ? { errors: result.errors } : {}),
  };
}

export async function promoteKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(
    promoteInputSchema,
    rawInput,
    'kilo_result_promote',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_promote', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_promote');
  if (!reviewAdmission.ok) return reviewAdmission.result;
  const worktree = await findTaskWorktree(task, paths);
  const state = readKiloResultState(task.id, paths);
  const policy = worktree
    ? await checkAutopilotPolicy(
        { worktreeId: worktree.id, pushDestination: 'pull-request-head' },
        paths,
      )
    : null;
  const currentDiff = await readTaskDiff(task);
  const currentFingerprint = await diffFingerprintForTask(task, currentDiff);
  const noCheckReadyToPush = Boolean(
    state?.classification === 'ready-to-push' &&
    state?.verificationStatus === 'not-run' &&
    policy?.ok &&
    policy.limits.requiredChecks.length === 0 &&
    state.diffFingerprint === currentFingerprint,
  );
  const gates: Array<{ gate: string; ok: boolean; reason: string }> = [];

  gates.push({
    gate: 'managed-worktree',
    ok: Boolean(worktree),
    reason: worktree
      ? 'Kilo task is linked to a managed worktree.'
      : 'Kilo task is not linked to a managed worktree.',
  });
  gates.push({
    gate: 'verification',
    ok: state?.verificationStatus === 'passed' || noCheckReadyToPush,
    reason:
      state?.verificationStatus === 'passed'
        ? 'Kilo verification has passed.'
        : noCheckReadyToPush
          ? 'No required checks are configured and the reviewed Kilo result is ready to push.'
          : 'Kilo verification has not passed.',
  });
  gates.push({
    gate: 'verified-diff',
    ok:
      state?.diffFingerprint === currentFingerprint &&
      (state?.verifiedDiffFingerprint === currentFingerprint ||
        noCheckReadyToPush),
    reason:
      state?.diffFingerprint === currentFingerprint &&
      (state?.verifiedDiffFingerprint === currentFingerprint ||
        noCheckReadyToPush)
        ? 'Current diff matches the reviewed and verified Kilo result.'
        : 'Current diff does not match the reviewed and verified Kilo result.',
  });

  gates.push({
    gate: 'autopilot-policy',
    ok: Boolean(policy?.ok && !policy.blocked && !policy.approvalRequired),
    reason:
      policy?.ok && !policy.blocked && !policy.approvalRequired
        ? 'Autopilot policy allows the diff.'
        : (policy?.message ?? 'Autopilot policy could not be evaluated.'),
  });
  gates.push({
    gate: 'autopilot-mode',
    ok: policy?.mode === 'autofix-push-when-safe',
    reason:
      policy?.mode === 'autofix-push-when-safe'
        ? 'Repo policy allows push when safe.'
        : `Repo policy mode is ${policy?.mode ?? 'unknown'}, not autofix-push-when-safe.`,
  });

  const preparedDiff = worktree
    ? readPreparedDiffByWorktree(worktree.id, paths)
    : null;
  gates.push({
    gate: 'prepared-diff-approval',
    ok: preparedDiff?.pushApprovalStatus === 'approved',
    reason:
      preparedDiff?.pushApprovalStatus === 'approved'
        ? 'Prepared diff push approval is approved.'
        : `Prepared diff push approval is ${preparedDiff?.pushApprovalStatus ?? 'missing'}.`,
  });

  const permissions =
    worktree?.prNumber && process.env.GITHUB_TOKEN
      ? await getGitHubPrBranchPermissions(
          { repo: worktree.repoFullName, prNumber: worktree.prNumber },
          paths,
        )
      : null;
  const canLikelyPush = Boolean(
    jsonBoolean(permissions?.data, ['branchPermissions', 'canLikelyPush']) ??
    worktree?.directPushAllowed,
  );
  gates.push({
    gate: 'github-permissions',
    ok: canLikelyPush,
    reason: canLikelyPush
      ? 'GitHub permission facts allow likely push-back.'
      : permissions
        ? permissions.message
        : 'GitHub permission facts are unavailable and worktree directPushAllowed is false.',
  });

  const admitted = gates.every((gate) => gate.ok);
  const promotion = {
    admitted,
    deferred: admitted,
    actualMutations: [],
    gates,
    policy,
    preparedDiff,
    permissions: permissions ?? null,
    deferral:
      'Actual commit, push, and PR comment mutations are deferred to the later push-back workflow.',
  };
  const next = upsertKiloResultState(
    task.id,
    {
      promotionStatus: admitted ? 'deferred' : 'blocked',
      promotion,
      policy,
      pendingApprovals: pendingApprovalsFor(preparedDiff, policy),
      promotedAt: new Date().toISOString(),
    },
    paths,
  );
  insertKiloResultEvent(
    task.id,
    admitted ? 'promotion.deferred' : 'promotion.blocked',
    admitted
      ? 'Kilo result passed promotion admission; actual push/comment is deferred.'
      : 'Kilo result is blocked from promotion.',
    promotion,
    paths,
  );

  return {
    ok: admitted,
    action: 'kilo_result_promote',
    changed: true,
    message: admitted
      ? 'Kilo result passed promotion admission. Commit, push, and comment are deferred.'
      : 'Kilo result did not pass promotion admission.',
    task,
    resultState: next,
    data: asJsonValue(promotion),
    requires: admitted
      ? ['push_pr_autofix']
      : gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
  };
}

export async function listKiloResultStates(
  rawInput: unknown = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult & { resultStates?: KiloResultState[] }> {
  const parsed = parseInput(
    stateListInputSchema,
    rawInput,
    'kilo_result_state',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = parsed.input.taskId
      ? database
          .prepare('SELECT * FROM kilo_result_state WHERE task_id = ?;')
          .all(parsed.input.taskId)
      : database
          .prepare(
            `
            SELECT *
            FROM kilo_result_state
            ORDER BY updated_at DESC
            LIMIT ?;
          `,
          )
          .all(parsed.input.limit ?? 50);
    const resultStates = rows.map(readStateRow);
    return {
      ok: true,
      action: 'kilo_result_state',
      changed: false,
      message: `Read ${resultStates.length} Kilo result state record(s).`,
      resultStates,
    };
  } finally {
    database.close();
  }
}

export function readKiloResultStateSummary(
  taskId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const state = readKiloResultState(taskId, paths);
  if (!state) {
    return {
      verificationState: 'not-run',
      reviewClassification: null,
      promotionState: 'not-requested',
      preparedDiffId: null,
      pendingApprovals: [],
    };
  }
  return {
    verificationState: state.verificationStatus,
    reviewClassification: state.classification,
    promotionState: state.promotionStatus,
    preparedDiffId: state.preparedDiffId,
    pendingApprovals: state.pendingApprovals,
  };
}

function classifyReview(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
  worktree: WorktreeRecord | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
): KiloResultClassification {
  if (!diff.ok || task.status === 'failed' || task.status === 'unknown') {
    return diff.fileCount > 0 ? 'needs-review' : 'discard';
  }
  if (diff.fileCount === 0) return 'discard';
  if (!worktree || !policy?.ok || policy.blocked || policy.approvalRequired) {
    return 'needs-review';
  }
  if (policy.limits.requiredChecks.length > 0) return 'ready-to-verify';
  return policy.mode === 'autofix-push-when-safe'
    ? 'ready-to-push'
    : 'needs-review';
}

function reviewReasons(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
  worktree: WorktreeRecord | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
) {
  const reasons: string[] = [];
  if (!diff.ok) reasons.push(diff.error ?? 'Diff could not be read.');
  if (diff.fileCount === 0) reasons.push('No changed files were observed.');
  if (task.status === 'failed') reasons.push('Kilo task failed.');
  if (task.status === 'unknown') reasons.push('Kilo task outcome is unknown.');
  if (!worktree) reasons.push('No managed worktree is linked to this task.');
  if (policy?.reasons.length) reasons.push(...policy.reasons);
  return reasons;
}

function taskStatusForClassification(classification: KiloResultClassification) {
  if (classification === 'discard') return 'discarded';
  return classification;
}

function assertReviewableTask(
  task: KiloTaskLike,
  action: string,
):
  | { ok: true }
  | {
      ok: false;
      result: KiloResultActionResult;
    } {
  const allowed = new Set([
    'succeeded',
    'failed',
    'unknown',
    'needs-review',
    'ready-to-verify',
    'ready-to-push',
  ]);
  if (allowed.has(task.status)) return { ok: true };
  return {
    ok: false,
    result: {
      ok: false,
      action,
      changed: false,
      message: `Kilo task ${task.id} is ${task.status}; review and verification require a completed result.`,
      task,
      requires: ['completed-kilo-task'],
    },
  };
}

async function assertVerificationGate(
  task: KiloTaskLike,
  state: KiloResultState | null,
  paths: RuntimePaths,
): Promise<
  | { ok: true; fingerprint: string }
  | { ok: false; message: string; requires: string[] }
> {
  if (!state) {
    return {
      ok: false,
      message: 'Kilo result must be reviewed before verification.',
      requires: ['review_kilo_result'],
    };
  }
  if (state.classification !== 'ready-to-verify') {
    return {
      ok: false,
      message: `Kilo result is ${state.classification}, not ready-to-verify.`,
      requires: ['ready-to-verify'],
    };
  }
  const diff = await readTaskDiff(task);
  if (!diff.ok || diff.fileCount === 0) {
    return {
      ok: false,
      message: 'Kilo result has no reviewable diff to verify.',
      requires: ['reviewable-diff'],
    };
  }
  const fingerprint = await diffFingerprintForTask(task, diff);
  if (state.diffFingerprint !== fingerprint) {
    return {
      ok: false,
      message:
        'Kilo result diff changed after review; run review_kilo_result again before verification.',
      requires: ['review_kilo_result'],
    };
  }
  if (!task.worktreeId || !(await findTaskWorktree(task, paths))) {
    return {
      ok: false,
      message: 'Kilo verification requires a managed worktree.',
      requires: ['worktreeId'],
    };
  }
  return { ok: true, fingerprint };
}

async function diffFingerprintForTask(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
) {
  const patch = await gitDiff(task.cwd, {
    base: 'HEAD',
    includePatch: true,
    maxPatchBytes: 1024 * 1024,
  }).catch(() => null);
  return createHash('sha256')
    .update(
      JSON.stringify({
        ok: diff.ok,
        baseRef: diff.baseRef,
        fileCount: diff.fileCount,
        additions: diff.additions,
        deletions: diff.deletions,
        binaryFiles: diff.binaryFiles,
        files: diff.files
          .map((file) => ({
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        patches:
          patch?.files
            .map((file) => ({
              path: file.path,
              status: file.status,
              patch: file.patch ?? null,
              truncated: file.truncated ?? false,
            }))
            .sort((a, b) => a.path.localeCompare(b.path)) ?? null,
      }),
    )
    .digest('hex');
}

async function readTaskDiff(task: KiloTaskLike) {
  const diff = await gitDiff(task.cwd, { base: 'HEAD', includePatch: false });
  return {
    ok: true,
    repo: task.repoFullName,
    path: task.cwd,
    baseRef: 'HEAD',
    files: diff.files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    fileCount: diff.files.length,
    additions: diff.summary.additions,
    deletions: diff.summary.deletions,
    binaryFiles: diff.summary.binaryFiles,
  } satisfies RepoDiffSummary;
}

async function findTaskWorktree(task: KiloTaskLike, paths: RuntimePaths) {
  if (!task.worktreeId) return null;
  const snapshot = await listWorktrees(paths);
  return (
    snapshot.worktrees.find((worktree) => worktree.id === task.worktreeId) ??
    null
  );
}

function readKiloTask(taskId: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT id, title, repo_id, repo_full_name, worktree_id, cwd, status
        FROM kilo_tasks
        WHERE id = ?;
      `,
      )
      .get(taskId);
    if (!row) return null;
    const parsed = v.parse(taskRowSchema, row);
    return {
      id: parsed.id,
      title: parsed.title,
      repoId: parsed.repo_id,
      repoFullName: parsed.repo_full_name,
      worktreeId: parsed.worktree_id,
      cwd: parsed.cwd,
      status: parsed.status,
    };
  } finally {
    database.close();
  }
}

function readKiloResultState(taskId: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM kilo_result_state WHERE task_id = ?;')
      .get(taskId);
    return row ? readStateRow(row) : null;
  } finally {
    database.close();
  }
}

function readPreparedDiffByWorktree(worktreeId: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT id, push_approval_status
        FROM prepared_diffs
        WHERE worktree_id = ?;
      `,
      )
      .get(worktreeId) as
      { id: string; push_approval_status: string } | undefined;
    return row
      ? {
          id: row.id,
          pushApprovalStatus: row.push_approval_status,
        }
      : null;
  } finally {
    database.close();
  }
}

function resetPreparedDiffApproval(
  preparedDiffId: string,
  reason: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT id, worktree_id, push_approval_status
        FROM prepared_diffs
        WHERE id = ?;
      `,
      )
      .get(preparedDiffId) as
      | { id: string; worktree_id: string; push_approval_status: string }
      | undefined;
    if (!row || row.push_approval_status === 'pending') return;
    database
      .prepare(
        `
        UPDATE prepared_diffs
        SET push_approval_status = 'pending',
            verification_status = 'not-run',
            status = 'prepared',
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, preparedDiffId);
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET status = 'superseded',
            reason = COALESCE(reason, ?),
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE prepared_diff_id = ?
          AND status IN ('pending', 'approved');
      `,
      )
      .run(reason, now, now, preparedDiffId);
    database
      .prepare(
        `
        INSERT INTO prepared_diff_approvals (
          id, prepared_diff_id, worktree_id, approval_type, status, reason,
          approver_surface, requested_at, resolved_at, updated_at
        )
        VALUES (?, ?, ?, 'push', 'pending', ?, 'kilo_result_review', ?, NULL, ?);
      `,
      )
      .run(randomUUID(), preparedDiffId, row.worktree_id, reason, now, now);
  } finally {
    database.close();
  }
}

function upsertKiloResultState(
  taskId: string,
  input: Partial<
    Pick<
      KiloResultState,
      | 'preparedDiffId'
      | 'classification'
      | 'verificationStatus'
      | 'promotionStatus'
      | 'diffFingerprint'
      | 'verifiedDiffFingerprint'
      | 'reviewSummary'
      | 'diffSummary'
      | 'policy'
      | 'verification'
      | 'promotion'
      | 'pendingApprovals'
      | 'reviewedAt'
      | 'verifiedAt'
      | 'promotedAt'
    >
  >,
  paths: RuntimePaths,
) {
  const current = readKiloResultState(taskId, paths);
  const now = new Date().toISOString();
  const state: KiloResultState = {
    taskId,
    preparedDiffId: input.preparedDiffId ?? current?.preparedDiffId ?? null,
    classification:
      input.classification ?? current?.classification ?? 'needs-review',
    verificationStatus:
      input.verificationStatus ?? current?.verificationStatus ?? 'not-run',
    promotionStatus:
      input.promotionStatus ?? current?.promotionStatus ?? 'not-requested',
    diffFingerprint: stateField(
      input,
      'diffFingerprint',
      current?.diffFingerprint ?? null,
    ),
    verifiedDiffFingerprint: stateField(
      input,
      'verifiedDiffFingerprint',
      current?.verifiedDiffFingerprint ?? null,
    ),
    reviewSummary: stateField(
      input,
      'reviewSummary',
      current?.reviewSummary ?? null,
    ),
    diffSummary: stateField(input, 'diffSummary', current?.diffSummary ?? null),
    policy: stateField(input, 'policy', current?.policy ?? null),
    verification: stateField(
      input,
      'verification',
      current?.verification ?? null,
    ),
    promotion: stateField(input, 'promotion', current?.promotion ?? null),
    pendingApprovals: input.pendingApprovals ?? current?.pendingApprovals ?? [],
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    reviewedAt: input.reviewedAt ?? current?.reviewedAt ?? null,
    verifiedAt: stateField(input, 'verifiedAt', current?.verifiedAt ?? null),
    promotedAt: stateField(input, 'promotedAt', current?.promotedAt ?? null),
  };
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_result_state (
          task_id, prepared_diff_id, classification, verification_status,
          promotion_status, diff_fingerprint, verified_diff_fingerprint,
          review_summary_json, diff_summary_json, policy_json,
          verification_json, promotion_json, pending_approvals_json,
          created_at, updated_at, reviewed_at, verified_at, promoted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          prepared_diff_id = excluded.prepared_diff_id,
          classification = excluded.classification,
          verification_status = excluded.verification_status,
          promotion_status = excluded.promotion_status,
          diff_fingerprint = excluded.diff_fingerprint,
          verified_diff_fingerprint = excluded.verified_diff_fingerprint,
          review_summary_json = excluded.review_summary_json,
          diff_summary_json = excluded.diff_summary_json,
          policy_json = excluded.policy_json,
          verification_json = excluded.verification_json,
          promotion_json = excluded.promotion_json,
          pending_approvals_json = excluded.pending_approvals_json,
          updated_at = excluded.updated_at,
          reviewed_at = excluded.reviewed_at,
          verified_at = excluded.verified_at,
          promoted_at = excluded.promoted_at;
      `,
      )
      .run(
        state.taskId,
        state.preparedDiffId,
        state.classification,
        state.verificationStatus,
        state.promotionStatus,
        state.diffFingerprint,
        state.verifiedDiffFingerprint,
        jsonOrNull(state.reviewSummary),
        jsonOrNull(state.diffSummary),
        jsonOrNull(state.policy),
        jsonOrNull(state.verification),
        jsonOrNull(state.promotion),
        JSON.stringify(state.pendingApprovals),
        state.createdAt,
        state.updatedAt,
        state.reviewedAt,
        state.verifiedAt,
        state.promotedAt,
      );
  } finally {
    database.close();
  }
  return state;
}

function stateField<TKey extends keyof KiloResultState>(
  input: Partial<KiloResultState>,
  key: TKey,
  fallback: KiloResultState[TKey],
): KiloResultState[TKey] {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? (input[key] as KiloResultState[TKey])
    : fallback;
}

function updateKiloTaskStatus(
  taskId: string,
  status: string,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, new Date().toISOString(), taskId);
  } finally {
    database.close();
  }
}

function insertKiloResultEvent(
  taskId: string,
  eventType: string,
  summary: string,
  data: unknown,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_result_events (
          id, task_id, event_type, summary, data_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        taskId,
        eventType,
        summary,
        data === null || data === undefined
          ? null
          : JSON.stringify(asJsonValue(data)),
        now,
      );
  } finally {
    database.close();
  }
}

function readStateRow(row: unknown): KiloResultState {
  const parsed = v.parse(stateRowSchema, row);
  return {
    taskId: parsed.task_id,
    preparedDiffId: parsed.prepared_diff_id,
    classification: parseClassification(parsed.classification),
    verificationStatus: parseVerificationStatus(parsed.verification_status),
    promotionStatus: parsePromotionStatus(parsed.promotion_status),
    diffFingerprint: parsed.diff_fingerprint,
    verifiedDiffFingerprint: parsed.verified_diff_fingerprint,
    reviewSummary: parseJson(parsed.review_summary_json),
    diffSummary: parseJson(parsed.diff_summary_json),
    policy: parseJson(parsed.policy_json),
    verification: parseJson(parsed.verification_json),
    promotion: parseJson(parsed.promotion_json),
    pendingApprovals: parseJsonArray(parsed.pending_approvals_json),
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    reviewedAt: parsed.reviewed_at,
    verifiedAt: parsed.verified_at,
    promotedAt: parsed.promoted_at,
  };
}

function pendingApprovalsFor(
  preparedDiff: { id: string; pushApprovalStatus: string } | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
): JsonValue[] {
  const approvals: JsonValue[] = [];
  if (preparedDiff?.pushApprovalStatus === 'pending') {
    approvals.push({
      type: 'prepared-diff-push',
      status: 'pending',
      preparedDiffId: preparedDiff.id,
    });
  }
  if (policy?.approvalRequired) {
    approvals.push({
      type: 'autopilot-policy',
      status: 'required',
      requires: policy.requires,
    });
  }
  return approvals;
}

function parseClassification(value: string): KiloResultClassification {
  const parsed = v.safeParse(
    v.picklist(['discard', 'needs-review', 'ready-to-verify', 'ready-to-push']),
    value,
  );
  return parsed.success ? parsed.output : 'needs-review';
}

function parseVerificationStatus(value: string): KiloVerificationStatus {
  const parsed = v.safeParse(
    v.picklist(['not-run', 'running', 'passed', 'failed', 'blocked']),
    value,
  );
  return parsed.success ? parsed.output : 'not-run';
}

function parsePromotionStatus(value: string): KiloPromotionStatus {
  const parsed = v.safeParse(
    v.picklist(['not-requested', 'blocked', 'ready', 'deferred']),
    value,
  );
  return parsed.success ? parsed.output : 'not-requested';
}

function parseInput<T>(
  schema: v.GenericSchema<unknown, T>,
  rawInput: unknown,
  action: string,
): { ok: true; input: T } | { ok: false; result: KiloResultActionResult } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: {
      ok: false,
      action,
      changed: false,
      message: `Invalid Kilo result input: ${v.summarize(parsed.issues)}`,
      errors: parsed.issues.map((issue) => issue.message),
    },
  };
}

function notFound(action: string, taskId: string): KiloResultActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: `Kilo task ${taskId} was not found.`,
    requires: ['taskId'],
  };
}

function jsonBoolean(value: unknown, path: string[]) {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'boolean' ? cursor : null;
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined
    ? null
    : JSON.stringify(asJsonValue(value));
}

function parseJson(value: string | null): JsonValue | null {
  if (value === null) return null;
  try {
    return asJsonValue(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseJsonArray(value: string): JsonValue[] {
  try {
    const parsed = v.safeParse(v.array(v.unknown()), JSON.parse(value));
    return parsed.success ? parsed.output.map(asJsonValue) : [];
  } catch {
    return [];
  }
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
