/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import {
  type GitHubCheckSummary,
  type GitHubFailingCheckFact,
  type GitHubPullRequestDetail,
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
  fetchGitHubLogin,
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
  listApprovalRecords,
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
  assertWorktreeMutationAllowed,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  pushTargetForWorktree,
  resolvePrPushTargetForCheckout,
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

const execFileAsync = promisify(execFile);

export async function pushPrAutofix(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    pushPrAutofixInputSchema,
    rawInput,
    'autopilot_push_pr_autofix',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  const lockOwner = input.lockOwner ?? 'push_pr_autofix';
  let acquiredLockId: string | undefined;
  let finalLockStatus: 'prepared-diff' | 'succeeded' = 'prepared-diff';
  let pushedSideEffect:
    { commitSha: string; remote: string; branch: string } | undefined;

  try {
    await ensureRuntimeHome(paths);
    const preparedDiff = readPreparedDiff(input.preparedDiffId, paths);
    if (!preparedDiff) {
      return failResult(
        'autopilot_push_pr_autofix',
        `Prepared diff "${input.preparedDiffId}" was not found.`,
        { requires: ['preparedDiffId'] },
      );
    }
    const worktree = await readManagedWorktree(
      preparedDiff.worktreeId,
      preparedDiff.repoId,
      paths,
    );
    const readinessGates = pushReadinessGates(preparedDiff, {
      requireApproval: false,
    });
    const failedReadinessGates = readinessGates.filter((gate) => !gate.ok);
    if (failedReadinessGates.length > 0) {
      return pushNotReadyResult(
        preparedDiff,
        worktree.id,
        readinessGates,
        recoveryOptionsForPushBlock(failedReadinessGates),
      );
    }
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find(
      (candidate) => candidate.id === preparedDiff.repoId,
    );
    if (!repo) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Repository is not configured.',
        {
          gates: [
            {
              gate: 'repo',
              ok: false,
              reason: `Repository "${preparedDiff.repoId}" is not configured.`,
            },
          ],
          paths,
        },
      );
    }
    if (!preparedDiff.prNumber) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Prepared diff is not linked to a PR.',
        {
          gates: [
            {
              gate: 'pull-request',
              ok: false,
              reason: 'Prepared diff has no PR number.',
            },
          ],
          paths,
        },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: preparedDiff.prNumber,
        workflow: 'push_pr_autofix',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        concurrency.message,
        {
          gates: [
            {
              gate: 'concurrency',
              ok: false,
              reason: concurrency.message,
            },
          ],
          paths,
          recoveryOptions: [
            'Wait for the active autopilot workflow to finish, then retry push_pr_autofix.',
          ],
        },
      );
    }

    const locked = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: lockOwner,
        ttlSeconds: input.lockTtlSeconds ?? 3_600,
      },
      paths,
    );
    if (!locked.ok) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        stringField(locked, 'message') ??
          'Worktree lock could not be acquired.',
        {
          gates: [
            {
              gate: 'worktree-lock',
              ok: false,
              reason:
                stringField(locked, 'message') ??
                'Worktree lock could not be acquired.',
            },
          ],
          paths,
          recoveryOptions: [
            'Wait for the active worktree lock to release, then retry push_pr_autofix.',
          ],
        },
      );
    }
    acquiredLockId = stringField(objectField(locked, 'lock'), 'id');

    const policy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: preparedDiff.headSha ?? preparedDiff.baseRef,
        pushDestination: 'pull-request-head',
        forcePush: input.force,
      },
      paths,
    );
    const permissions = await (
      dependencies.getBranchPermissions ?? getGitHubPrBranchPermissions
    )(
      {
        repo: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
      },
      paths,
    );
    const status = await gitStatus(worktree.localPath);
    const currentSha = await gitCurrentSha(worktree.localPath);
    const expectedRemoteSha = preparedDiff.headSha ?? worktree.headSha;
    const branchPermissions = objectField(
      objectField(permissions, 'data'),
      'branchPermissions',
    );
    const canLikelyPush =
      booleanField(branchPermissions, 'canLikelyPush') === true;
    const approvedCommitSha = preparedDiffCommitSha(
      preparedDiff.summary,
      'pushApproval',
      'approvedCommitSha',
    );
    const verifiedCommitSha = preparedDiffCommitSha(
      preparedDiff.summary,
      'verification',
      'verifiedCommitSha',
    );
    const modeAllowsPush =
      policy.mode === 'autofix-with-approval' ||
      policy.mode === 'autofix-push-when-safe';
    const requiresExplicitApproval =
      policy.mode === 'autofix-with-approval' ||
      policy.decision === 'require-approval';
    const hasCommittedDiff = policy.diff.filesChanged > 0;
    const approvalPolicyHash = input.admissionId
      ? admissionPolicyHash(policy.policyHash, policy.mode)
      : policy.policyHash;
    const approvalBinding = input.admissionId
      ? readCoordinatorPushApprovalBinding(input.admissionId, paths)
      : undefined;
    const matchingPushApproval = listApprovalRecords(
      { status: 'approved', preparedDiffIds: [preparedDiff.id] },
      paths,
    ).find(
      (approval) =>
        approval.approvalType === 'push' &&
        approval.targetSha === currentSha &&
        approval.policyHash === approvalPolicyHash &&
        approval.policyDecision !== 'deny' &&
        (!input.admissionId ||
          (approval.admissionId === input.admissionId &&
            approval.ownerGeneration === approvalBinding?.owner_generation &&
            approval.stageAttemptId ===
              approvalBinding?.verification_attempt_id)),
    );
    if (
      input.admissionId &&
      !matchingPushApproval &&
      policy.decision !== 'deny'
    ) {
      rearmAdmissionForFreshPushApproval(
        input.admissionId,
        input.attemptId,
        paths,
      );
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'The approved SHA or policy binding changed; a fresh admission-bound approval is required.',
        {
          gates: [
            {
              gate: 'sha-bound-policy-approval',
              ok: false,
              reason:
                'The current worktree SHA or effective policy no longer matches the resolved approval.',
            },
          ],
          paths,
          recoveryOptions: [
            'The coordinator will re-evaluate policy and create a fresh approval when required.',
          ],
        },
      );
    }
    const gates = [
      {
        gate: 'autopilot-mode',
        ok: modeAllowsPush,
        reason: modeAllowsPush
          ? `Repo policy mode is ${policy.mode}.`
          : `Repo policy mode is ${policy.mode}, not a push-capable mode.`,
      },
      {
        gate: 'autopilot-policy',
        ok: Boolean(
          policy.decision !== 'deny' &&
          (!requiresExplicitApproval || matchingPushApproval),
        ),
        reason:
          policy.decision === 'deny'
            ? policy.message
            : matchingPushApproval
              ? 'A matching SHA-bound approval satisfies this policy requirement.'
              : policy.message,
      },
      {
        gate: 'prepared-diff-approval',
        ok:
          !requiresExplicitApproval ||
          preparedDiff.pushApprovalStatus === 'approved',
        reason:
          preparedDiff.pushApprovalStatus === 'approved'
            ? 'Prepared diff push approval is approved.'
            : `Prepared diff push approval is ${preparedDiff.pushApprovalStatus}.`,
      },
      {
        gate: 'sha-bound-policy-approval',
        ok: !requiresExplicitApproval || Boolean(matchingPushApproval),
        reason: matchingPushApproval
          ? 'A matching SHA-bound approval satisfies this policy requirement.'
          : 'No approved push approval matches the current SHA and policy.',
      },
      {
        gate: 'prepared-diff-status',
        ok: requiresExplicitApproval
          ? ['push-approved', 'push-blocked'].includes(preparedDiff.status)
          : [
              'prepared',
              'verification-requested',
              'push-approved',
              'push-blocked',
            ].includes(preparedDiff.status),
        reason: (requiresExplicitApproval
          ? ['push-approved', 'push-blocked']
          : [
              'prepared',
              'verification-requested',
              'push-approved',
              'push-blocked',
            ]
        ).includes(preparedDiff.status)
          ? `Prepared diff status is ${preparedDiff.status}.`
          : `Prepared diff status is ${preparedDiff.status}, not ready to push.`,
      },
      {
        gate: 'verification',
        ok: preparedDiff.verificationStatus === 'passed',
        reason:
          preparedDiff.verificationStatus === 'passed'
            ? 'Prepared diff verification passed.'
            : `Prepared diff verification is ${preparedDiff.verificationStatus}.`,
      },
      {
        gate: 'approved-commit',
        ok: !requiresExplicitApproval || approvedCommitSha === currentSha,
        reason:
          approvedCommitSha === currentSha
            ? 'Prepared diff push approval matches current HEAD.'
            : approvedCommitSha
              ? 'Current HEAD differs from the approved prepared-diff commit.'
              : 'Prepared diff approval does not record an approved commit SHA.',
      },
      {
        gate: 'verified-commit',
        ok: verifiedCommitSha === currentSha,
        reason:
          verifiedCommitSha === currentSha
            ? 'Prepared diff verification matches current HEAD.'
            : verifiedCommitSha
              ? 'Current HEAD differs from the verified prepared-diff commit.'
              : 'Prepared diff verification does not record a verified commit SHA.',
      },
      {
        gate: 'github-permissions',
        ok: canLikelyPush,
        reason: canLikelyPush
          ? 'GitHub branch permission facts allow likely push-back.'
          : permissions.ok
            ? 'GitHub branch permission facts do not allow direct push-back.'
            : permissions.message,
      },
      {
        gate: 'clean-worktree',
        ok: status.clean,
        reason: status.clean
          ? 'Worktree has no uncommitted changes.'
          : `Worktree has ${status.files.length} uncommitted change(s).`,
      },
      {
        gate: 'committed-diff',
        ok: hasCommittedDiff,
        reason: hasCommittedDiff
          ? `Prepared diff contains ${policy.diff.filesChanged} committed file change(s).`
          : 'No committed diff remains to push.',
      },
      {
        gate: 'remote-head-sha',
        ok: expectedRemoteSha !== null,
        reason: expectedRemoteSha
          ? `Expected remote PR head is ${expectedRemoteSha}.`
          : 'Neither the prepared diff nor managed worktree records the original PR head SHA.',
      },
      {
        gate: 'force-push',
        ok: input.force !== true,
        reason:
          input.force === true
            ? 'push_pr_autofix does not perform force-pushes in this slice.'
            : 'Force-push is not requested.',
      },
    ];
    let failedGates = gates.filter((gate) => !gate.ok);
    if (failedGates.length > 0) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Prepared diff is blocked from push-back.',
        {
          gates,
          paths,
          recoveryOptions: recoveryOptionsForPushBlock(failedGates),
          data: { policy, permissions, status, currentSha, concurrency },
        },
      );
    }

    const apiLogin = dependencies.pushGit
      ? null
      : await resolvePushApiLogin(dependencies);
    const identityGate = {
      gate: 'git-api-identity',
      ok: dependencies.pushGit !== undefined || apiLogin !== null,
      reason: dependencies.pushGit
        ? 'The injected push adapter owns its credential identity gate.'
        : apiLogin
          ? `The immediate Git gate requires API actor ${apiLogin}.`
          : 'GitHub API identity is unavailable for the immediate Git credential gate.',
    };
    gates.push(identityGate);
    failedGates = identityGate.ok ? [] : [identityGate];
    if (failedGates.length > 0) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Prepared diff is blocked from push-back.',
        {
          gates,
          paths,
          recoveryOptions: recoveryOptionsForPushBlock(failedGates),
          data: { policy, permissions, status, currentSha, concurrency },
        },
      );
    }

    const pushTarget = dependencies.pushGit
      ? pushTargetForWorktree(worktree, branchPermissions)
      : await resolvePrPushTargetForCheckout({
          sourceRepoPath: worktree.localPath,
          baseRepoFullName: worktree.repoFullName,
          headRepoFullName:
            stringField(branchPermissions, 'headRepoFullName') ??
            (worktree.headOwner && worktree.headName
              ? `${worktree.headOwner}/${worktree.headName}`
              : worktree.repoFullName),
          headRef: worktree.headRef,
          branchPermissions,
        });
    const remote = pushTarget.remote;
    const branch = pushTarget.branch;
    if (
      input.admissionId &&
      !isCoordinatorPushAdmissionCurrent(
        input.admissionId,
        input.attemptId,
        paths,
      )
    ) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'The Autopilot admission is no longer push-current; refusing the terminal PR mutation.',
        {
          gates: [
            ...gates,
            {
              gate: 'admission-terminal-fence',
              ok: false,
              reason:
                'The owning PR admission was stopped, superseded, or otherwise replaced before push.',
            },
          ],
          paths,
          recoveryOptions: [
            'Refresh the pull request state and create a new admission if work remains.',
          ],
        },
      );
    }
    assertWorktreeMutationAllowed(
      {
        repoId: worktree.repoId,
        worktreeId: worktree.id,
        lockId: acquiredLockId,
      },
      paths,
    );
    // This is the last durable owner-state read before the irreversible Git
    // side effect. Terminal PR handling changes the same admission/owner rows.
    if (
      input.admissionId &&
      !isCoordinatorPushAdmissionCurrent(
        input.admissionId,
        input.attemptId,
        paths,
      )
    ) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'The Autopilot admission became terminal before Git accepted the push.',
        {
          gates,
          paths,
          recoveryOptions: ['Refresh the terminal PR state before retrying.'],
        },
      );
    }
    if (input.admissionId) {
      const token = dependencies.token ?? process.env.GITHUB_TOKEN;
      const [owner, repoName] = preparedDiff.repoFullName.split('/', 2);
      if (!token || !owner || !repoName) {
        return blockPushAttempt(
          preparedDiff.id,
          worktree.id,
          'A current GitHub pull request recheck is required before coordinator push.',
          {
            gates,
            paths,
            recoveryOptions: ['Configure GitHub credentials and retry.'],
          },
        );
      }
      let currentPr;
      try {
        currentPr = await (
          dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState
        )({ token, owner, repo: repoName, number: preparedDiff.prNumber });
      } catch (error) {
        return blockPushAttempt(
          preparedDiff.id,
          worktree.id,
          `Could not recheck the current pull request before push: ${errorMessage(error)}`,
          {
            gates,
            paths,
            recoveryOptions: [
              'Retry after GitHub pull request state is available.',
            ],
          },
        );
      }
      const currentPrGate = {
        gate: 'current-pr-before-push',
        ok:
          currentPr.state.toLowerCase() === 'open' &&
          !currentPr.merged &&
          currentPr.headSha === expectedRemoteSha &&
          currentPr.headRef === worktree.headRef &&
          currentPr.branchPermissions.canLikelyPush === true,
        reason: `Current PR is ${currentPr.state}, head ${currentPr.headSha}, branch ${currentPr.headRef ?? 'unknown'}.`,
      };
      gates.push(currentPrGate);
      if (!currentPrGate.ok) {
        return blockPushAttempt(
          preparedDiff.id,
          worktree.id,
          'The current GitHub pull request target, head, or permissions changed before push.',
          {
            gates,
            paths,
            recoveryOptions: [
              'Refresh the PR and obtain a fresh approval if needed.',
            ],
          },
        );
      }
    }
    const effectSha = await gitCurrentSha(worktree.localPath);
    const effectPolicy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: preparedDiff.headSha ?? preparedDiff.baseRef,
        pushDestination: 'pull-request-head',
        forcePush: input.force,
      },
      paths,
    );
    const effectApprovalHash = input.admissionId
      ? admissionPolicyHash(effectPolicy.policyHash, effectPolicy.mode)
      : effectPolicy.policyHash;
    const effectApprovalBinding = input.admissionId
      ? readCoordinatorPushApprovalBinding(input.admissionId, paths)
      : undefined;
    const effectApproval = listApprovalRecords(
      { status: 'approved', preparedDiffIds: [preparedDiff.id] },
      paths,
    ).find(
      (approval) =>
        approval.approvalType === 'push' &&
        approval.targetSha === effectSha &&
        approval.policyHash === effectApprovalHash &&
        (!input.admissionId ||
          (approval.admissionId === input.admissionId &&
            approval.ownerGeneration ===
              effectApprovalBinding?.owner_generation &&
            approval.stageAttemptId ===
              effectApprovalBinding?.verification_attempt_id)),
    );
    if (
      effectSha !== currentSha ||
      !effectPolicy.ok ||
      effectPolicy.decision === 'deny' ||
      (input.admissionId && !effectApproval)
    ) {
      if (input.admissionId)
        rearmAdmissionForFreshPushApproval(
          input.admissionId,
          input.attemptId,
          paths,
        );
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Current HEAD or policy changed before Git push; the prior approval was invalidated.',
        {
          gates,
          paths,
          recoveryOptions: ['Await fresh coordinator approval.'],
        },
      );
    }
    const remoteUrl = await readPushRemoteUrl(worktree.localPath, remote);
    const recordedPushIntent = recordPendingPushReconciliation(
      preparedDiff.id,
      { commitSha: currentSha, remote, remoteUrl, branch },
      'push-intent',
      input.admissionId,
      input.attemptId,
      paths,
    );
    if (!recordedPushIntent) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Could not durably record the pending Git push before dispatch.',
        {
          gates,
          paths,
          recoveryOptions: [
            'Restore local state persistence before retrying this push.',
          ],
        },
      );
    }
    // The durable intent is now available for exact remote reconciliation. This
    // is the last possible admission fence before the irreversible Git call.
    if (
      !isCoordinatorPushAdmissionCurrent(
        input.admissionId,
        input.attemptId,
        paths,
      )
    ) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'The Autopilot push attempt was superseded before Git accepted the push.',
        {
          gates,
          paths,
          recoveryOptions: ['Refresh the terminal PR state before retrying.'],
        },
      );
    }
    const push = await (dependencies.pushGit ?? gitPushHead)(
      worktree.localPath,
      {
        remote,
        branch,
        sha: currentSha,
        force: false,
        expectedAccess: apiLogin
          ? { apiLogin, requireBoundIdentity: true }
          : undefined,
        expectedRemoteSha: expectedRemoteSha ?? undefined,
      },
    );
    pushedSideEffect = {
      commitSha: currentSha,
      remote: push.remote,
      branch: push.branch,
    };
    recordPendingPushReconciliation(
      preparedDiff.id,
      pushedSideEffect,
      'push-receipt',
      input.admissionId,
      input.attemptId,
      paths,
    );
    finalLockStatus = 'succeeded';
    const updatedPreparedDiff = markPreparedDiffPushed(
      preparedDiff.id,
      {
        commitSha: currentSha,
        remote: push.remote,
        branch: push.branch,
      },
      paths,
    );
    const updatedWorktree = await recordWorktreePushSucceeded(
      worktree.id,
      {
        commitSha: currentSha,
        message: `Pushed prepared diff ${preparedDiff.id} to ${push.branch}.`,
        data: { preparedDiffId: preparedDiff.id, remote: push.remote },
      },
      paths,
    );
    if (updatedPreparedDiff) {
      await notifyAutopilotState(
        {
          state: 'pushed',
          outcome: 'pushed',
          preparedDiffId: updatedPreparedDiff.id,
          worktreeId: worktree.id,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          workflow: 'push_pr_autofix',
          message: `Pushed ${preparedDiff.repoFullName}#${preparedDiff.prNumber} autofix commit ${currentSha.slice(0, 12)}.`,
          recoveryActions: recoveryActionsForPreparedDiff(updatedPreparedDiff),
          data: {
            commitSha: currentSha,
            remote: push.remote,
            branch: push.branch,
          },
        },
        paths,
      );
    }

    return {
      ok: true,
      action: 'autopilot_push_pr_autofix',
      changed: true,
      message: `Pushed autofix commit ${currentSha.slice(0, 12)} to ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`,
      data: asJsonValue({
        preparedDiff: updatedPreparedDiff,
        worktree: updatedWorktree,
        push,
        gates,
        policy,
        permissions,
        status,
        currentSha,
        pushTarget,
        nextWorkflow: 'comment_pr_autofix_result',
        commentsDeferred: true,
      }),
    };
  } catch (error) {
    if (pushedSideEffect) {
      const parsedInput = v.safeParse(pushPrAutofixInputSchema, rawInput);
      const preparedDiff = parsedInput.success
        ? readPreparedDiff(parsedInput.output.preparedDiffId, paths)
        : null;
      if (preparedDiff) {
        recordPendingPushReconciliation(
          preparedDiff.id,
          pushedSideEffect,
          'push-receipt',
          parsedInput.success ? parsedInput.output.admissionId : undefined,
          parsedInput.success ? parsedInput.output.attemptId : undefined,
          paths,
        );
        await notifyAutopilotState(
          {
            state: 'failed-workflow',
            outcome: 'failed',
            preparedDiffId: preparedDiff.id,
            worktreeId: preparedDiff.worktreeId,
            repoFullName: preparedDiff.repoFullName,
            prNumber: preparedDiff.prNumber,
            workflow: 'push_pr_autofix',
            message:
              'Git push completed, but Neondeck could not finish recording push state.',
            recoveryOptions: [
              'Inspect GitHub and the retained worktree before retrying.',
              'If the commit reached the PR branch, reconcile the prepared-diff state instead of pushing again.',
            ],
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { push: pushedSideEffect, error: errorMessage(error) },
          },
          paths,
        ).catch(() => undefined);
      }
      return {
        ok: false,
        action: 'autopilot_push_pr_autofix',
        changed: true,
        message:
          'Git push completed, but Neondeck could not finish recording push state. Inspect the retained worktree before retrying.',
        data: asJsonValue({
          push: pushedSideEffect,
          error: errorMessage(error),
          recoveryOptions: [
            'Inspect GitHub and the retained worktree before retrying.',
            'If the commit reached the PR branch, reconcile the prepared-diff state instead of pushing again.',
          ],
        }),
        requires: ['state-reconciliation'],
        errors: [errorMessage(error)],
      };
    }
    const parsedInput = v.safeParse(pushPrAutofixInputSchema, rawInput);
    if (parsedInput.success) {
      const preparedDiff = readPreparedDiff(
        parsedInput.output.preparedDiffId,
        paths,
      );
      if (preparedDiff) {
        return blockPushAttempt(
          preparedDiff.id,
          preparedDiff.worktreeId,
          `Could not push prepared diff: ${errorMessage(error)}`,
          {
            gates: [
              {
                gate: 'git-push',
                ok: false,
                reason: errorMessage(error),
              },
            ],
            paths,
            recoveryOptions: [
              'Inspect the retained worktree and retry after fixing git credentials or branch state.',
              'Push manually from the retained worktree if policy allows.',
            ],
          },
        );
      }
    }
    return failResult(
      'autopilot_push_pr_autofix',
      'Could not push PR autofix.',
      {
        errors: [errorMessage(error)],
      },
    );
  } finally {
    if (acquiredLockId) {
      await releaseWorktreeLock(
        {
          lockId: acquiredLockId,
          owner: lockOwner,
          finalStatus: finalLockStatus,
        },
        paths,
      ).catch(() => undefined);
    }
  }
}

function recordPendingPushReconciliation(
  preparedDiffId: string,
  push: {
    commitSha: string;
    remote: string;
    remoteUrl?: string;
    branch: string;
  },
  phase: 'push-intent' | 'push-receipt',
  admissionId: string | undefined,
  attemptId: string | undefined,
  paths: RuntimePaths,
): boolean {
  const database = openDb(paths.neondeckDatabase);
  try {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      )
      .run(
        `autopilot.push-reconciliation:${preparedDiffId}:${attemptId ?? 'unbound'}`,
        JSON.stringify({
          preparedDiffId,
          ...push,
          phase,
          admissionId: admissionId ?? null,
          attemptId: attemptId ?? null,
          recordedAt: now,
        }),
        now,
      );
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function readPushRemoteUrl(cwd: string, remote: string) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['remote', 'get-url', remote],
      { cwd },
    );
    return stdout.trim() || remote;
  } catch {
    return remote;
  }
}

function admissionPolicyHash(policyHash: string, mode: string) {
  return createHash('sha256').update(`${policyHash}:${mode}`).digest('hex');
}

function isCoordinatorPushAdmissionCurrent(
  admissionId: string,
  attemptId: string | undefined,
  paths: RuntimePaths,
) {
  if (!attemptId) return false;
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT admission.id
           FROM autopilot_admissions AS admission
           INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
           INNER JOIN autopilot_stage_attempts AS attempt ON attempt.id = admission.current_stage_attempt_id
           WHERE admission.id = ? AND admission.current_stage_attempt_id = ?
             AND admission.state = 'push-admitted' AND attempt.stage = 'push'
             AND attempt.status IN ('reserved', 'running')
             AND admission.stop_requested_at IS NULL AND owner.status = 'active';`,
        )
        .get(admissionId, attemptId),
    );
  } finally {
    database.close();
  }
}

function rearmAdmissionForFreshPushApproval(
  admissionId: string,
  attemptId: string | undefined,
  paths: RuntimePaths,
) {
  if (!attemptId) return false;
  const database = openDb(paths.neondeckDatabase);
  try {
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE;');
    try {
      const current = database
        .prepare(
          `SELECT version FROM autopilot_admissions
           WHERE id = ? AND state = 'push-admitted'
             AND current_stage_attempt_id = ?;`,
        )
        .get(admissionId, attemptId) as { version: number } | undefined;
      if (!current) {
        database.exec('COMMIT;');
        return false;
      }
      const cancelled = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'cancelled', error = 'push-approval-binding-changed',
               finished_at = ?
           WHERE id = ? AND admission_id = ? AND stage = 'push'
             AND status IN ('reserved', 'running');`,
        )
        .run(now, attemptId, admissionId);
      if (cancelled.changes !== 1) {
        database.exec('COMMIT;');
        return false;
      }
      database
        .prepare(
          `UPDATE prepared_diff_approvals
           SET status = 'superseded',
               reason = 'current SHA or policy binding changed before push',
               resolved_at = COALESCE(resolved_at, ?), updated_at = ?
           WHERE admission_id = ? AND approval_type = 'push'
             AND status IN ('pending', 'approved');`,
        )
        .run(now, now, admissionId);
      const rearmed = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'approval-pending', current_workflow = NULL,
               current_run_id = NULL, current_stage_attempt_id = NULL,
               next_attempt_at = NULL, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'push-admitted'
             AND current_stage_attempt_id = ?;`,
        )
        .run(now, admissionId, current.version, attemptId);
      if (rearmed.changes !== 1) {
        throw new Error('Push approval rearm lost its admission CAS.');
      }
      database.exec('COMMIT;');
      return true;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}

function readCoordinatorPushApprovalBinding(
  admissionId: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT owner.generation AS owner_generation,
                (
                  SELECT id FROM autopilot_stage_attempts
                  WHERE admission_id = admission.id
                    AND stage = 'verify' AND status = 'completed'
                  ORDER BY attempt_number DESC LIMIT 1
                ) AS verification_attempt_id
         FROM autopilot_admissions AS admission
         INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
         WHERE admission.id = ?;`,
      )
      .get(admissionId) as
      | { owner_generation: number; verification_attempt_id: string | null }
      | undefined;
  } finally {
    database.close();
  }
}

async function resolvePushApiLogin(dependencies: AutopilotDependencies) {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    return await (dependencies.fetchGitHubLogin ?? fetchGitHubLogin)(token);
  } catch {
    return null;
  }
}
