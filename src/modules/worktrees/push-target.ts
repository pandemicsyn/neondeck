import type { WorktreeRecord } from './schemas';

export function remoteForPush(
  worktree: WorktreeRecord,
  branchPermissions: unknown,
) {
  const headRepoFullName = stringField(branchPermissions, 'headRepoFullName');
  const worktreeHeadFullName =
    worktree.headOwner && worktree.headName
      ? `${worktree.headOwner}/${worktree.headName}`
      : undefined;
  return githubRemoteUrl(
    headRepoFullName ?? worktreeHeadFullName ?? worktree.repoFullName,
  );
}

export function githubRemoteUrl(fullName: string) {
  const [owner, repo, extra] = fullName.split('/');
  if (
    extra !== undefined ||
    !owner ||
    !repo ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  return `https://github.com/${fullName}.git`;
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}
