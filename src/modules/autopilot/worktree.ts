import * as v from 'valibot';
import { checkAutopilotConcurrency } from '../autopilot-policy';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  createWorktree,
  fetchExactPullRequestHead,
  lockWorktree,
  readManagedWorktree,
  recordWorktreeEvent,
  readWorktreeLock,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
} from '../worktrees';
import {
  AutopilotActionResult,
  AutopilotDependencies,
  prFactsSchema,
  preparePrWorktreeInputSchema,
} from './schemas';
import {
  asJsonValue,
  failResult,
  lowerLevelFailure,
  parseInput,
  objectField,
  stringField,
  errorMessage,
} from './utils';
import { dependenciesWithAutopilotFixture } from './fixtures';
import { fetchPreparedPrFacts, fetchPreparedCheckFacts } from './github-facts';

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
        `autopilot:${input.eventId ?? input.prNumber}`;
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

        if (input.worktreeId) {
          const existing = await readManagedWorktree(
            input.worktreeId,
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
