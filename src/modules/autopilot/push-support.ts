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
import { AutopilotActionResult } from './schemas';
import { asJsonValue, objectField, stringField } from './utils';

export function pushReadinessGates(
  preparedDiff: PreparedDiffRecord,
  options: { requireApproval?: boolean } = {},
) {
  const requireApproval = options.requireApproval !== false;
  const allowedStatuses = requireApproval
    ? ['push-approved', 'push-blocked']
    : ['prepared', 'verification-requested', 'push-approved', 'push-blocked'];
  return [
    {
      gate: 'prepared-diff-status',
      ok: allowedStatuses.includes(preparedDiff.status),
      reason: allowedStatuses.includes(preparedDiff.status)
        ? `Prepared diff status is ${preparedDiff.status}.`
        : ['pushed', 'abandoned'].includes(preparedDiff.status)
          ? `Prepared diff status is ${preparedDiff.status}; terminal records are not pushed again.`
          : `Prepared diff status is ${preparedDiff.status}, not ready to push.`,
    },
    {
      gate: 'prepared-diff-approval',
      ok: !requireApproval || preparedDiff.pushApprovalStatus === 'approved',
      reason:
        !requireApproval || preparedDiff.pushApprovalStatus === 'approved'
          ? 'Prepared diff push approval is approved.'
          : `Prepared diff push approval is ${preparedDiff.pushApprovalStatus}.`,
    },
    {
      gate: 'verification',
      ok: preparedDiff.verificationStatus === 'passed',
      reason:
        preparedDiff.verificationStatus === 'passed'
          ? 'Prepared diff verification passed.'
          : `Prepared diff verification is ${preparedDiff.verificationStatus}.`,
    },
  ];
}

export function pushNotReadyResult(
  preparedDiff: PreparedDiffRecord,
  worktreeId: string,
  gates: Array<{ gate: string; ok: boolean; reason: string }>,
  recoveryOptions: string[],
): AutopilotActionResult {
  const failedGates = gates.filter((gate) => !gate.ok);
  return {
    ok: false,
    action: 'autopilot_push_pr_autofix',
    changed: false,
    message: 'Prepared diff is not ready for push-back.',
    data: asJsonValue({
      preparedDiff,
      worktree: { id: worktreeId },
      gates,
      recoveryOptions,
    }),
    requires: failedGates.map((gate) => gate.gate),
    errors: failedGates.map((gate) => gate.reason),
  };
}

export async function blockPushAttempt(
  preparedDiffId: string,
  worktreeId: string,
  message: string,
  input: {
    gates: Array<{ gate: string; ok: boolean; reason: string }>;
    paths: RuntimePaths;
    recoveryOptions?: string[];
    data?: unknown;
  },
): Promise<AutopilotActionResult> {
  const recoveryOptions =
    input.recoveryOptions ?? recoveryOptionsForPushBlock(input.gates);
  const preparedDiff = markPreparedDiffPushBlocked(
    preparedDiffId,
    {
      reason: message,
      gates: input.gates,
      recoveryOptions,
    },
    input.paths,
  );
  const worktree = await recordWorktreePushBlocked(
    worktreeId,
    {
      message,
      data: {
        preparedDiffId,
        gates: input.gates,
        recoveryOptions,
        details: input.data ?? null,
      },
    },
    input.paths,
  ).catch(() => null);
  if (preparedDiff) {
    await notifyAutopilotState(
      {
        state: 'push-blocked',
        outcome: 'blocked',
        preparedDiffId,
        worktreeId,
        repoFullName: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        workflow: 'push_pr_autofix',
        message,
        recoveryOptions,
        recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
        data: { gates: input.gates, details: input.data ?? null },
      },
      input.paths,
    );
  }
  return {
    ok: false,
    action: 'autopilot_push_pr_autofix',
    changed: true,
    message,
    data: asJsonValue({
      preparedDiff,
      worktree,
      gates: input.gates,
      recoveryOptions,
      details: input.data ?? null,
    }),
    requires: input.gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
    errors: input.gates.filter((gate) => !gate.ok).map((gate) => gate.reason),
  };
}

export function recoveryOptionsForPushBlock(
  gates: Array<{ gate: string; ok: boolean; reason: string }>,
) {
  const failed = new Set(
    gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
  );
  const options: string[] = [];
  if (failed.has('autopilot-mode') || failed.has('autopilot-policy')) {
    options.push(
      'Review repo autopilot policy or request a lower-risk revision before retrying.',
    );
  }
  if (failed.has('prepared-diff-approval')) {
    options.push('Approve the prepared diff push-back, then retry.');
  }
  if (failed.has('verification')) {
    options.push('Run verify_pr_worktree and retry only after checks pass.');
  }
  if (failed.has('github-permissions')) {
    options.push(
      'Grant branch push permission, ask the PR author to enable maintainer edits, or push manually from the retained worktree.',
    );
  }
  if (failed.has('clean-worktree') || failed.has('committed-diff')) {
    options.push(
      'Commit or discard local worktree changes, then rerun verification and push.',
    );
  }
  if (failed.has('force-push')) {
    options.push(
      'Create a normal forward commit; force-push remains deferred.',
    );
  }
  return options.length > 0
    ? options
    : ['Inspect the retained worktree, resolve the blocked gate, and retry.'];
}

export { githubRemoteUrl, remoteForPush } from '../worktrees';

export function preparedDiffCommitSha(
  summary: JsonValue | null,
  section: string,
  key: string,
) {
  return stringField(objectField(summary, section), key);
}
