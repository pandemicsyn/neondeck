import type { GitHubPullRequestEventState } from '../github';
import type { RepoConfig, RuntimePaths } from '../../runtime-home';
import { createWorktree } from './service';
import { readManagedWorktree } from './access';
import { listWorktrees } from './queries';
import type { WorktreeRecord } from './schemas';

export async function ensurePrWorktree(
  input: {
    repo: RepoConfig;
    prNumber: number;
    eventState: GitHubPullRequestEventState;
    worktreeId?: string;
    createdBy?: 'neondeck' | 'user' | 'external';
  },
  paths: RuntimePaths,
): Promise<WorktreeRecord> {
  if (input.worktreeId) {
    const worktree = await readManagedWorktree(
      input.worktreeId,
      input.repo.id,
      paths,
    );
    assertPr(worktree, input.prNumber);
    return worktree;
  }

  const snapshot = await listWorktrees(paths);
  const existing = snapshot.worktrees.find(
    (worktree) =>
      worktree.repoId === input.repo.id &&
      worktree.prNumber === input.prNumber &&
      worktree.lifecycleStatus !== 'deleted',
  );
  if (existing) {
    return readManagedWorktree(existing.id, input.repo.id, paths);
  }

  const created = await createWorktree(
    {
      repoId: input.repo.id,
      prNumber: input.prNumber,
      baseRef: input.eventState.headSha,
      headRef: input.eventState.headRef ?? input.eventState.headSha,
      headSha: input.eventState.headSha,
      directPushAllowed: input.eventState.maintainerCanModify,
      createdBy: input.createdBy ?? 'neondeck',
    },
    paths,
  );
  if (!created.ok || !('worktree' in created) || !created.worktree) {
    throw new Error(created.message);
  }
  return created.worktree;
}

function assertPr(worktree: WorktreeRecord, prNumber: number) {
  if (worktree.prNumber !== prNumber) {
    throw new Error(
      `Worktree "${worktree.id}" belongs to PR ${worktree.prNumber ?? 'none'}, not PR ${prNumber}.`,
    );
  }
}
