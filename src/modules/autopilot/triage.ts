/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
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
} from '../../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from '../../autopilot-notifications';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { runApprovedExecution } from '../../execution-actions';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from '../../pr-event-state';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
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
} from '../../worktrees';
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
import { asJsonValue, parseInput } from './utils';
import {
  classifySignals,
  classificationFor,
  reasonsFor,
} from './triage-support';

export async function triagePrEvent(
  rawInput: unknown,
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    triagePrEventInputSchema,
    rawInput,
    'autopilot_triage_pr_event',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const deltas = input.deltas ?? [];
  const mode = input.autopilotMode ?? 'draft-fix';
  const signals = classifySignals(input.current, deltas);
  const classification = classificationFor(mode, signals);
  const shouldPrepareWorktree =
    classification === 'draft-fix' ||
    classification === 'auto-fix-no-push' ||
    classification === 'auto-fix-push-after-checks';
  const reasons = reasonsFor(classification, mode, signals, deltas);

  return {
    ok: true,
    action: 'autopilot_triage_pr_event',
    changed: classification !== 'no-op',
    message:
      classification === 'no-op'
        ? 'PR event does not require autopilot action.'
        : `PR event classified as ${classification}.`,
    data: asJsonValue({
      classification,
      autopilotMode: mode,
      shouldPrepareWorktree,
      nextWorkflow: shouldPrepareWorktree ? 'prepare_pr_worktree' : null,
      source: input.source ?? 'api',
      eventId: input.eventId ?? null,
      watchId: input.watchId ?? null,
      repoId: input.repoId ?? null,
      repoFullName: input.repoFullName ?? null,
      prNumber: input.prNumber,
      reasons,
      deltas,
      previous: input.previous ?? null,
      current: input.current ?? null,
    }),
  };
}
