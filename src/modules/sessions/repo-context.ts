import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { fetchPullRequestEventState } from '../github';
import {
  createWorktree,
  ensurePrWorktree,
  listWorktrees,
  readManagedWorktree,
  remoteForPush,
  type WorktreeRecord,
} from '../worktrees';
import { findChatSession } from './store';

export type InteractiveRepoContext = {
  repo: RepoConfig;
  prNumber: number | null;
  worktree: WorktreeRecord;
  pushRemote: string;
  pushBranch: string;
  linkedPrHead: boolean;
};

export async function resolveInteractiveRepoContext(
  input: {
    sessionId?: string;
    repoId?: string;
    prNumber?: number;
    worktreeId?: string;
  },
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    fetchPullRequestEventState?: typeof fetchPullRequestEventState;
    token?: string;
  } = {},
): Promise<InteractiveRepoContext | null> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  const session = input.sessionId
    ? findChatSession(database, input.sessionId)
    : undefined;
  database.close();

  const repoId = session?.linkedRepoId ?? input.repoId;
  if (!repoId) return null;
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const repo = registry.repos.find((candidate) => candidate.id === repoId);
  if (!repo) return null;

  const prNumber =
    input.prNumber ?? parseLinkedWatchPrNumber(session?.linkedWatchId) ?? null;
  if (prNumber !== null) {
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token)
      throw new Error('GITHUB_TOKEN is required to resolve a PR head.');
    const eventState = await (
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState
    )({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      number: prNumber,
    });
    const worktree = await ensurePrWorktree(
      {
        repo,
        prNumber,
        eventState,
        worktreeId: input.worktreeId,
        createdBy: 'user',
      },
      paths,
    );
    return {
      repo,
      prNumber,
      worktree,
      pushRemote: remoteForPush(worktree, eventState.branchPermissions),
      pushBranch: eventState.headRef ?? worktree.headRef,
      linkedPrHead: Boolean(eventState.headRef),
    };
  }

  const worktree = input.worktreeId
    ? await readManagedWorktree(input.worktreeId, repo.id, paths)
    : await ensureRepoWorktree(repo, paths);
  return {
    repo,
    prNumber: null,
    worktree,
    pushRemote: 'origin',
    pushBranch: worktree.headRef,
    linkedPrHead: false,
  };
}

export function parseLinkedWatchPrNumber(linkedWatchId?: string | null) {
  const match = linkedWatchId?.match(/#([1-9]\d*)$/);
  return match ? Number(match[1]) : null;
}

async function ensureRepoWorktree(repo: RepoConfig, paths: RuntimePaths) {
  const snapshot = await listWorktrees(paths);
  const existing = snapshot.worktrees.find(
    (worktree) =>
      worktree.repoId === repo.id &&
      worktree.prNumber === null &&
      worktree.lifecycleStatus !== 'deleted',
  );
  if (existing) return readManagedWorktree(existing.id, repo.id, paths);

  const created = await createWorktree(
    {
      repoId: repo.id,
      baseRef: repo.defaultBranch,
      headRef: repo.defaultBranch,
      createdBy: 'user',
    },
    paths,
  );
  if (!created.ok || !('worktree' in created) || !created.worktree) {
    throw new Error(created.message);
  }
  return created.worktree;
}
