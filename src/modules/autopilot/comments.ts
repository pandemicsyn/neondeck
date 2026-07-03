/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { type GitHubCheckSummary, type GitHubFailingCheckFact, type GitHubPullRequestDetail, type GitHubPullRequestEventState, fetchPullRequestEventState, fetchCheckSummary, fetchFailingCheckFacts, fetchPullRequestDetail } from '../../github';
import { checkAutopilotConcurrency, checkAutopilotPolicy, pathDeniedByAutopilotPolicy, repoAutopilotPolicy, withAutopilotLocalExecutionSlot } from '../../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../../app-state';
import { notifyAutopilotState, recoveryActionsForPreparedDiff } from '../../autopilot-notifications';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { runApprovedExecution } from '../../execution-actions';
import { getGitHubPrBranchPermissions, postGitHubPrComment } from '../../pr-event-state';
import { ensurePreparedDiffForWorktree, markPreparedDiffPushBlocked, markPreparedDiffPushed, readPreparedDiff, readPreparedDiffByWorktree, readPreparedDiffRecord, recordPreparedDiffVerification, type PreparedDiffRecord } from '../../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import { gitCurrentSha, gitCommitAll, gitCommitPaths, gitPushHead, gitStatus, type GitCommitResult } from '../../repo-edit/git';
import { patchRepoFiles, readRepoDiff, readRepoFile, replaceRepoFile } from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import { type RuntimePaths, parseAppConfig, ensureRuntimeHome, readRuntimeJson, runtimePaths } from '../../runtime-home';
import { createWorktree, listWorktrees, lockWorktree, recordWorktreePushBlocked, recordWorktreePushSucceeded, readManagedWorktree, readWorktreeStatus, releaseWorktreeLock, syncWorktree, type WorktreeRecord } from '../../worktrees';
import { AutopilotActionResult, AutopilotDependencies, AutopilotTriageClass, autopilotFixtureSchema, autopilotModeSchema, autopilotOutputSchema, checkSummarySchema, commentPrAutofixResultInputSchema, fixPrCiFailureInputSchema, fixPrReviewFeedbackInputSchema, prEventDeltaSchema, prEventSnapshotSchema, prFactsSchema, prReviewEventStateSchema, preparePrWorktreeInputSchema, pushPrAutofixInputSchema, reviewFixReplacementSchema, triagePrEventInputSchema, verifyPrWorktreeInputSchema } from './schemas';
import { asJsonValue, failResult, lowerLevelFailure, parseInput, resolveVerificationChecks, objectField, stringField, booleanField, numberField, arrayField, numberArrayField, unique, errorMessage, isAutopilotActionResult } from './utils';
import { dependenciesWithAutopilotFixture } from './fixtures';
import { fetchPreparedPrFacts, fetchPreparedCheckFacts, fetchCiFailureFacts, generatedCiFixCommitMessage, identifyLikelyCommands, runAutopilotDiagnostics } from './github-facts';
import { prFactsFromDetail, repoSummary, classifySignals, classificationFor, reasonsFor } from './triage-support';
import { blockPushAttempt, preparedDiffCommitSha, pushNotReadyResult, pushReadinessGates, recoveryOptionsForPushBlock, remoteForPush } from './push-support';
import { addressedFeedback, applyReviewEdits, buildReviewFixPlan, fetchReviewEventState, groupReviewFeedback, plannedEditPaths, readReviewTargetFiles, reviewFactsFromEventState, reviewFixCommitMessage, reviewTargetPathSet, worktreeStatusDirty } from './review-support';

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
    if (
      preparedDiff.headSha &&
      currentState.headSha &&
      preparedDiff.headSha !== currentState.headSha
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
            preparedHeadSha: preparedDiff.headSha,
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
          preparedHeadSha: preparedDiff.headSha,
          currentHeadSha: currentState.headSha,
        }),
        requires: ['currentPrHead'],
        errors: [
          `Prepared diff head ${preparedDiff.headSha} does not match current PR head ${currentState.headSha}.`,
        ],
      };
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
    const commitSha = stringField(facts, 'commitSha') ?? undefined;
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

    const comment = await postGitHubPrComment(
      {
        repo: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        body: auditSummary.markdown,
        addressedReviewThreadIds,
        addressedReviewCommentIds,
        checkRunIds,
        commitSha,
      },
      paths,
      {
        token,
        fetchPullRequestEventState: dependencies.fetchPullRequestEventState,
        postPullRequestComment: dependencies.postPullRequestComment,
      },
    );

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
            },
          },
          paths,
        )) ?? workflowSummary;
    } catch (error) {
      auditErrors.push(
        `Could not update PR autofix comment audit: ${errorMessage(error)}`,
      );
    }

    const errors = unique([
      ...(comment.ok ? [] : (comment.errors ?? [])),
      ...auditErrors,
    ]);
    await notifyAutopilotState(
      {
        state: 'comment-result',
        outcome: comment.ok ? 'posted' : 'blocked',
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
        repoFullName: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        workflow: 'comment_pr_autofix_result',
        message: comment.ok
          ? `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`
          : comment.message,
        recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
        data: { comment, auditErrors },
      },
      paths,
    );

    return {
      ok: comment.ok,
      action: 'autopilot_comment_pr_autofix_result',
      changed: comment.changed,
      message: comment.ok
        ? auditErrors.length > 0
          ? `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}, but the audit update failed.`
          : `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`
        : comment.message,
      workflowSummary: asJsonValue(workflowSummary),
      data: asJsonValue({
        preparedDiff,
        auditSummary,
        comment,
        workflowSummary,
      }),
      ...(errors.length > 0 ? { errors } : {}),
      ...(comment.requires ? { requires: comment.requires } : {}),
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
