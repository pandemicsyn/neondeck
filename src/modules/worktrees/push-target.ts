import type { WorktreeRecord } from './schemas';
import { deriveForkRemote, resolveRegisteredRepositoryRemote } from './pr-head';

export type PrPushTarget = {
  repoFullName: string;
  remote: string;
  branch: string;
  fork: boolean;
  maintainerCanModify: boolean;
  canLikelyPush: boolean | null;
};

export function resolvePrPushTarget(input: {
  baseRepoFullName: string;
  headRepoFullName: string;
  headRef: string;
  branchPermissions: unknown;
  remote?: string;
}): PrPushTarget {
  const permissionHead = stringField(
    input.branchPermissions,
    'headRepoFullName',
  );
  const permissionBase = stringField(
    input.branchPermissions,
    'baseRepoFullName',
  );
  const fork =
    input.headRepoFullName.toLowerCase() !==
    input.baseRepoFullName.toLowerCase();
  if (
    permissionHead &&
    permissionHead.toLowerCase() !== input.headRepoFullName.toLowerCase()
  ) {
    throw new Error(
      `GitHub permission facts target ${permissionHead}, but the PR head repository is ${input.headRepoFullName}. Refresh PR facts before push.`,
    );
  }
  if (
    permissionBase &&
    permissionBase.toLowerCase() !== input.baseRepoFullName.toLowerCase()
  ) {
    throw new Error(
      `GitHub permission facts use base ${permissionBase}, but the configured repository is ${input.baseRepoFullName}. Refresh PR facts before push.`,
    );
  }
  const permissionFork = booleanField(input.branchPermissions, 'isFork');
  if (permissionFork !== undefined && permissionFork !== fork) {
    throw new Error(
      'GitHub fork permission facts disagree with the PR push target. Refresh PR facts before push.',
    );
  }
  return {
    repoFullName: input.headRepoFullName,
    remote: input.remote ?? githubRemoteUrl(input.headRepoFullName),
    branch: safeBranch(input.headRef),
    fork,
    maintainerCanModify:
      booleanField(input.branchPermissions, 'maintainerCanModify') ?? false,
    canLikelyPush:
      booleanField(input.branchPermissions, 'canLikelyPush') ?? null,
  };
}

export async function resolvePrPushTargetForCheckout(
  input: {
    sourceRepoPath: string;
    baseRepoFullName: string;
    headRepoFullName: string;
    headRef: string;
    branchPermissions: unknown;
  },
  dependencies: {
    runGit?: (cwd: string, args: string[]) => Promise<string>;
  } = {},
) {
  const baseRemote = await resolveRegisteredRepositoryRemote(
    input.sourceRepoPath,
    input.baseRepoFullName,
    dependencies.runGit,
  );
  const fork =
    input.headRepoFullName.toLowerCase() !==
    input.baseRepoFullName.toLowerCase();
  const remote = fork
    ? deriveForkRemote(baseRemote.url, input.headRepoFullName)
    : credentialSafeRemote(baseRemote.url);
  return resolvePrPushTarget({ ...input, remote });
}

export function pushTargetForWorktree(
  worktree: WorktreeRecord,
  branchPermissions: unknown,
) {
  return resolvePrPushTarget({
    baseRepoFullName: worktree.repoFullName,
    headRepoFullName:
      stringField(branchPermissions, 'headRepoFullName') ??
      (worktree.headOwner && worktree.headName
        ? `${worktree.headOwner}/${worktree.headName}`
        : worktree.repoFullName),
    headRef: worktree.headRef,
    branchPermissions,
  });
}

export function remoteForPush(
  worktree: WorktreeRecord,
  branchPermissions: unknown,
) {
  return pushTargetForWorktree(worktree, branchPermissions).remote;
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

function booleanField(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'boolean' ? field : undefined;
}

function safeBranch(value: string) {
  if (
    !value ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('@{') ||
    /[ ~^:?*\\[\]]/.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`Invalid Git push branch: ${value}`);
  }
  return value;
}

function credentialSafeRemote(remote: string) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        'Git push remote must not embed credentials or secret-bearing query data. Configure a credential helper instead.',
      );
    }
  }
  return remote;
}
