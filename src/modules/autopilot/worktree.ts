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
  repoGuardrails,
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
  fetchExactPullRequestHead,
  assertWorktreeMutationAllowed,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  recordWorktreeEvent,
  readWorktreeLock,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
  type WorktreeRecord,
} from '../worktrees';
import { bindAutopilotOwnerWorktree, readAutopilotPrOwnerById } from './owners';
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

export async function preparePrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    preparePrWorktreeInputSchema,
    rawInput,
    'autopilot_prepare_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);

  try {
    await ensureRuntimeHome(paths);
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find((item) => item.id === input.repoId);
    if (!repo) {
      return failResult(
        'autopilot_prepare_pr_worktree',
        `Repository "${input.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const pr = await fetchPreparedPrFacts(
      repo.github.owner,
      repo.github.name,
      input.prNumber,
      dependencies,
    );
    if ('ok' in pr && !pr.ok) return pr;

    const prFacts = pr as v.InferOutput<typeof prFactsSchema>;
    const checks = await fetchPreparedCheckFacts(
      repo.github.owner,
      repo.github.name,
      prFacts.headSha,
      dependencies,
    );
    if ('ok' in checks && !checks.ok) return checks;

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: input.prNumber,
        workflow: 'prepare_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_prepare_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    let worktree: unknown = null;
    let lock: unknown = null;
    let status: unknown = null;
    let exactHeadFetch: unknown = null;
    const createEnabled = input.createWorktree ?? true;

    if (createEnabled) {
      const suppliedMutationLock = input.lockId
        ? readWorktreeLock(input.lockId, paths)
        : null;
      if (
        suppliedMutationLock &&
        (suppliedMutationLock.releasedAt ||
          suppliedMutationLock.revokedAt ||
          Date.parse(suppliedMutationLock.expiresAt) <= Date.now() ||
          suppliedMutationLock.repoId !== repo.id ||
          suppliedMutationLock.prNumber !== input.prNumber)
      ) {
        return failResult(
          'autopilot_prepare_pr_worktree',
          'The supplied PR mutation lock is inactive or belongs to a different target.',
          { requires: ['lockId'] },
        );
      }
      const mutationOwner =
        suppliedMutationLock?.owner ??
        input.lockOwner ??
        `autopilot-owner:${input.ownerId ?? input.eventId ?? input.prNumber}`;
      const locked = suppliedMutationLock
        ? { ok: true as const, lock: suppliedMutationLock }
        : await lockWorktree(
            {
              repoId: repo.id,
              prNumber: input.prNumber,
              scope: 'pr',
              owner: mutationOwner,
              ttlSeconds: input.lockTtlSeconds ?? 1_800,
            },
            paths,
          );
      if (!locked.ok) {
        return lowerLevelFailure(
          'autopilot_prepare_pr_worktree',
          'worktree_lock',
          locked,
        );
      }
      const mutationLock = objectField(locked, 'lock');
      const mutationLockId = stringField(mutationLock, 'id');
      if (!mutationLockId) {
        return failResult(
          'autopilot_prepare_pr_worktree',
          'PR-owner mutation lock did not return an id.',
        );
      }

      try {
        const owner = input.ownerId
          ? await readAutopilotPrOwnerById(input.ownerId, paths)
          : null;
        if (input.ownerId && !owner) {
          return failResult(
            'autopilot_prepare_pr_worktree',
            `Autopilot owner "${input.ownerId}" was not found.`,
            { requires: ['ownerId'] },
          );
        }
        if (
          owner &&
          (owner.repoId !== repo.id || owner.prNumber !== input.prNumber)
        ) {
          return failResult(
            'autopilot_prepare_pr_worktree',
            'Autopilot owner is bound to a different repository or pull request.',
            { requires: ['ownerId'] },
          );
        }

        const fetcher =
          dependencies.fetchExactPullRequestHead ?? fetchExactPullRequestHead;
        try {
          exactHeadFetch = await fetcher({
            sourceRepoPath: repo.path,
            baseRepoFullName: prFacts.baseRepoFullName ?? repoFullName(repo),
            headRepoFullName:
              prFacts.headRepoFullName ??
              `${prFacts.headOwner ?? repo.github.owner}/${prFacts.headName ?? repo.github.name}`,
            prNumber: input.prNumber,
            headRef: prFacts.headRef ?? prFacts.headSha,
            headSha: prFacts.headSha,
          });
        } catch (error) {
          return failResult(
            'autopilot_prepare_pr_worktree',
            'Could not fetch and verify the exact pull request head.',
            { requires: ['exactPrHead'], errors: [errorMessage(error)] },
          );
        }

        const ownerWorktreeId = owner?.worktreeId ?? input.worktreeId;
        if (ownerWorktreeId) {
          const existing = await readManagedWorktree(
            ownerWorktreeId,
            repo.id,
            paths,
          );
          if (existing.prNumber !== input.prNumber) {
            return failResult(
              'autopilot_prepare_pr_worktree',
              `Worktree "${existing.id}" belongs to a different pull request.`,
              { requires: ['worktreeId'] },
            );
          }
          const synced = await syncWorktree(
            {
              worktreeId: existing.id,
              headRef: prFacts.headRef ?? prFacts.headSha,
              headSha: prFacts.headSha,
              fetch: false,
              lockId: mutationLockId,
            },
            paths,
          );
          if (!synced.ok) {
            return lowerLevelFailure(
              'autopilot_prepare_pr_worktree',
              'worktree_sync',
              synced,
            );
          }
          worktree = objectField(synced, 'worktree') ?? existing;
        } else {
          const created = await createWorktree(
            {
              repoId: repo.id,
              prNumber: input.prNumber,
              baseRef: prFacts.baseRef || repo.defaultBranch,
              headOwner: prFacts.headOwner,
              headName: prFacts.headName,
              headRef: prFacts.headRef ?? prFacts.headSha,
              headSha: prFacts.headSha,
              directPushAllowed: Boolean(prFacts.maintainerCanModify),
            },
            paths,
          );
          if (!created.ok) {
            return lowerLevelFailure(
              'autopilot_prepare_pr_worktree',
              'worktree_create',
              created,
            );
          }
          worktree = objectField(created, 'worktree');
          const createdWorktreeId = stringField(worktree, 'id');
          if (!createdWorktreeId) {
            return failResult(
              'autopilot_prepare_pr_worktree',
              'Worktree creation or reuse did not return a worktree id.',
              { errors: ['Missing worktree id.'] },
            );
          }
          const synced = await syncWorktree(
            {
              worktreeId: createdWorktreeId,
              headRef: prFacts.headRef ?? prFacts.headSha,
              headSha: prFacts.headSha,
              fetch: false,
              lockId: mutationLockId,
            },
            paths,
          );
          if (!synced.ok) {
            return lowerLevelFailure(
              'autopilot_prepare_pr_worktree',
              'worktree_sync',
              synced,
            );
          }
          worktree = objectField(synced, 'worktree') ?? worktree;
        }

        const worktreeId = stringField(worktree, 'id');
        if (!worktreeId) {
          return failResult(
            'autopilot_prepare_pr_worktree',
            'Worktree preparation did not return a worktree id.',
            { errors: ['Missing worktree id.'] },
          );
        }
        status = await readWorktreeStatus({ worktreeId }, paths);
        const checkedOutSha = stringField(
          objectField(status, 'git'),
          'headSha',
        );
        if (checkedOutSha !== prFacts.headSha) {
          return failResult(
            'autopilot_prepare_pr_worktree',
            `Prepared worktree HEAD ${checkedOutSha ?? 'unknown'} does not match GitHub head ${prFacts.headSha}.`,
            { requires: ['exactPrHead'] },
          );
        }
        if (owner) {
          await bindAutopilotOwnerWorktree(
            { ownerId: owner.id, worktreeId, headSha: checkedOutSha },
            paths,
          );
        }
        await recordWorktreeEvent(
          worktreeId,
          repo.id,
          'pr_head_verified',
          'ready',
          `Verified exact PR head ${prFacts.headSha.slice(0, 12)} before checkout.`,
          exactHeadFetch,
          paths,
        );
      } finally {
        if (!suppliedMutationLock) {
          await releaseWorktreeLock(
            {
              lockId: mutationLockId,
              owner: mutationOwner,
              finalStatus: 'ready',
            },
            paths,
          ).catch(() => undefined);
        }
      }

      if (input.lock === true) {
        const worktreeId = stringField(worktree, 'id');
        if (worktreeId) {
          const retainedLock = await lockWorktree(
            {
              worktreeId,
              scope: 'pr',
              owner: input.lockOwner ?? 'prepare_pr_worktree',
              ttlSeconds: input.lockTtlSeconds ?? 1_800,
            },
            paths,
          );
          if (!retainedLock.ok) {
            return lowerLevelFailure(
              'autopilot_prepare_pr_worktree',
              'worktree_lock',
              retainedLock,
            );
          }
          lock = objectField(retainedLock, 'lock');
        }
      }
    }

    return {
      ok: true,
      action: 'autopilot_prepare_pr_worktree',
      changed: Boolean(worktree),
      message: worktree
        ? `Prepared PR worktree for ${repoFullName(repo)}#${input.prNumber}.`
        : `Gathered PR facts for ${repoFullName(repo)}#${input.prNumber}.`,
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        pr: prFacts,
        checks,
        concurrency,
        worktree,
        lock,
        status,
        exactHeadFetch,
        eventId: input.eventId ?? null,
        runLinkage: {
          owningWorkflowRunIdAttached: false,
          reason:
            'Flue ActionContext does not expose workflow identity; caller-supplied run ids are not accepted.',
        },
      }),
    };
  } catch (error) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'Could not prepare PR worktree.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function verifyPrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    verifyPrWorktreeInputSchema,
    rawInput,
    'autopilot_verify_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'verify_pr_worktree';
  let finalLockStatus: 'ready' | 'prepared-diff' = 'ready';

  try {
    await ensureRuntimeHome(paths);
    const [registry, appConfig, worktreeSnapshot] = await Promise.all([
      readRepoRegistrySnapshot(paths),
      readRuntimeJson(paths.config, parseAppConfig),
      listWorktrees(paths),
    ]);
    const worktree = worktreeSnapshot.worktrees.find(
      (candidate) => candidate.id === input.worktreeId,
    );
    if (!worktree || worktree.lifecycleStatus === 'deleted') {
      return failResult(
        'autopilot_verify_pr_worktree',
        `Worktree "${input.worktreeId}" was not found.`,
        { requires: ['worktreeId'] },
      );
    }
    finalLockStatus =
      worktree.lifecycleStatus === 'prepared-diff' ? 'prepared-diff' : 'ready';
    const repo = registry.repos.find(
      (candidate) => candidate.id === worktree.repoId,
    );
    if (!repo) {
      return failResult(
        'autopilot_verify_pr_worktree',
        `Repository "${worktree.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: worktree.prNumber,
        workflow: 'verify_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    const lockEnabled = input.lock ?? true;
    if (lockEnabled) {
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
        return lowerLevelFailure(
          'autopilot_verify_pr_worktree',
          'worktree_lock',
          locked,
        );
      }
      acquiredLockId = stringField(objectField(locked, 'lock'), 'id');
    }

    const policy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: input.diffBaseRef,
        pushDestination: 'pull-request-head',
      },
      paths,
    );
    if (!policy.ok || policy.blocked) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: policy.message,
        data: asJsonValue({ policy, concurrency }),
        errors: policy.reasons,
        requires: policy.requires,
      };
    }
    if (policy.diff.filesChanged > 0) {
      finalLockStatus = 'prepared-diff';
    }

    const checks = resolveVerificationChecks(
      input.checks,
      repo,
      repoGuardrails(repo, appConfig).requiredChecks,
    );
    if (checks.length === 0) {
      return failResult(
        'autopilot_verify_pr_worktree',
        'No repo checks are configured for this worktree.',
        {
          requires: ['guardrails.requiredChecks', 'repo.packageScripts'],
        },
      );
    }

    const runExecution = dependencies.runExecution ?? runApprovedExecution;
    const assertLease = () =>
      assertWorktreeMutationAllowed(
        {
          repoId: repo.id,
          worktreeId: worktree.id,
          lockId: acquiredLockId,
        },
        paths,
      );
    const results = [];
    for (const command of checks) {
      assertLease();
      const slot = await withAutopilotLocalExecutionSlot(
        policy.concurrency,
        () =>
          runExecution(
            {
              command,
              backend: input.backend,
              cwd: worktree.localPath,
              context: input.context ?? 'unattended',
              timeoutMs: input.timeoutMs,
              maxOutputBytes: input.maxOutputBytes,
              requestContext: {
                source: 'autopilot',
                workflow: 'verify_pr_worktree',
                repoId: repo.id,
                repoFullName: repoFullName(repo),
                prNumber: worktree.prNumber,
                worktreeId: worktree.id,
              },
            },
            paths,
          ),
      );
      assertLease();
      if ('blocked' in slot) {
        results.push({
          command,
          ok: false,
          message: slot.message,
          requires: ['localExecutionLimit'],
        });
        break;
      }
      results.push({
        command,
        ok: Boolean(slot.ok),
        message: stringField(slot, 'message') ?? 'Execution completed.',
        requires: arrayField(slot, 'requires'),
        approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
        exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
      });
      if (!slot.ok) break;
    }

    const passed =
      results.length === checks.length && results.every((item) => item.ok);
    const blocked = results.some((item) => item.requires.length > 0);
    assertLease();
    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    assertLease();
    const preparedDiffVerification = await recordPreparedDiffVerification(
      {
        worktreeId: worktree.id,
        lockId: acquiredLockId,
        status: passed ? 'passed' : 'failed',
        summary: {
          checks,
          results,
          blocked,
        },
      },
      paths,
    );
    if (preparedDiffVerification) {
      await notifyAutopilotState(
        {
          state: 'verify',
          outcome: passed ? 'passed' : blocked ? 'blocked' : 'failed',
          preparedDiffId: preparedDiffVerification.id,
          worktreeId: worktree.id,
          repoFullName: repoFullName(repo),
          prNumber: worktree.prNumber,
          workflow: 'verify_pr_worktree',
          message: passed
            ? `Verified ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} with ${results.length} check(s).`
            : blocked
              ? 'Verification is blocked by execution approval or concurrency policy.'
              : 'One or more verification checks failed.',
          recoveryActions: recoveryActionsForPreparedDiff(
            preparedDiffVerification,
          ),
          data: { checks, results },
        },
        paths,
      );
    }

    return {
      ok: passed,
      action: 'autopilot_verify_pr_worktree',
      changed: true,
      message: passed
        ? `Verified ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} with ${results.length} check(s).`
        : blocked
          ? 'Verification is blocked by execution approval or concurrency policy.'
          : 'One or more verification checks failed.',
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        worktree,
        policy,
        concurrency,
        checks,
        results,
        status,
        preparedDiffVerification,
      }),
      ...(passed
        ? {}
        : {
            errors: results
              .filter((item) => !item.ok)
              .map((item) => item.message),
          }),
      ...(blocked ? { requires: ['approval'] } : {}),
    };
  } catch (error) {
    const preparedDiff = readPreparedDiffByWorktree(input.worktreeId, paths);
    if (preparedDiff) {
      await notifyAutopilotState(
        {
          state: 'failed-workflow',
          outcome: 'failed',
          preparedDiffId: preparedDiff.id,
          worktreeId: input.worktreeId,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          workflow: 'verify_pr_worktree',
          message: `verify_pr_worktree failed: ${errorMessage(error)}`,
          recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
          data: { error: errorMessage(error) },
        },
        paths,
      ).catch(() => undefined);
    }
    return failResult(
      'autopilot_verify_pr_worktree',
      'Could not verify PR worktree.',
      { errors: [errorMessage(error)] },
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
