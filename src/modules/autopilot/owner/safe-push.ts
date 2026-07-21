import { addNotification } from '../../app-state';
import {
  fetchGitHubLogin,
  fetchPullRequestEventState,
  pullRequestEventStateTruncation,
} from '../../github';
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
import { readPendingAutopilotTurn } from './pending';

export async function safePushAutopilotOwner(
  binding: Pick<PrWatch, 'id' | 'repoId' | 'repoFullName' | 'prNumber'> & {
    worktreeId: string;
  },
  paths: RuntimePaths,
  dependencies: {
    token?: string;
    fetchFacts?: typeof fetchPullRequestEventState;
    fetchLogin?: typeof fetchGitHubLogin;
    resolvePushTarget?: typeof resolvePrPushTargetForCheckout;
    pushGit?: typeof gitPushHead;
  } = {},
) {
  try {
    requireAutonomousDeliveryTurn(binding.id, binding.worktreeId, paths);
    const worktree = await readManagedWorktree(
      binding.worktreeId,
      binding.repoId,
      paths,
    );
    const current = requireAutonomousDeliveryTurn(
      binding.id,
      binding.worktreeId,
      paths,
    );
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      return blockSafePush(
        current,
        worktree.id,
        'GITHUB_TOKEN is unavailable immediately before push.',
        ['GITHUB_TOKEN'],
        paths,
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
        { currentHeadSha: facts.headSha },
      );
    }
    if (facts.branchPermissions.canLikelyPush !== true) {
      return blockSafePush(
        current,
        worktree.id,
        'Current GitHub permission facts do not prove direct push access.',
        ['githubPermissions'],
        paths,
        { branchPermissions: facts.branchPermissions },
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
        { status },
      );
    }
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
    // Keep the final authority and checkout checks adjacent to the external
    // effect. Any mode/source/status or commit change during the preceding
    // awaits fails closed instead of using stale authority or remote facts.
    requireAutonomousDeliveryTurn(binding.id, binding.worktreeId, paths);
    const [immediateStatus, immediateSha] = await Promise.all([
      gitStatus(worktree.localPath),
      gitCurrentSha(worktree.localPath),
    ]);
    if (!immediateStatus.clean || immediateSha !== commitSha) {
      throw new Error(
        'The prepared checkout changed after verification and before push.',
      );
    }
    requireAutonomousDeliveryTurn(binding.id, binding.worktreeId, paths);
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
        message: `Autopilot pushed ${commitSha} to ${target.branch}.`,
        data: { remote: target.remote },
      },
      paths,
    );
    return {
      ok: true,
      action: 'autopilot_owner_safe_push',
      changed: true,
      message: `Pushed ${commitSha} to the current linked PR head after mechanical delivery guards passed.`,
      commitSha,
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

function requireAutonomousDeliveryTurn(
  id: string,
  worktreeId: string,
  paths: RuntimePaths,
) {
  const watch = readWatch(paths, id);
  const pending = watch?.ownerInstanceId
    ? readPendingAutopilotTurn(paths.home, watch.ownerInstanceId)
    : undefined;
  if (
    !watch ||
    watch.worktreeId !== worktreeId ||
    watch.autopilotMode !== 'autofix-push-when-safe' ||
    watch.autopilotStatus !== 'working' ||
    pending?.source !== 'watch-event' ||
    pending.mode !== 'autofix-push-when-safe'
  ) {
    throw new Error(
      'The watch is no longer a current autonomous watcher delivery turn.',
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
