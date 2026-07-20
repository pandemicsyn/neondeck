/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type GitHubCheckSummary,
  type GitHubFailingCheckFact,
  type GitHubPullRequestDetail,
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
  fetchCheckSummary,
  fetchFailingCheckFacts,
  fetchPullRequestDetail,
} from '../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from './notifications';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { runApprovedExecution } from '../execution';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
  postGitHubPrThreadReply,
} from '../pr-events';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  gitCurrentSha,
  gitCommitAll,
  gitCommitPaths,
  gitPushHead,
  gitStatus,
  type GitCommitResult,
} from '../../repo-edit/git';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
} from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import {
  createWorktree,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
  type WorktreeRecord,
} from '../worktrees';
import {
  AutopilotActionResult,
  AutopilotDependencies,
  AutopilotTriageClass,
  autopilotFixtureSchema,
  autopilotModeSchema,
  autopilotOutputSchema,
  checkSummarySchema,
  commentPrAutofixResultInputSchema,
  fixPrCiFailureInputSchema,
  fixPrReviewFeedbackInputSchema,
  prEventDeltaSchema,
  prEventSnapshotSchema,
  prFactsSchema,
  prReviewEventStateSchema,
  preparePrWorktreeInputSchema,
  pushPrAutofixInputSchema,
  reviewFixReplacementSchema,
  triagePrEventInputSchema,
  verifyPrWorktreeInputSchema,
} from './schemas';
import {
  asJsonValue,
  failResult,
  lowerLevelFailure,
  parseInput,
  resolveVerificationChecks,
  objectField,
  stringField,
  booleanField,
  numberField,
  arrayField,
  numberArrayField,
  unique,
  errorMessage,
  isAutopilotActionResult,
} from './utils';
import { dependenciesWithAutopilotFixture } from './fixtures';
import {
  fetchPreparedPrFacts,
  fetchPreparedCheckFacts,
  fetchCiFailureFacts,
  generatedCiFixCommitMessage,
  identifyLikelyCommands,
  runAutopilotDiagnostics,
} from './github-facts';
import {
  prFactsFromDetail,
  repoSummary,
  classifySignals,
  classificationFor,
  reasonsFor,
} from './triage-support';
import {
  blockPushAttempt,
  preparedDiffCommitSha,
  pushNotReadyResult,
  pushReadinessGates,
  recoveryOptionsForPushBlock,
  remoteForPush,
} from './push-support';
import {
  addressedFeedback,
  applyReviewEdits,
  buildReviewFixPlan,
  fetchReviewEventState,
  groupReviewFeedback,
  plannedEditPaths,
  readReviewTargetFiles,
  reviewFactsFromEventState,
  reviewFixCommitMessage,
  reviewTargetPathSet,
  worktreeStatusDirty,
} from './review-support';

export async function commentPrAutofixResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    commentPrAutofixResultInputSchema,
    rawInput,
    'autopilot_comment_pr_autofix_result',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  let notificationPreparedDiff: PreparedDiffRecord | undefined;

  try {
    await ensureRuntimeHome(paths);
    const preparedDiff = readPreparedDiffRecord(input.preparedDiffId, paths);
    if (!preparedDiff) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${input.preparedDiffId} was not found.`,
        { requires: ['preparedDiffId'] },
      );
    }
    notificationPreparedDiff = preparedDiff;
    if (preparedDiff.prNumber === null) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'Prepared diff is not attached to a pull request.',
        { requires: ['prNumber'] },
      );
    }
    const prNumber = preparedDiff.prNumber;
    const [owner, repoName] = preparedDiff.repoFullName.split('/');
    if (!owner || !repoName) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${preparedDiff.id} has an invalid repo name.`,
        { requires: ['repoFullName'] },
      );
    }
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      await notifyAutopilotState(
        {
          state: 'comment-result',
          outcome: 'blocked',
          preparedDiffId: preparedDiff.id,
          worktreeId: preparedDiff.worktreeId,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          workflow: 'comment_pr_autofix_result',
          message:
            'Autofix result comment is blocked because GITHUB_TOKEN is not configured.',
          recoveryOptions: [
            'Configure GITHUB_TOKEN, then retry the result comment.',
          ],
          recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
        },
        paths,
      );
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'GITHUB_TOKEN is not configured.',
        { requires: ['GITHUB_TOKEN'] },
      );
    }
    const fetchEventState =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    const currentState = await fetchEventState({
      token,
      owner,
      repo: repoName,
      number: preparedDiff.prNumber,
    });
    const deliveredSha =
      preparedDiff.pushedCommitSha ??
      stringField(
        (preparedDiff.summary ?? {}) as Record<string, unknown>,
        'pushedCommitSha',
      ) ??
      preparedDiff.headSha;
    if (
      deliveredSha &&
      currentState.headSha &&
      deliveredSha !== currentState.headSha
    ) {
      await notifyAutopilotState(
        {
          state: 'comment-result',
          outcome: 'blocked',
          preparedDiffId: preparedDiff.id,
          worktreeId: preparedDiff.worktreeId,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          workflow: 'comment_pr_autofix_result',
          message:
            'Autofix result comment is blocked because the pull request head changed.',
          recoveryOptions: [
            'Inspect the retained worktree and current PR head before retrying.',
            'Prepare a fresh diff against the new PR head if the old result is stale.',
          ],
          recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
          data: {
            preparedHeadSha: deliveredSha,
            currentHeadSha: currentState.headSha,
          },
        },
        paths,
      );
      return {
        ok: false,
        action: 'autopilot_comment_pr_autofix_result',
        changed: false,
        message:
          'Prepared diff is stale because the pull request head has changed.',
        data: asJsonValue({
          preparedDiffId: preparedDiff.id,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          preparedHeadSha: deliveredSha,
          currentHeadSha: currentState.headSha,
        }),
        requires: ['currentPrHead'],
        errors: [
          `Pushed commit ${deliveredSha} does not match current PR head ${currentState.headSha}.`,
        ],
      };
    }
    if (!isOpenPullRequest(currentState)) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'Autofix result delivery is blocked because the pull request is closed or merged.',
        { requires: ['openPullRequest'] },
      );
    }

    const auditSummary = buildPreparedDiffAuditSummary({
      preparedDiff,
      resultUrl: `/api/prepared-diffs/${encodeURIComponent(preparedDiff.id)}/summary`,
    });
    const facts = auditSummary.facts as Record<string, unknown>;
    const resultStatus = stringField(facts, 'status');
    if (
      resultStatus !== 'prepared' &&
      resultStatus !== 'pushed' &&
      resultStatus !== 'blocked' &&
      resultStatus !== 'verification-requested'
    ) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${preparedDiff.id} is ${preparedDiff.status}, not a prepared, verified, pushed, or blocked autofix result.`,
        { requires: ['preparedResult'] },
      );
    }
    const checkRunIds = numberArrayField(facts, 'checkRunIds');
    const addressedReviewThreadIds = arrayField(
      facts,
      'addressedReviewThreadIds',
    );
    const addressedReviewCommentIds = arrayField(
      facts,
      'addressedReviewCommentIds',
    );
    const commitSha =
      preparedDiff.pushedCommitSha ??
      stringField(facts, 'commitSha') ??
      undefined;
    let workflowSummary = await addWorkflowSummary(
      {
        workflow: 'comment_pr_autofix_result',
        status: 'pending',
        summary: {
          humanSummary: auditSummary.markdown,
          audit: auditSummary.facts,
          comment: null,
        },
      },
      paths,
    );

    const admissionId = input.admissionId;
    const attemptId = input.attemptId;
    if (!isCoordinatorCommentAttemptCurrent(admissionId, attemptId, paths)) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'The Autopilot comment attempt is no longer current; refusing result delivery.',
        { requires: ['currentCommentAttempt'] },
      );
    }
    const isDeliveryAttemptCurrentAndPrOpen = async () => {
      if (!isCoordinatorCommentAttemptCurrent(admissionId, attemptId, paths)) {
        return false;
      }
      const latestState = await fetchEventState({
        token,
        owner,
        repo: repoName,
        number: prNumber,
      });
      return (
        isOpenPullRequest(latestState) &&
        (!deliveredSha || latestState.headSha === deliveredSha)
      );
    };
    const topLevelKey = `autofix-result:${admissionId}:${commitSha ?? preparedDiff.headSha ?? 'unknown'}`;
    const topLevelDelivery = reserveResultDelivery(
      {
        admissionId,
        attemptId,
        deliveryKind: 'top-level',
        targetId: 'pull-request',
        idempotencyKey: topLevelKey,
      },
      paths,
    );
    const topLevelClaim = claimResultDelivery(topLevelDelivery.id, paths);
    const comment =
      topLevelClaim.status === 'claimed'
        ? (await isDeliveryAttemptCurrentAndPrOpen())
          ? await postGitHubPrComment(
              {
                repo: preparedDiff.repoFullName,
                prNumber: preparedDiff.prNumber,
                body: auditSummary.markdown,
                addressedReviewThreadIds,
                addressedReviewCommentIds,
                checkRunIds,
                commitSha,
                idempotencyKey: topLevelKey,
              },
              paths,
              {
                token,
                fetchPullRequestEventState:
                  dependencies.fetchPullRequestEventState,
                postPullRequestComment: dependencies.postPullRequestComment,
                listPullRequestComments: dependencies.listPullRequestComments,
              },
            )
          : staleCommentAttemptResult()
        : deliveryClaimResult(topLevelClaim, 'Result delivery');
    if (topLevelClaim.status === 'claimed') {
      settleResultDelivery(
        topLevelDelivery.id,
        topLevelClaim.leaseToken,
        comment.ok
          ? { status: 'delivered', remoteId: resultDeliveryRemoteId(comment) }
          : { status: 'failed', error: comment.message },
        paths,
      );
    }

    const threadReplies = [];
    for (const threadId of addressedReviewThreadIds) {
      if (typeof threadId !== 'string') continue;
      const threadKey = `autofix-result-thread:${admissionId}:${threadId}:${commitSha ?? 'unknown'}`;
      const delivery = reserveResultDelivery(
        {
          admissionId,
          attemptId,
          deliveryKind: 'thread-reply',
          targetId: threadId,
          idempotencyKey: threadKey,
        },
        paths,
      );
      const claim = claimResultDelivery(delivery.id, paths);
      const reply =
        claim.status === 'claimed'
          ? (await isDeliveryAttemptCurrentAndPrOpen())
            ? await postGitHubPrThreadReply(
                {
                  repo: preparedDiff.repoFullName,
                  prNumber: preparedDiff.prNumber,
                },
                threadId,
                {
                  text: `Autopilot pushed ${commitSha ?? 'the prepared fix'}. ${auditSummary.markdown}`,
                  idempotencyKey: threadKey,
                },
                paths,
                {
                  token: dependencies.token,
                  fetchPullRequestReviewThread:
                    dependencies.fetchPullRequestReviewThread,
                  replyToPullRequestReviewThread:
                    dependencies.replyToPullRequestReviewThread,
                },
              )
            : staleCommentAttemptResult()
          : deliveryClaimResult(claim, 'Thread delivery');
      if (claim.status === 'claimed') {
        settleResultDelivery(
          delivery.id,
          claim.leaseToken,
          reply.ok
            ? { status: 'delivered', remoteId: resultDeliveryRemoteId(reply) }
            : { status: 'failed', error: reply.message },
          paths,
        );
      }
      threadReplies.push({ threadId, reply });
    }
    const auditErrors: string[] = [];
    try {
      workflowSummary =
        (await updateWorkflowSummary(
          workflowSummary.id,
          {
            status: comment.ok ? 'completed' : 'failed',
            summary: {
              humanSummary: auditSummary.markdown,
              audit: auditSummary.facts,
              comment,
              threadReplies,
            },
          },
          paths,
        )) ?? workflowSummary;
    } catch (error) {
      auditErrors.push(
        `Could not update PR autofix comment audit: ${errorMessage(error)}`,
      );
    }

    const deliveryOk =
      comment.ok && threadReplies.every((item) => item.reply.ok === true);
    const deliveryLeaseActive =
      !deliveryOk &&
      [comment, ...threadReplies.map((item) => item.reply)].some(
        (result) => 'code' in result && result.code === 'delivery-lease-active',
      );
    const errors = unique([
      ...(comment.ok ? [] : (comment.errors ?? [])),
      ...threadReplies.flatMap((item) =>
        item.reply.ok ? [] : (item.reply.errors ?? [item.reply.message]),
      ),
      ...auditErrors,
    ]);
    const successfulMessage = comment.changed
      ? `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`
      : `Reused the existing autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`;
    await notifyAutopilotState(
      {
        state: 'comment-result',
        outcome: deliveryOk ? 'posted' : 'blocked',
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
        repoFullName: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        workflow: 'comment_pr_autofix_result',
        message: deliveryOk ? successfulMessage : comment.message,
        recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
        data: { comment, threadReplies, auditErrors },
      },
      paths,
    );

    return {
      ok: deliveryOk,
      action: 'autopilot_comment_pr_autofix_result',
      changed: comment.changed,
      message: deliveryOk
        ? auditErrors.length > 0
          ? `${successfulMessage.slice(0, -1)}, but the audit update failed.`
          : successfulMessage
        : comment.message,
      ...(deliveryLeaseActive ? { code: 'delivery-lease-active' } : {}),
      workflowSummary: asJsonValue(workflowSummary),
      data: asJsonValue({
        preparedDiff,
        auditSummary,
        comment,
        threadReplies,
        workflowSummary,
      }),
      ...(errors.length > 0 ? { errors } : {}),
      ...('requires' in comment && comment.requires
        ? { requires: comment.requires }
        : {}),
    };
  } catch (error) {
    if (notificationPreparedDiff) {
      await notifyAutopilotState(
        {
          state: 'failed-workflow',
          outcome: 'failed',
          preparedDiffId: notificationPreparedDiff.id,
          worktreeId: notificationPreparedDiff.worktreeId,
          repoFullName: notificationPreparedDiff.repoFullName,
          prNumber: notificationPreparedDiff.prNumber,
          workflow: 'comment_pr_autofix_result',
          message: `comment_pr_autofix_result failed: ${errorMessage(error)}`,
          recoveryActions: recoveryActionsForPreparedDiff(
            notificationPreparedDiff,
          ),
          data: { error: errorMessage(error) },
        },
        paths,
      ).catch(() => undefined);
    }
    return failResult(
      'autopilot_comment_pr_autofix_result',
      'Could not comment on PR autofix result.',
      { errors: [errorMessage(error)] },
    );
  }
}

function reserveResultDelivery(
  input: {
    admissionId: string;
    attemptId: string;
    deliveryKind: string;
    targetId: string;
    idempotencyKey: string;
  },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const existing = database
        .prepare(
          `SELECT id FROM autopilot_result_deliveries
           WHERE idempotency_key = ?;`,
        )
        .get(input.idempotencyKey) as
        { id: string; status: string } | undefined;
      if (existing) return existing;
      const id = `autopilot-delivery:${randomUUID()}`;
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO autopilot_result_deliveries (
             id, admission_id, attempt_id, delivery_kind, target_id,
             idempotency_key, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?);`,
        )
        .run(
          id,
          input.admissionId,
          input.attemptId,
          input.deliveryKind,
          input.targetId,
          input.idempotencyKey,
          now,
          now,
        );
      return { id };
    });
  } finally {
    database.close();
  }
}

type ResultDeliveryClaim =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'delivered' | 'leased' };

function claimResultDelivery(
  id: string,
  paths: RuntimePaths,
): ResultDeliveryClaim {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const now = new Date();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      const result = database
        .prepare(
          `UPDATE autopilot_result_deliveries
           SET status = 'delivering', error = NULL, lease_token = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND (
             status IN ('reserved', 'failed')
             OR (status = 'delivering' AND lease_expires_at <= ?)
           );`,
        )
        .run(
          leaseToken,
          leaseExpiresAt,
          now.toISOString(),
          id,
          now.toISOString(),
        );
      if (result.changes === 1) return { status: 'claimed', leaseToken };
      const existing = database
        .prepare('SELECT status FROM autopilot_result_deliveries WHERE id = ?;')
        .get(id) as { status: string } | undefined;
      return {
        status: existing?.status === 'delivered' ? 'delivered' : 'leased',
      };
    });
  } finally {
    database.close();
  }
}

function deliveryClaimResult(
  claim: Exclude<ResultDeliveryClaim, { status: 'claimed' }>,
  label: string,
) {
  if (claim.status === 'delivered') {
    return {
      ok: true,
      changed: false,
      message: `${label} is already settled.`,
      errors: [] as string[],
    };
  }
  const message = `${label} is held by an active delivery lease.`;
  return {
    ok: false,
    changed: false,
    code: 'delivery-lease-active',
    message,
    errors: [message],
  };
}

function settleResultDelivery(
  id: string,
  leaseToken: string,
  outcome:
    | { status: 'delivered'; remoteId: string | null }
    | { status: 'failed'; error: string },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE autopilot_result_deliveries
         SET status = ?, remote_id = ?, error = ?, lease_token = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'delivering' AND lease_token = ?;`,
      )
      .run(
        outcome.status,
        outcome.status === 'delivered' ? outcome.remoteId : null,
        outcome.status === 'failed' ? outcome.error : null,
        new Date().toISOString(),
        id,
        leaseToken,
      );
  } finally {
    database.close();
  }
}

function resultDeliveryRemoteId(result: unknown) {
  if (!result || typeof result !== 'object') return null;
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const comment = record.comment;
  if (comment && typeof comment === 'object') {
    const id =
      (comment as { databaseId?: unknown; id?: unknown }).databaseId ??
      (comment as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  const thread = record.thread;
  if (thread && typeof thread === 'object') {
    const comments = (thread as { comments?: unknown }).comments;
    if (Array.isArray(comments)) {
      const last = comments.at(-1);
      const id =
        last && typeof last === 'object'
          ? ((last as { databaseId?: unknown; id?: unknown }).databaseId ??
            (last as { id?: unknown }).id)
          : undefined;
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
  }
  return null;
}

function staleCommentAttemptResult() {
  return {
    ok: false,
    changed: false,
    message: 'The Autopilot comment attempt is no longer current.',
    errors: ['The Autopilot comment attempt is no longer current.'],
  };
}

function isOpenPullRequest(state: { state: string; merged: boolean }) {
  return state.state === 'open' && !state.merged;
}

function isCoordinatorCommentAttemptCurrent(
  admissionId: string,
  attemptId: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT admission.id
           FROM autopilot_admissions AS admission
           INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
           INNER JOIN autopilot_stage_attempts AS attempt
             ON attempt.id = admission.current_stage_attempt_id
           WHERE admission.id = ? AND admission.current_stage_attempt_id = ?
             AND admission.state = 'comment-admitted'
             AND attempt.stage = 'comment-result'
             AND attempt.status IN ('reserved', 'running')
             AND admission.stop_requested_at IS NULL AND owner.status = 'active';`,
        )
        .get(admissionId, attemptId),
    );
  } finally {
    database.close();
  }
}
