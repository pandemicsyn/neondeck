import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { gitCurrentSha } from '../../../repo-edit/git';
import { parseV4APatch } from '../../../repo-edit/patch-parser';
import { resolveRepoPath } from '../../../repo-edit/path-safety';
import { replaceContent } from '../../../repo-edit/fuzzy-replace';
import { readRepoDiff } from '../../../repo-edit';
import { reviewRevisionKey } from '../../../../shared/review-source';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicyForWatch,
  repoGuardrails,
} from '../../autopilot-policy';
import { readRepoRegistrySnapshot } from '../../repos';
import { readWorktreeRecord } from '../../worktrees';
import { readWorktreeStatus } from '../../worktrees';
import { evaluateRepoGuardrails } from '../../repo-guardrails';
import { fixPrCiFailure } from '../ci-fix';
import {
  readAutopilotAdmission,
  readAutopilotPrOwner,
  readAutopilotStageAttempt,
} from '../coordination/schemas';
import { fixPrReviewFeedback } from '../review-feedback';
import { autopilotOutputSchema, reviewFixReplacementSchema } from '../schemas';
import {
  classifyAutopilotOwnerConfigChange,
  stableJsonHash,
} from '../owner/grounding';
import {
  autopilotOwnerPolicySnapshot,
  constrainAutopilotAdmissionAuthority,
} from '../owner/policy';
import { settlePendingAutopilotOwnerObservation } from '../owner/settle';
import { fetchPullRequestDetail } from '../../github';
import {
  claimAutopilotSubmissionProcessLease,
  releaseAutopilotSubmissionProcessLease,
} from '../owner/submission-lease';

const nonEmpty = v.pipe(v.string(), v.minLength(1), v.maxLength(2_048));
const boundedList = v.optional(v.pipe(v.array(nonEmpty), v.maxLength(64)));
export const submitAutopilotFixInputSchema = v.strictObject({
  admissionId: nonEmpty,
  attemptId: nonEmpty,
  token: nonEmpty,
  sourceEventFingerprint: nonEmpty,
  worktreeId: nonEmpty,
  expectedPrHeadSha: nonEmpty,
  expectedWorktreeHeadSha: nonEmpty,
  policyHash: nonEmpty,
  disposition: v.picklist(['fix', 'no-op']),
  fixerKind: v.optional(v.picklist(['review', 'ci'])),
  addressedReviewCommentIds: boundedList,
  addressedReviewThreadIds: boundedList,
  replacements: v.optional(
    v.pipe(v.array(reviewFixReplacementSchema), v.maxLength(100)),
  ),
  patch: v.optional(v.pipe(v.string(), v.maxLength(256 * 1024))),
  diagnostics: boundedList,
  checks: boundedList,
  testsAttempted: boundedList,
  summary: nonEmpty,
  confidence: v.optional(v.picklist(['low', 'medium', 'high'])),
  risk: v.optional(v.picklist(['low', 'medium', 'high'])),
  remainingBlockers: boundedList,
});

type SubmitInput = v.InferOutput<typeof submitAutopilotFixInputSchema>;
const groundingScopeRowSchema = v.looseObject({
  submit_token_hash: nonEmpty,
  status: v.picklist(['reserved', 'accepted', 'blocked', 'orphaned']),
  worktree_id: v.nullable(v.string()),
  pr_head_sha: v.nullable(v.string()),
  worktree_head_sha: v.nullable(v.string()),
  policy_hash: v.string(),
  diff_base_sha: v.string(),
  diff_revision_key: v.string(),
});
const mutationFenceRowSchema = v.looseObject({
  submission_status: v.literal('applying'),
  submission_epoch: v.number(),
  cancellation_requested_at: v.nullable(v.string()),
  attempt_status: v.literal('running'),
  mutation_epoch: v.number(),
  stop_requested_at: v.nullable(v.string()),
  current_stage_attempt_id: v.string(),
  state: v.literal('owner-turn-running'),
  repo_id: v.string(),
  watch_id: v.string(),
  worktree_head_sha: v.string(),
  pr_head_sha: v.string(),
  base_sha: v.string(),
  checkout_branch: v.string(),
  checkout_detached: v.number(),
  diff_base_sha: v.string(),
  diff_revision_key: v.string(),
  repo_binding_hash: v.string(),
  workspace_binding_hash: v.string(),
  policy_hash: v.string(),
  grounding_config_history_id: v.number(),
});
const mutationFenceConfigRowSchema = v.looseObject({
  action: v.string(),
  target: v.nullable(v.string()),
});
type FixResult = Awaited<ReturnType<typeof fixPrReviewFeedback>>;
type SubmitDependencies = {
  currentSha?: typeof gitCurrentSha;
  readDiff?: typeof readRepoDiff;
  readLiveHead?: (input: {
    owner: string;
    repo: string;
    prNumber: number;
  }) => Promise<string>;
  runReviewFix?: typeof fixPrReviewFeedback;
  runCiFix?: typeof fixPrCiFailure;
};

export const submitAutopilotFixAction = defineAction({
  name: 'neondeck_autopilot_submit_fix',
  description:
    'Submit exactly one fix or explicit no-op for the current private PR-owner turn. Scope is bound to the authoritative envelope token.',
  input: submitAutopilotFixInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return submitAutopilotFix(input);
  },
});

export async function submitAutopilotFix(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: SubmitDependencies = {},
) {
  const parsed = v.safeParse(submitAutopilotFixInputSchema, rawInput);
  if (!parsed.success) {
    return failure('Invalid scoped fix submission.', [
      v.summarize(parsed.issues),
    ]);
  }
  const input = parsed.output;
  if (Buffer.byteLength(JSON.stringify(withoutToken(input))) > 384 * 1024) {
    return failure(
      'Scoped fix submission exceeds the aggregate proposal limit.',
    );
  }
  if (input.patch && input.replacements?.length) {
    return failure('Use either one atomic patch or replacements, not both.');
  }
  await ensureRuntimeHome(paths);
  const reserved = reserveSubmission(input, paths);
  if (!reserved) {
    return failure(
      'The one-time owner fix token is invalid or already consumed.',
      ['one-time-submission'],
    );
  }
  claimAutopilotSubmissionProcessLease(input.attemptId);
  let context;
  try {
    context = await validateSubmissionContext(input, paths, dependencies);
  } catch (error) {
    const message = `Invalid scoped fix proposal: ${error instanceof Error ? error.message : String(error)}`;
    await finalizeSubmission(
      input.attemptId,
      'rejected',
      null,
      {},
      message,
      paths,
    );
    return failure(message);
  }
  if ('failure' in context && typeof context.failure === 'string') {
    await finalizeSubmission(
      input.attemptId,
      'rejected',
      null,
      {},
      context.failure,
      paths,
    );
    return failure(context.failure);
  }
  if (input.disposition === 'no-op') {
    try {
      await assertSubmissionMutationFence(
        input,
        paths,
        dependencies,
        'before-artifact',
      );
    } catch (error) {
      const message = `Invalid scoped no-op: ${error instanceof Error ? error.message : String(error)}`;
      await finalizeSubmission(
        input.attemptId,
        'rejected',
        null,
        {},
        message,
        paths,
      );
      return failure(message);
    }
    await finalizeSubmission(
      input.attemptId,
      'no-op',
      null,
      {
        summary: input.summary,
        remainingBlockers: input.remainingBlockers ?? [],
      },
      null,
      paths,
    );
    return {
      ok: true,
      action: 'autopilot_submit_fix',
      changed: false,
      message: input.summary,
      data: {
        disposition: 'no-op',
        remainingBlockers: input.remainingBlockers ?? [],
      },
    } as const;
  }
  if (!input.fixerKind || (!input.patch && !input.replacements?.length)) {
    const message =
      'A fix submission requires a fixer kind and a scoped patch or replacement.';
    await finalizeSubmission(
      input.attemptId,
      'rejected',
      null,
      {},
      message,
      paths,
    );
    return failure(message);
  }

  let result: FixResult;
  const ownerMutationFence = async (
    phase:
      | 'before-execution'
      | 'before-mutation'
      | 'before-write'
      | 'before-commit'
      | 'before-artifact',
    effect?: { paths: string[]; bytes: number; lines: number },
  ) => {
    await assertSubmissionMutationFence(
      input,
      paths,
      dependencies,
      phase,
      effect,
    );
  };
  const ownerCommitAllowed = async () => {
    const scope = await assertSubmissionMutationFence(
      input,
      paths,
      dependencies,
      'before-commit',
    );
    const evaluated = await evaluateRepoGuardrails(
      {
        repoId: scope.repoId,
        worktreeId: scope.worktreeId,
        diffBaseRef: scope.diffBaseSha,
        pushDestination: 'pull-request-head',
        guardrails: scope.guardrails,
      },
      paths,
    );
    return evaluated.denied.length === 0 && evaluated.expansions.length === 0;
  };
  const ownerDiagnosticCommandAllowed = async (command: string) => {
    const scope = await assertSubmissionMutationFence(
      input,
      paths,
      dependencies,
      'before-execution',
    );
    return scope.diagnosticCommands.includes(command.trim());
  };
  try {
    result =
      input.fixerKind === 'review'
        ? await (dependencies.runReviewFix ?? fixPrReviewFeedback)(
            {
              repoId: context.owner.repoId,
              prNumber: context.owner.prNumber,
              worktreeId: input.worktreeId,
              addressedReviewCommentIds: input.addressedReviewCommentIds,
              addressedReviewThreadIds: input.addressedReviewThreadIds,
              replacements: input.replacements,
              patch: input.patch,
              createWorktree: false,
              sync: false,
              fetch: false,
              lock: true,
              commit: context.policy.localCommit,
              expectedHeadSha: input.expectedPrHeadSha,
              expectedWorktreeHeadSha: input.expectedWorktreeHeadSha,
            },
            paths,
            { ownerMutationFence, ownerCommitAllowed },
          )
        : await (dependencies.runCiFix ?? fixPrCiFailure)(
            {
              worktreeId: input.worktreeId,
              checks: input.checks,
              diagnostics: input.diagnostics,
              patch: input.patch,
              patchReason: input.summary,
              confidence: input.confidence,
              risk: input.risk,
              manualAsks: input.remainingBlockers,
              commit: context.policy.localCommit,
              expectedHeadSha: input.expectedPrHeadSha,
              expectedWorktreeHeadSha: input.expectedWorktreeHeadSha,
            },
            paths,
            {
              ownerMutationFence,
              ownerCommitAllowed,
              ownerDiagnosticCommands: context.policy.diagnosticCommands,
              ownerDiagnosticCommandAllowed,
            },
          );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeSubmission(
      input.attemptId,
      'failed',
      null,
      {},
      message,
      paths,
    );
    return failure(`The deterministic fixer failed: ${message}`);
  }
  const preparedDiffId = findPreparedDiffId(result);
  if (preparedDiffId) {
    await finalizeSubmission(
      input.attemptId,
      'prepared',
      preparedDiffId,
      result,
      null,
      paths,
    );
    return {
      ...result,
      ok: true,
      changed: true,
      action: 'autopilot_submit_fix',
    };
  }
  if (!result.ok) {
    const message = result.message;
    await finalizeSubmission(
      input.attemptId,
      'failed',
      null,
      result,
      message,
      paths,
    );
    return { ...result, action: 'autopilot_submit_fix' };
  }
  const message = 'The deterministic fixer returned without a prepared diff.';
  await finalizeSubmission(
    input.attemptId,
    'failed',
    null,
    result,
    message,
    paths,
  );
  return failure(message);
}

async function assertSubmissionMutationFence(
  input: SubmitInput,
  paths: RuntimePaths,
  dependencies: SubmitDependencies,
  phase:
    | 'before-execution'
    | 'before-mutation'
    | 'before-write'
    | 'before-commit'
    | 'before-artifact',
  plannedEffect?: { paths: string[]; bytes: number; lines: number },
) {
  const database = openDb(paths.neondeckDatabase);
  let scope: v.InferOutput<typeof mutationFenceRowSchema>;
  try {
    scope = withImmediateTransaction(database, () => {
      const rawRow = database
        .prepare(
          `SELECT submissions.status AS submission_status,
                  submissions.mutation_epoch AS submission_epoch,
                  submissions.cancellation_requested_at,
                  admissions.*, attempts.status AS attempt_status,
                  grounding.worktree_id, grounding.pr_head_sha,
                  grounding.worktree_head_sha, grounding.base_sha,
                  grounding.checkout_branch, grounding.checkout_detached,
                  grounding.diff_base_sha, grounding.diff_revision_key,
                  grounding.repo_binding_hash, grounding.workspace_binding_hash,
                  grounding.policy_hash,
                  grounding.config_history_id AS grounding_config_history_id
           FROM autopilot_owner_fix_submissions AS submissions
           INNER JOIN autopilot_admissions AS admissions
             ON admissions.id = submissions.admission_id
           INNER JOIN autopilot_stage_attempts AS attempts
             ON attempts.id = submissions.attempt_id
           INNER JOIN autopilot_owner_grounding_snapshots AS grounding
             ON grounding.attempt_id = attempts.id
           WHERE submissions.attempt_id = ?;`,
        )
        .get(input.attemptId);
      const parsedRow = v.safeParse(mutationFenceRowSchema, rawRow);
      const row = parsedRow.success ? parsedRow.output : undefined;
      if (
        !row ||
        row.submission_status !== 'applying' ||
        row.cancellation_requested_at !== null ||
        row.attempt_status !== 'running' ||
        row.state !== 'owner-turn-running' ||
        row.current_stage_attempt_id !== input.attemptId ||
        Number(row.submission_epoch) !== Number(row.mutation_epoch) ||
        row.stop_requested_at !== null
      ) {
        throw new Error('Owner mutation lease was revoked or superseded.');
      }
      if (phase === 'before-mutation') {
        database
          .prepare(
            `UPDATE autopilot_owner_fix_submissions
             SET mutation_started_at = COALESCE(mutation_started_at, ?)
             WHERE attempt_id = ? AND status = 'applying'
               AND cancellation_requested_at IS NULL;`,
          )
          .run(new Date().toISOString(), input.attemptId);
      }
      return row;
    });
  } finally {
    database.close();
  }

  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === scope.repo_id,
  );
  if (!repo) throw new Error('Owner repository is no longer configured.');
  const worktree = readWorktreeRecord(input.worktreeId, paths);
  const repoBindingHash = stableJsonHash({
    id: repo.id,
    path: repo.path,
    defaultBranch: repo.defaultBranch,
    githubOwner: repo.github.owner,
    githubName: repo.github.name,
  });
  const workspaceBindingHash = stableJsonHash({
    id: worktree.id,
    repoId: worktree.repoId,
    repoFullName: worktree.repoFullName,
    localPath: worktree.localPath,
    prNumber: worktree.prNumber,
    baseRef: worktree.baseRef,
    headOwner: worktree.headOwner,
    headName: worktree.headName,
    headRef: worktree.headRef,
    storageKind: worktree.storageKind,
    adopted: worktree.adopted,
    createdBy: worktree.createdBy,
  });
  if (
    repoBindingHash !== scope.repo_binding_hash ||
    workspaceBindingHash !== scope.workspace_binding_hash
  ) {
    throw new Error(
      'Repository or managed-worktree identity changed after dispatch.',
    );
  }
  const postMutationArtifact =
    phase === 'before-artifact' && input.disposition === 'fix';
  const actualSha = await (dependencies.currentSha ?? gitCurrentSha)(
    worktree.localPath,
  );
  if (!postMutationArtifact && actualSha !== scope.worktree_head_sha) {
    throw new Error('Worktree HEAD changed after dispatch.');
  }
  if (!dependencies.currentSha) {
    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const git =
      status && typeof status === 'object'
        ? (status as Record<string, unknown>).git
        : null;
    if (!git || typeof git !== 'object')
      throw new Error('Worktree Git state is unavailable.');
    const gitState = git as Record<string, unknown>;
    if (
      (!postMutationArtifact && gitState.headSha !== scope.worktree_head_sha) ||
      gitState.baseSha !== scope.base_sha ||
      gitState.branch !== scope.checkout_branch ||
      (gitState.branch === 'HEAD') !== Boolean(scope.checkout_detached)
    ) {
      throw new Error(
        'Worktree HEAD, base, or branch attachment changed after dispatch.',
      );
    }
  }
  if (
    phase === 'before-mutation' ||
    (phase === 'before-artifact' && input.disposition === 'no-op')
  ) {
    const diff = await (dependencies.readDiff ?? readRepoDiff)(
      {
        repoId: repo.id,
        worktreeId: worktree.id,
        base: scope.diff_base_sha,
        includePatch: false,
      },
      paths,
    );
    const revisionKey =
      diff.ok && diff.action === 'repo_diff' && diff.revision
        ? reviewRevisionKey(diff.revision)
        : null;
    if (revisionKey !== scope.diff_revision_key) {
      throw new Error(
        'Worktree content changed after the grounded revision was accepted.',
      );
    }
  }
  const liveHead = await (dependencies.readLiveHead ?? defaultLiveHead)({
    owner: repo.github.owner,
    repo: repo.github.name,
    prNumber: Number(worktree.prNumber),
  });
  if (liveHead !== scope.pr_head_sha)
    throw new Error('Pull request HEAD changed after dispatch.');

  const admission = readAutopilotAdmission(scope);
  if (!admission) throw new Error('Persisted admission is invalid.');
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: String(scope.watch_id),
    prNumber: Number(worktree.prNumber),
  });
  const currentGuardrails = repoGuardrails(repo, appConfig);
  const authorityDatabase = openDb(paths.neondeckDatabase);
  let authority;
  try {
    authority = withImmediateTransaction(authorityDatabase, () =>
      constrainAutopilotAdmissionAuthority(authorityDatabase, {
        admission,
        repoId: repo.id,
        watchId: String(scope.watch_id),
        prNumber: Number(worktree.prNumber),
        appConfig,
        currentConfiguredMode: policy.mode,
        currentGuardrails,
      }),
    );
  } finally {
    authorityDatabase.close();
  }
  const effective = autopilotOwnerPolicySnapshot({
    admissionMode: admission.mode,
    authorityMode: authority.authorityMode,
    configuredMode: policy.mode,
    guardrails: authority.guardrails,
    executionPolicy: appConfig.execution ?? null,
    worktreePolicy: appConfig.worktrees ?? null,
    learningPolicy: appConfig.learning ?? null,
    diagnosticCommands: authority.diagnosticCommands,
    authorityTransitionHash: authority.transitionHash,
  });
  if (input.disposition === 'fix' && !effective.fixAllowed) {
    throw new Error(
      'Current monotonic policy authority no longer permits a fix.',
    );
  }
  if (stableJsonHash(effective) !== scope.policy_hash) {
    throw new Error('Effective owner policy changed after dispatch.');
  }
  if (
    input.disposition === 'fix' &&
    (phase === 'before-mutation' || phase === 'before-write')
  ) {
    const guardrails = authority.guardrails;
    const effect =
      plannedEffect ??
      (dependencies.runReviewFix || dependencies.runCiFix
        ? {
            paths: submissionPaths(input),
            bytes: Buffer.byteLength(
              JSON.stringify(input.replacements ?? input.patch ?? ''),
            ),
            lines: input.patch
              ? input.patch
                  .split('\n')
                  .filter((line) => /^[+-](?!\+\+|--)/.test(line)).length
              : (input.replacements ?? []).reduce(
                  (total, item) =>
                    total +
                    item.oldString.split('\n').length +
                    item.newString.split('\n').length,
                  0,
                ),
          }
        : await measureSubmissionEffect(
            input,
            { worktreeId: worktree.id },
            paths,
          ));
    if (
      effect.paths.length > guardrails.maxFilesChanged ||
      effect.lines > guardrails.maxLinesChanged ||
      effect.bytes > 256 * 1024 ||
      effect.paths.some((path) => pathDeniedByAutopilotPolicy(path, guardrails))
    ) {
      throw new Error(
        'Current path, byte, or line authority rejects the planned effect.',
      );
    }
  }

  if (phase === 'before-commit' || postMutationArtifact) {
    const diff = await (dependencies.readDiff ?? readRepoDiff)(
      {
        repoId: repo.id,
        worktreeId: worktree.id,
        base: scope.diff_base_sha,
        includePatch: false,
      },
      paths,
    );
    const revisionKey =
      diff.ok && diff.action === 'repo_diff' && diff.revision
        ? reviewRevisionKey(diff.revision)
        : null;
    if (!revisionKey)
      throw new Error('Owner mutation revision is unavailable.');
    bindSubmissionRevision(input.attemptId, phase, revisionKey, paths);
  }

  const confirm = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = confirm
      .prepare(
        `SELECT submissions.status, submissions.cancellation_requested_at,
                submissions.mutation_epoch AS submission_epoch,
                admissions.mutation_epoch, admissions.stop_requested_at
         FROM autopilot_owner_fix_submissions AS submissions
         INNER JOIN autopilot_admissions AS admissions
           ON admissions.id = submissions.admission_id
         WHERE submissions.attempt_id = ?;`,
      )
      .get(input.attemptId) as Record<string, unknown> | undefined;
    if (
      !row ||
      row.status !== 'applying' ||
      row.cancellation_requested_at !== null ||
      row.stop_requested_at !== null ||
      Number(row.submission_epoch) !== Number(row.mutation_epoch)
    )
      throw new Error('Owner mutation lease was revoked during validation.');
    assertNoBlockingConfigDrift(
      confirm,
      Number(scope.grounding_config_history_id),
      repo.id,
    );
    assertNoUnfoldedAuthorityDrift(
      confirm,
      authority.authorityScanConfigHistoryId,
      repo.id,
    );
  } finally {
    confirm.close();
  }
  return {
    repoId: repo.id,
    worktreeId: worktree.id,
    diffBaseSha: scope.diff_base_sha,
    guardrails: authority.guardrails,
    diagnosticCommands: authority.diagnosticCommands,
  };
}

async function validateSubmissionContext(
  input: SubmitInput,
  paths: RuntimePaths,
  dependencies: SubmitDependencies,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let owner;
  let admission;
  let attempt;
  let grounding: Record<string, unknown> | undefined;
  try {
    admission = readAutopilotAdmission(
      database
        .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
        .get(input.admissionId),
    );
    attempt = readAutopilotStageAttempt(
      database
        .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
        .get(input.attemptId),
    );
    owner = admission
      ? readAutopilotPrOwner(
          database
            .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
            .get(admission.ownerId),
        )
      : undefined;
    const groundingRow = database
      .prepare(
        'SELECT * FROM autopilot_owner_grounding_snapshots WHERE attempt_id = ?;',
      )
      .get(input.attemptId);
    const parsedGrounding = v.safeParse(groundingScopeRowSchema, groundingRow);
    grounding = parsedGrounding.success ? parsedGrounding.output : undefined;
  } finally {
    database.close();
  }
  if (!owner || !admission || !attempt || !grounding)
    return { failure: 'Owner turn scope was not found.' };
  if (
    attempt.admissionId !== admission.id ||
    attempt.ownerId !== owner.id ||
    attempt.stage !== 'owner-turn' ||
    attempt.status !== 'running' ||
    admission.state !== 'owner-turn-running' ||
    admission.currentStageAttemptId !== attempt.id ||
    admission.eventFingerprint !== input.sourceEventFingerprint
  )
    return { failure: 'Owner turn scope is stale or no longer active.' };
  if (
    stableJsonHash(input.token) !== grounding.submit_token_hash ||
    grounding.status !== 'accepted'
  )
    return {
      failure: 'Owner fix token is invalid or its dispatch was not accepted.',
    };
  if (
    owner.worktreeId !== input.worktreeId ||
    owner.currentHeadSha !== input.expectedPrHeadSha ||
    grounding.worktree_id !== input.worktreeId ||
    grounding.pr_head_sha !== input.expectedPrHeadSha ||
    grounding.worktree_head_sha !== input.expectedWorktreeHeadSha
  ) {
    return { failure: 'Owner worktree or expected head SHA is stale.' };
  }
  const worktree = readWorktreeRecord(input.worktreeId, paths);
  if (
    !['ready', 'prepared-diff', 'succeeded'].includes(worktree.lifecycleStatus)
  ) {
    return {
      failure: `Worktree is ${worktree.lifecycleStatus} and cannot accept an owner fix.`,
    };
  }
  const actualSha = await (dependencies.currentSha ?? gitCurrentSha)(
    worktree.localPath,
  );
  if (actualSha !== input.expectedWorktreeHeadSha)
    return {
      failure: 'Worktree HEAD changed after the owner envelope was accepted.',
    };

  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === owner.repoId,
  );
  if (!repo) return { failure: 'Owner repository is no longer configured.' };
  const liveHead = await (dependencies.readLiveHead ?? defaultLiveHead)({
    owner: repo.github.owner,
    repo: repo.github.name,
    prNumber: owner.prNumber,
  });
  if (liveHead !== input.expectedPrHeadSha) {
    return { failure: 'Pull request HEAD changed after owner dispatch.' };
  }
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: owner.watchId,
    prNumber: owner.prNumber,
  });
  const guardrails = repoGuardrails(repo, appConfig);
  const authorityDatabase = openDb(paths.neondeckDatabase);
  let authority;
  try {
    authority = withImmediateTransaction(authorityDatabase, () =>
      constrainAutopilotAdmissionAuthority(authorityDatabase, {
        admission,
        repoId: repo.id,
        watchId: owner.watchId,
        prNumber: owner.prNumber,
        appConfig,
        currentConfiguredMode: policy.mode,
        currentGuardrails: guardrails,
      }),
    );
  } finally {
    authorityDatabase.close();
  }
  const currentPolicy = autopilotOwnerPolicySnapshot({
    admissionMode: admission.mode,
    authorityMode: authority.authorityMode,
    configuredMode: policy.mode,
    guardrails: authority.guardrails,
    executionPolicy: appConfig.execution ?? null,
    worktreePolicy: appConfig.worktrees ?? null,
    learningPolicy: appConfig.learning ?? null,
    diagnosticCommands: authority.diagnosticCommands,
    authorityTransitionHash: authority.transitionHash,
  });
  const currentPolicyHash = stableJsonHash(currentPolicy);
  if (
    input.policyHash !== grounding.policy_hash ||
    input.policyHash !== currentPolicyHash
  ) {
    return {
      failure:
        'Autopilot policy changed after the owner envelope was accepted.',
    };
  }
  if (!currentPolicy.fixAllowed && input.disposition === 'fix') {
    return { failure: 'Current policy no longer permits an owner fix.' };
  }
  if (input.fixerKind === 'ci') {
    const allowedCommands = new Set(currentPolicy.diagnosticCommands);
    const rejectedCommand = [
      ...(input.diagnostics ?? []),
      ...(input.checks ?? []),
    ]
      .map((command) => command.trim())
      .find((command) => !allowedCommands.has(command));
    if (rejectedCommand) {
      return {
        failure:
          'CI diagnostic command is outside the grounded repository authority.',
      };
    }
  }
  const plannedPaths = submissionPaths(input);
  const denied = plannedPaths.find((path) =>
    pathDeniedByAutopilotPolicy(path, authority.guardrails),
  );
  if (denied)
    return { failure: `Fix path ${denied} is denied by repository policy.` };
  const effect =
    dependencies.runReviewFix || dependencies.runCiFix
      ? {
          paths: plannedPaths,
          bytes: Buffer.byteLength(
            JSON.stringify(input.replacements ?? input.patch ?? ''),
          ),
          lines: input.patch
            ? input.patch
                .split('\n')
                .filter((line) => /^[+-](?!\+\+|--)/.test(line)).length
            : (input.replacements ?? []).reduce(
                (total, item) =>
                  total +
                  item.oldString.split('\n').length +
                  item.newString.split('\n').length,
                0,
              ),
        }
      : await measureSubmissionEffect(
          input,
          { worktreeId: input.worktreeId },
          paths,
        );
  if (plannedPaths.length > authority.guardrails.maxFilesChanged)
    return { failure: 'Fix exceeds the configured maximum file count.' };
  if (effect.bytes > 256 * 1024)
    return { failure: 'Fix actual affected content exceeds the byte limit.' };
  if (effect.lines > authority.guardrails.maxLinesChanged)
    return { failure: 'Fix exceeds the configured maximum line count.' };
  return { owner, admission, attempt, policy: currentPolicy };
}

function assertNoBlockingConfigDrift(
  database: ReturnType<typeof openDb>,
  configHistoryId: number,
  repoId: string,
) {
  const rows = database
    .prepare(
      `SELECT action, target FROM config_history
       WHERE id > ? ORDER BY id ASC;`,
    )
    .all(configHistoryId)
    .map((row) => v.parse(mutationFenceConfigRowSchema, row));
  const blocking = rows.find((row) => {
    const drift = classifyAutopilotOwnerConfigChange(row, repoId);
    return drift === 'block' || drift === 'rotate';
  });
  if (blocking) {
    throw new Error(
      `Owner grounding changed after dispatch: ${blocking.action}:${blocking.target ?? 'general'}.`,
    );
  }
}

function assertNoUnfoldedAuthorityDrift(
  database: ReturnType<typeof openDb>,
  configHistoryId: number,
  repoId: string,
) {
  const rows = database
    .prepare(
      `SELECT action, target FROM config_history
       WHERE id > ? ORDER BY id ASC;`,
    )
    .all(configHistoryId)
    .map((row) => v.parse(mutationFenceConfigRowSchema, row));
  const transition = rows.find(
    (row) => classifyAutopilotOwnerConfigChange(row, repoId) !== 'none',
  );
  if (transition) {
    throw new Error(
      `Owner policy changed during validation: ${transition.action}:${transition.target ?? 'general'}.`,
    );
  }
}

function bindSubmissionRevision(
  attemptId: string,
  phase: 'before-commit' | 'before-artifact',
  revisionKey: string,
  paths: RuntimePaths,
) {
  const column =
    phase === 'before-commit'
      ? 'mutation_revision_key'
      : 'artifact_revision_key';
  const database = openDb(paths.neondeckDatabase);
  try {
    withImmediateTransaction(database, () => {
      const update = database
        .prepare(
          `UPDATE autopilot_owner_fix_submissions
           SET ${column} = COALESCE(${column}, ?)
           WHERE attempt_id = ? AND status = 'applying'
             AND cancellation_requested_at IS NULL
             AND (${column} IS NULL OR ${column} = ?);`,
        )
        .run(revisionKey, attemptId, revisionKey);
      if (update.changes !== 1) {
        throw new Error(
          'Owner mutation revision changed after it was lease-bound.',
        );
      }
    });
  } finally {
    database.close();
  }
}

async function measureSubmissionEffect(
  input: SubmitInput,
  scope: { worktreeId: string },
  paths: RuntimePaths,
) {
  const changed = new Map<string, { before: string; after: string }>();
  const repoId = readWorktreeRecord(scope.worktreeId, paths).repoId;
  const load = async (path: string) => {
    const existing = changed.get(path);
    if (existing) return existing;
    const target = await resolveRepoPath(
      { repoId, worktreeId: scope.worktreeId, path, intent: 'read' },
      paths,
    );
    const before = target.exists ? await readFile(target.fullPath, 'utf8') : '';
    const state = { before, after: before };
    changed.set(path, state);
    return state;
  };
  for (const replacement of input.replacements ?? []) {
    const state = await load(replacement.path);
    const result = replaceContent(state.after, replacement);
    if (!result.ok) throw new Error(result.message);
    state.after = result.content;
  }
  if (input.patch) {
    for (const operation of parseV4APatch(input.patch).operations) {
      if (operation.type === 'add') {
        const state = await load(operation.path);
        state.after = operation.lines.join('\n');
      } else if (operation.type === 'delete') {
        const state = await load(operation.path);
        state.after = '';
      } else if (operation.type === 'move') {
        const source = await load(operation.from);
        const destination = await load(operation.to);
        const movedContent = source.after;
        source.after = '';
        destination.after = movedContent;
        for (const hunk of operation.hunks) {
          destination.after = applyMeasuredHunk(destination.after, hunk.lines);
        }
      } else {
        const state = await load(operation.path);
        for (const hunk of operation.hunks) {
          state.after = applyMeasuredHunk(state.after, hunk.lines);
        }
      }
    }
  }
  let lines = 0;
  let bytes = 0;
  for (const state of changed.values()) {
    bytes += Buffer.byteLength(state.before) + Buffer.byteLength(state.after);
    lines += changedLineEstimate(state.before, state.after);
  }
  return { paths: [...changed.keys()], bytes, lines };
}

function applyMeasuredHunk(
  content: string,
  lines: Array<{ kind: 'context' | 'remove' | 'add'; text: string }>,
) {
  const oldText = lines
    .filter((line) => line.kind !== 'add')
    .map((line) => line.text)
    .join('\n');
  const newText = lines
    .filter((line) => line.kind !== 'remove')
    .map((line) => line.text)
    .join('\n');
  const index = content.indexOf(oldText);
  if (index < 0 || content.indexOf(oldText, index + 1) >= 0) {
    throw new Error(
      'Patch hunk does not resolve uniquely in the current file.',
    );
  }
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function changedLineEstimate(before: string, after: string) {
  if (before === after) return 0;
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  )
    suffix += 1;
  return (
    beforeLines.length - prefix - suffix + afterLines.length - prefix - suffix
  );
}

function submissionPaths(input: SubmitInput) {
  const paths = new Set(input.replacements?.map((item) => item.path) ?? []);
  if (input.patch) {
    for (const operation of parseV4APatch(input.patch).operations) {
      if ('path' in operation) paths.add(operation.path);
      if ('from' in operation) paths.add(operation.from);
      if ('to' in operation) paths.add(operation.to);
    }
  }
  return [...paths];
}

function reserveSubmission(input: SubmitInput, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const result = database
        .prepare(
          `INSERT INTO autopilot_owner_fix_submissions (
             id, owner_id, admission_id, attempt_id, dispatch_id, token_hash,
             disposition, status, request_hash, mutation_epoch, result_json, created_at
           ) SELECT ?, owners.id, admissions.id, attempts.id,
                    grounding.dispatch_id, ?, ?, 'applying', ?, admissions.mutation_epoch, ?, ?
           FROM autopilot_owner_grounding_snapshots AS grounding
           INNER JOIN autopilot_stage_attempts AS attempts
             ON attempts.id = grounding.attempt_id
           INNER JOIN autopilot_admissions AS admissions
             ON admissions.id = attempts.admission_id
           INNER JOIN autopilot_pr_owners AS owners
             ON owners.id = attempts.owner_id
           WHERE grounding.attempt_id = ? AND grounding.admission_id = ?
             AND grounding.status = 'accepted'
             AND grounding.submit_token_hash = ?
             AND grounding.worktree_id = ?
             AND grounding.pr_head_sha = ?
             AND grounding.worktree_head_sha = ?
             AND attempts.stage = 'owner-turn' AND attempts.status = 'running'
             AND attempts.dispatch_id = grounding.dispatch_id
             AND admissions.state = 'owner-turn-running'
             AND admissions.current_stage_attempt_id = attempts.id
             AND admissions.event_fingerprint = ?
             AND owners.generation = attempts.owner_generation
             AND owners.flue_instance_id = attempts.flue_instance_id
             AND owners.worktree_id = ?
             AND owners.current_head_sha = ?
           ON CONFLICT DO NOTHING;`,
        )
        .run(
          `autopilot-owner-submission:${randomUUID()}`,
          stableJsonHash(input.token),
          input.disposition,
          stableJsonHash(withoutToken(input)),
          JSON.stringify(boundedRequestRecord(input)),
          new Date().toISOString(),
          input.attemptId,
          input.admissionId,
          stableJsonHash(input.token),
          input.worktreeId,
          input.expectedPrHeadSha,
          input.expectedWorktreeHeadSha,
          input.sourceEventFingerprint,
          input.worktreeId,
          input.expectedPrHeadSha,
        );
      return result.changes === 1;
    });
  } finally {
    database.close();
  }
}

function finishSubmission(
  attemptId: string,
  status: 'prepared' | 'no-op' | 'rejected' | 'failed',
  preparedDiffId: string | null,
  result: unknown,
  error: string | null,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const current = database
      .prepare(
        `SELECT submissions.result_json, submissions.cancellation_requested_at,
                submissions.mutation_epoch AS submission_epoch,
                admissions.mutation_epoch
         FROM autopilot_owner_fix_submissions AS submissions
         INNER JOIN autopilot_admissions AS admissions
           ON admissions.id = submissions.admission_id
         WHERE submissions.attempt_id = ? AND submissions.status = 'applying';`,
      )
      .get(attemptId) as
      | {
          result_json?: unknown;
          cancellation_requested_at?: unknown;
          submission_epoch?: unknown;
          mutation_epoch?: unknown;
        }
      | undefined;
    const request = parseStoredJson(current?.result_json);
    const cancelled =
      current?.cancellation_requested_at !== null ||
      Number(current?.submission_epoch) !== Number(current?.mutation_epoch);
    database
      .prepare(
        `UPDATE autopilot_owner_fix_submissions
         SET status = ?, prepared_diff_id = ?, result_hash = ?, result_json = ?,
             error = ?, finished_at = ?
         WHERE attempt_id = ? AND status = 'applying';`,
      )
      .run(
        cancelled ? 'cancelled' : status,
        cancelled ? null : preparedDiffId,
        stableJsonHash(result),
        JSON.stringify({ request, result: boundedResultRecord(result) }),
        cancelled
          ? 'Owner mutation lease was cancelled.'
          : error
            ? truncate(error, 2_048)
            : null,
        new Date().toISOString(),
        attemptId,
      );
  } finally {
    database.close();
    releaseAutopilotSubmissionProcessLease(attemptId);
  }
}

async function finalizeSubmission(
  attemptId: string,
  status: 'prepared' | 'no-op' | 'rejected' | 'failed',
  preparedDiffId: string | null,
  result: unknown,
  error: string | null,
  paths: RuntimePaths,
) {
  finishSubmission(attemptId, status, preparedDiffId, result, error, paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let dispatchId: string | null = null;
  try {
    const row = database
      .prepare(
        'SELECT dispatch_id FROM autopilot_owner_fix_submissions WHERE attempt_id = ?;',
      )
      .get(attemptId) as { dispatch_id?: unknown } | undefined;
    dispatchId = typeof row?.dispatch_id === 'string' ? row.dispatch_id : null;
  } finally {
    database.close();
  }
  if (dispatchId) {
    await settlePendingAutopilotOwnerObservation(dispatchId, paths);
  }
}

async function defaultLiveHead(input: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to verify PR HEAD.');
  const pullRequest = await fetchPullRequestDetail({
    token,
    owner: input.owner,
    repo: input.repo,
    number: input.prNumber,
  });
  return pullRequest.headSha;
}

function parseStoredJson(value: unknown) {
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function findPreparedDiffId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const direct = record.preparedDiff;
  if (
    direct &&
    typeof direct === 'object' &&
    typeof (direct as Record<string, unknown>).id === 'string'
  ) {
    return (direct as Record<string, unknown>).id as string;
  }
  return findPreparedDiffId(record.data);
}

function withoutToken(input: SubmitInput) {
  const { token: _token, ...rest } = input;
  return rest;
}

function boundedRequestRecord(input: SubmitInput) {
  return {
    disposition: input.disposition,
    fixerKind: input.fixerKind ?? null,
    summary: truncate(input.summary, 2_048),
    addressedReviewCommentIds: (input.addressedReviewCommentIds ?? []).slice(
      0,
      64,
    ),
    addressedReviewThreadIds: (input.addressedReviewThreadIds ?? []).slice(
      0,
      64,
    ),
    plannedPaths: submissionPaths(input).slice(0, 100),
    patchHash: input.patch ? stableJsonHash(input.patch) : null,
    replacementsHash: input.replacements
      ? stableJsonHash(input.replacements)
      : null,
    proposalBytes: Buffer.byteLength(JSON.stringify(withoutToken(input))),
  };
}

function boundedResultRecord(result: unknown) {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  return {
    ok: record.ok === true,
    changed: record.changed === true,
    action:
      typeof record.action === 'string' ? truncate(record.action, 128) : null,
    message:
      typeof record.message === 'string'
        ? truncate(record.message, 2_048)
        : null,
    preparedDiffId: findPreparedDiffId(result),
    requires: boundedStrings(record.requires),
    errors: boundedStrings(record.errors),
  };
}

function boundedStrings(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 32)
        .map((item) => truncate(item, 512))
    : [];
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function failure(message: string, errors: string[] = []) {
  return {
    ok: false,
    action: 'autopilot_submit_fix',
    changed: false,
    message,
    errors,
  } as const;
}
