import { randomUUID } from 'node:crypto';
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { gitCurrentSha } from '../../../repo-edit/git';
import { parseV4APatch } from '../../../repo-edit/patch-parser';
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
import { fixPrCiFailure } from '../ci-fix';
import {
  readAutopilotAdmission,
  readAutopilotPrOwner,
  readAutopilotStageAttempt,
} from '../coordination/schemas';
import { fixPrReviewFeedback } from '../review-feedback';
import { autopilotOutputSchema, reviewFixReplacementSchema } from '../schemas';
import { stableJsonHash } from '../owner/grounding';
import { autopilotOwnerPolicySnapshot } from '../owner/policy';
import { settlePendingAutopilotOwnerObservation } from '../owner/settle';
import { fetchPullRequestDetail } from '../../github';
import {
  claimAutopilotSubmissionProcessLease,
  releaseAutopilotSubmissionProcessLease,
} from '../owner/submission-lease';

const nonEmpty = v.pipe(v.string(), v.minLength(1));
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
  addressedReviewCommentIds: v.optional(v.array(nonEmpty)),
  addressedReviewThreadIds: v.optional(v.array(nonEmpty)),
  replacements: v.optional(
    v.pipe(v.array(reviewFixReplacementSchema), v.maxLength(100)),
  ),
  patch: v.optional(v.pipe(v.string(), v.maxLength(256 * 1024))),
  diagnostics: v.optional(v.array(nonEmpty)),
  checks: v.optional(v.array(nonEmpty)),
  testsAttempted: v.optional(v.array(nonEmpty)),
  summary: nonEmpty,
  confidence: v.optional(v.picklist(['low', 'medium', 'high'])),
  risk: v.optional(v.picklist(['low', 'medium', 'high'])),
  remainingBlockers: v.optional(v.array(nonEmpty)),
});

type SubmitInput = v.InferOutput<typeof submitAutopilotFixInputSchema>;
type FixResult = Awaited<ReturnType<typeof fixPrReviewFeedback>>;
type SubmitDependencies = {
  currentSha?: typeof gitCurrentSha;
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
  if (!result.ok || !preparedDiffId) {
    const message = result.ok
      ? 'The deterministic fixer returned without a prepared diff.'
      : result.message;
    await finalizeSubmission(
      input.attemptId,
      'failed',
      preparedDiffId,
      result,
      message,
      paths,
    );
    return { ...result, action: 'autopilot_submit_fix' };
  }
  await finalizeSubmission(
    input.attemptId,
    'prepared',
    preparedDiffId,
    result,
    null,
    paths,
  );
  return { ...result, action: 'autopilot_submit_fix' };
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
    grounding = database
      .prepare(
        'SELECT * FROM autopilot_owner_grounding_snapshots WHERE attempt_id = ?;',
      )
      .get(input.attemptId) as Record<string, unknown> | undefined;
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
  const currentPolicy = autopilotOwnerPolicySnapshot({
    admissionMode: admission.mode,
    configuredMode: policy.mode,
    guardrails,
    executionPolicy: appConfig.execution ?? null,
    worktreePolicy: appConfig.worktrees ?? null,
    learningPolicy: appConfig.learning ?? null,
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
  const plannedPaths = submissionPaths(input);
  if (plannedPaths.length > guardrails.maxFilesChanged)
    return { failure: 'Fix exceeds the configured maximum file count.' };
  const replacementBytes = Buffer.byteLength(
    JSON.stringify(input.replacements ?? []),
  );
  if (replacementBytes > 256 * 1024) {
    return { failure: 'Fix replacements exceed the proposal byte limit.' };
  }
  const lineChanges = input.patch
    ? input.patch.split('\n').filter((line) => /^[+-](?!\+\+|--)/.test(line))
        .length
    : (input.replacements ?? []).reduce(
        (total, replacement) =>
          total +
          replacement.oldString.split('\n').length +
          replacement.newString.split('\n').length,
        0,
      );
  if (lineChanges > guardrails.maxLinesChanged)
    return { failure: 'Fix exceeds the configured maximum line count.' };
  const denied = plannedPaths.find((path) =>
    pathDeniedByAutopilotPolicy(path, guardrails),
  );
  if (denied)
    return { failure: `Fix path ${denied} is denied by repository policy.` };
  return { owner, admission, attempt, policy: currentPolicy };
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
             disposition, status, request_hash, result_json, created_at
           ) SELECT ?, owners.id, admissions.id, attempts.id,
                    grounding.dispatch_id, ?, ?, 'applying', ?, ?, ?
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
          JSON.stringify(withoutToken(input)),
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
        `SELECT result_json FROM autopilot_owner_fix_submissions
         WHERE attempt_id = ? AND status = 'applying';`,
      )
      .get(attemptId) as { result_json?: unknown } | undefined;
    const request = parseStoredJson(current?.result_json);
    database
      .prepare(
        `UPDATE autopilot_owner_fix_submissions
         SET status = ?, prepared_diff_id = ?, result_json = ?, error = ?, finished_at = ?
         WHERE attempt_id = ? AND status = 'applying';`,
      )
      .run(
        status,
        preparedDiffId,
        JSON.stringify({ request, result }),
        error,
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

function failure(message: string, errors: string[] = []) {
  return {
    ok: false,
    action: 'autopilot_submit_fix',
    changed: false,
    message,
    errors,
  } as const;
}
