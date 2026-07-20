import { addNotification } from '../../app-state';
import {
  fetchGitHubLogin,
  fetchPullRequestEventState,
  pullRequestEventStateTruncation,
} from '../../github';
import { checkAutopilotPolicy } from '../../autopilot-policy';
import { runApprovedExecution } from '../../execution';
import {
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  resolvePrPushTargetForCheckout,
} from '../../worktrees';
import {
  readWatch,
  transitionWatchAutopilot,
  type PrWatch,
} from '../../watches';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitPushHead, gitStatus } from '../../../repo-edit/git';
import { configuredAutopilotChecks } from './checks';

export async function safePushAutopilotOwner(
  binding: Pick<PrWatch, 'id' | 'repoId' | 'repoFullName' | 'prNumber'> & {
    worktreeId: string;
  },
  paths: RuntimePaths,
  dependencies: {
    token?: string;
    configuredChecks?: typeof configuredAutopilotChecks;
    runExecution?: typeof runApprovedExecution;
    fetchFacts?: typeof fetchPullRequestEventState;
    fetchLogin?: typeof fetchGitHubLogin;
    checkPolicy?: typeof checkAutopilotPolicy;
    resolvePushTarget?: typeof resolvePrPushTargetForCheckout;
    pushGit?: typeof gitPushHead;
  } = {},
) {
  try {
    const initial = requireSafeWorkingWatch(binding.id, paths);
    const worktree = await readManagedWorktree(
      binding.worktreeId,
      binding.repoId,
      paths,
    );
    const configured = await (
      dependencies.configuredChecks ?? configuredAutopilotChecks
    )(initial, paths);
    if (configured.checks.length === 0) {
      return blockSafePush(
        initial,
        worktree.id,
        'Automatic push requires at least one configured targeted check.',
        ['configuredChecks'],
        paths,
      );
    }

    const checkResults = [];
    for (const command of configured.checks) {
      const result = await (dependencies.runExecution ?? runApprovedExecution)(
        {
          command,
          cwd: worktree.localPath,
          context: 'unattended',
          requestContext: {
            source: 'autopilot',
            watchId: initial.id,
            repoId: initial.repoId,
            repoFullName: initial.repoFullName,
            prNumber: initial.prNumber,
            worktreeId: worktree.id,
            operation: 'safe-push-check',
          },
        },
        paths,
      );
      checkResults.push({ command, result });
      if (!result.ok) {
        return blockSafePush(
          initial,
          worktree.id,
          `Targeted check failed or could not run: ${command}.`,
          ['passingChecks'],
          paths,
          { checkResults },
        );
      }
    }

    const current = requireSafeWorkingWatch(binding.id, paths);
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      return blockSafePush(
        current,
        worktree.id,
        'GITHUB_TOKEN is unavailable immediately before push.',
        ['GITHUB_TOKEN'],
        paths,
        { checkResults },
      );
    }
    const facts = await (dependencies.fetchFacts ?? fetchPullRequestEventState)(
      {
        token,
        owner: current.githubOwner,
        repo: current.githubName,
        number: current.prNumber,
      },
    );
    const truncation = pullRequestEventStateTruncation(facts);
    if (truncation.any || facts.headSha !== worktree.headSha) {
      return blockSafePush(
        current,
        worktree.id,
        truncation.any
          ? 'Current GitHub facts are incomplete immediately before push.'
          : 'The remote PR head changed before push.',
        truncation.any ? ['completePrEventFacts'] : ['currentPrHead'],
        paths,
        { checkResults, currentHeadSha: facts.headSha },
      );
    }
    if (facts.branchPermissions.canLikelyPush !== true) {
      return blockSafePush(
        current,
        worktree.id,
        'Current GitHub permission facts do not prove direct push access.',
        ['githubPermissions'],
        paths,
        { checkResults, branchPermissions: facts.branchPermissions },
      );
    }

    const status = await gitStatus(worktree.localPath);
    const commitSha = await gitCurrentSha(worktree.localPath);
    if (!status.clean || commitSha === worktree.headSha) {
      return blockSafePush(
        current,
        worktree.id,
        status.clean
          ? 'No committed change is available to push.'
          : 'The worktree has uncommitted changes immediately before push.',
        [status.clean ? 'committedChange' : 'cleanWorktree'],
        paths,
        { checkResults, status },
      );
    }
    const policy = await (dependencies.checkPolicy ?? checkAutopilotPolicy)(
      {
        repoId: current.repoId,
        worktreeId: worktree.id,
        diffBaseRef: worktree.headSha ?? undefined,
        pushDestination: 'pull-request-head',
        forcePush: false,
      },
      paths,
    );
    if (policy.blocked || policy.approvalRequired) {
      return blockSafePush(
        current,
        worktree.id,
        'Current Autopilot policy does not allow an unattended push.',
        policy.requires.length > 0 ? policy.requires : ['autopilotPolicy'],
        paths,
        { checkResults, policy },
      );
    }

    // This is the immediate authority re-read. A mode decrease during checks
    // fails before the external effect.
    requireSafeWorkingWatch(binding.id, paths);
    const apiLogin = await (dependencies.fetchLogin ?? fetchGitHubLogin)(token);
    const target = await (
      dependencies.resolvePushTarget ?? resolvePrPushTargetForCheckout
    )({
      sourceRepoPath: worktree.localPath,
      baseRepoFullName: worktree.repoFullName,
      headRepoFullName:
        facts.headRepoFullName ??
        (worktree.headOwner && worktree.headName
          ? `${worktree.headOwner}/${worktree.headName}`
          : worktree.repoFullName),
      headRef: facts.headRef ?? worktree.headRef,
      branchPermissions: facts.branchPermissions,
    });
    const push = await (dependencies.pushGit ?? gitPushHead)(
      worktree.localPath,
      {
        remote: target.remote,
        branch: target.branch,
        sha: commitSha,
        force: false,
        expectedAccess: { apiLogin, requireBoundIdentity: true },
        expectedRemoteSha: facts.headSha,
      },
    );
    await recordWorktreePushSucceeded(
      worktree.id,
      {
        commitSha,
        message: `Autopilot safely pushed ${commitSha} to ${target.branch}.`,
        data: { checks: configured.checks, remote: target.remote },
      },
      paths,
    );
    return {
      ok: true,
      action: 'autopilot_owner_safe_push',
      changed: true,
      message: `Pushed ${commitSha} after ${configured.checks.length} targeted check${configured.checks.length === 1 ? '' : 's'} passed.`,
      commitSha,
      checks: configured.checks,
      push,
    };
  } catch (error) {
    const watch = readWatch(paths, binding.id);
    if (!watch) throw error;
    return blockSafePush(
      watch,
      binding.worktreeId,
      `Automatic push is uncertain and requires human inspection: ${errorMessage(error)}`,
      ['humanInspection'],
      paths,
    );
  }
}

function requireSafeWorkingWatch(id: string, paths: RuntimePaths) {
  const watch = readWatch(paths, id);
  if (
    !watch ||
    watch.autopilotMode !== 'autofix-push-when-safe' ||
    watch.autopilotStatus !== 'working'
  ) {
    throw new Error(
      'The watch is no longer a working autofix-push-when-safe turn.',
    );
  }
  return watch;
}

async function blockSafePush(
  watch: PrWatch,
  worktreeId: string,
  message: string,
  requires: string[],
  paths: RuntimePaths,
  data?: unknown,
) {
  transitionWatchAutopilot(paths, watch.id, {
    from: ['working', 'watching'],
    to: 'blocked',
  });
  await recordWorktreePushBlocked(
    worktreeId,
    { message, data: { requires, details: data ?? null } },
    paths,
  ).catch(() => undefined);
  await addNotification(
    {
      level: 'attention',
      title: 'Autopilot prepared a change but did not push',
      message,
      source: 'autopilot-owner',
      sourceId: `${watch.id}:safe-push-blocked`,
      data: { watchId: watch.id, worktreeId, requires, details: data ?? null },
    },
    paths,
  );
  return {
    ok: false,
    action: 'autopilot_owner_safe_push',
    changed: true,
    message,
    requires,
    errors: [message],
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
