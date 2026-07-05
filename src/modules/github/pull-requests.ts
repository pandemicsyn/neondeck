import * as v from 'valibot';
import { encodePathSegment, githubFetch, nextLink } from './client';
import { fetchCheckRunDetails, fetchCheckSuites } from './checks';
import { fetchPullRequestReviewThreads } from './comments';
import {
  fetchPullRequestReviews,
  requestedChangesStateFromReviews,
} from './reviews';
import {
  githubPullRequestApiResponseSchema,
  githubPullRequestCommitApiItemSchema,
  githubPullRequestFileApiItemSchema,
  githubRepositoryApiResponseSchema,
} from './schemas';
import type {
  GitHubBranchPushPermissions,
  GitHubDiffSummary,
  GitHubPullRequestCommit,
  GitHubPullRequestCommitApiItem,
  GitHubPullRequestDetail,
  GitHubPullRequestEventState,
  GitHubPullRequestFile,
  GitHubPullRequestFileApiItem,
  GitHubPullRequestFiles,
} from './schemas';

export async function fetchPullRequestDetail(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestDetail> {
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}`,
  );
  const data = v.parse(
    githubPullRequestApiResponseSchema,
    await response.json(),
  );

  return {
    number: data.number,
    title: data.title,
    repo: `${options.owner}/${options.repo}`,
    url: data.html_url,
    state: data.state,
    draft: data.draft ?? false,
    merged: data.merged,
    mergeCommitSha: data.merge_commit_sha,
    headSha: data.head.sha,
    headRef: data.head.ref ?? data.head.sha,
    headOwner: data.head.repo?.owner?.login ?? options.owner,
    headName: data.head.repo?.name ?? options.repo,
    headRepoFullName: data.head.repo?.full_name ?? null,
    baseRef: data.base.ref,
    baseSha: data.base.sha ?? null,
    baseRepoFullName: data.base.repo?.full_name ?? null,
    mergeable: data.mergeable ?? null,
    mergeableState: data.mergeable_state ?? null,
    maintainerCanModify: data.maintainer_can_modify ?? false,
    updatedAt: data.updated_at,
  };
}

export async function fetchPullRequestEventState(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestEventState> {
  const detail = await fetchPullRequestDetail(options);
  const [
    commits,
    reviews,
    reviewThreads,
    checkSuites,
    checkRuns,
    branchPermissions,
  ] = await Promise.all([
    fetchPullRequestCommits(options),
    fetchPullRequestReviews(options),
    fetchPullRequestReviewThreads(options),
    fetchCheckSuites({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      ref: detail.headSha,
    }),
    fetchCheckRunDetails({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      ref: detail.headSha,
    }),
    fetchBranchPushPermissions({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      detail,
    }),
  ]);
  const requestedChangesState = requestedChangesStateFromReviews(reviews);

  return {
    repo: detail.repo,
    number: detail.number,
    url: detail.url,
    title: detail.title,
    state: detail.state,
    draft: detail.draft ?? false,
    merged: detail.merged,
    mergeCommitSha: detail.mergeCommitSha,
    headSha: detail.headSha,
    headRef: detail.headRef ?? null,
    baseRef: detail.baseRef,
    baseSha: detail.baseSha ?? null,
    mergeable: detail.mergeable ?? null,
    mergeableState: detail.mergeableState ?? null,
    maintainerCanModify: detail.maintainerCanModify ?? false,
    commits,
    reviewThreads,
    requestedChangesReviews: requestedChangesState.active,
    requestedChangesState,
    checkSuites,
    checkRuns,
    branchPermissions,
    isOutOfDate: isOutOfDateMergeState(detail.mergeableState),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchPullRequestCommits(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestCommit[]> {
  const commits: GitHubPullRequestCommitApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/commits?per_page=100`;

  while (nextUrl) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestCommitApiItemSchema),
      await response.json(),
    );
    commits.push(...data);
    nextUrl = nextLink(response.headers.get('link'));
  }

  return commits.map((commit) => ({
    sha: commit.sha,
    url: commit.html_url,
    authorLogin: commit.author?.login ?? null,
    committedAt:
      commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
  }));
}

export async function fetchPullRequestFiles(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestFiles> {
  const files: GitHubPullRequestFile[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/files?per_page=100`;

  while (nextUrl) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestFileApiItemSchema),
      await response.json(),
    );
    files.push(...data.map(normalizePullRequestFile));
    nextUrl = nextLink(response.headers.get('link'));
  }

  return {
    repo: `${options.owner}/${options.repo}`,
    number: options.number,
    files,
    diffSummary: summarizePullRequestFiles(files),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchBranchPushPermissions(options: {
  token: string;
  owner: string;
  repo: string;
  detail: GitHubPullRequestDetail;
}): Promise<GitHubBranchPushPermissions> {
  const headRepoFullName = options.detail.headRepoFullName ?? null;
  const baseRepoFullName =
    options.detail.baseRepoFullName ?? `${options.owner}/${options.repo}`;
  const isFork =
    headRepoFullName !== null &&
    headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase();
  const [headRepo, baseRepo] = await Promise.all([
    headRepoFullName
      ? fetchRepositoryPermissions(options.token, headRepoFullName).catch(
          () => null,
        )
      : Promise.resolve(null),
    fetchRepositoryPermissions(options.token, baseRepoFullName).catch(
      () => null,
    ),
  ]);
  const headRepoPush = headRepo?.permissions?.push ?? null;
  const baseRepoPush = baseRepo?.permissions?.push ?? null;
  const maintainerCanModify = options.detail.maintainerCanModify ?? false;
  const canLikelyPush =
    headRepoPush === true ||
    (isFork && maintainerCanModify && baseRepoPush === true)
      ? true
      : headRepoPush === false || baseRepoPush === false
        ? false
        : null;

  return {
    headRepoFullName,
    baseRepoFullName,
    isFork,
    maintainerCanModify,
    headRepoPush,
    baseRepoPush,
    canLikelyPush,
    checkedAt: new Date().toISOString(),
  };
}

async function fetchRepositoryPermissions(token: string, fullName: string) {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  const response = await githubFetch(
    token,
    `https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`,
  );
  return v.parse(githubRepositoryApiResponseSchema, await response.json());
}

function isOutOfDateMergeState(value: string | null | undefined) {
  return value === 'behind' || value === 'dirty' || value === 'blocked';
}

function normalizePullRequestFile(
  file: GitHubPullRequestFileApiItem,
): GitHubPullRequestFile {
  const patch = file.patch ? unifiedPatchFromGitHubFile(file) : null;
  const binary = patch === null && isLikelyBinaryPullRequestFile(file);
  const truncated = patch === null && !binary;
  return {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    binary,
    generatedLike: false,
    patch,
    truncated,
    sha: file.sha ?? null,
    htmlUrl: file.blob_url ?? null,
    rawUrl: file.raw_url ?? null,
    contentsUrl: file.contents_url ?? null,
    message: patch === null ? missingPatchMessage(binary) : null,
  };
}

function isLikelyBinaryPullRequestFile(file: GitHubPullRequestFileApiItem) {
  return file.additions === 0 && file.deletions === 0 && file.changes === 0;
}

function missingPatchMessage(binary: boolean) {
  return binary
    ? 'GitHub did not include a patch for this binary file.'
    : 'GitHub omitted the text patch for this file, likely because the diff is too large.';
}

function unifiedPatchFromGitHubFile(file: GitHubPullRequestFileApiItem) {
  const previousPath = file.previous_filename ?? file.filename;
  const currentPath = file.filename;
  const deleted = isDeletedFileStatus(file.status);
  const added = isAddedFileStatus(file.status);
  const header = [`diff --git a/${previousPath} b/${currentPath}`];

  if (added) {
    header.push('new file mode 100644');
  } else if (deleted) {
    header.push('deleted file mode 100644');
  } else if (
    file.previous_filename &&
    file.previous_filename !== file.filename
  ) {
    header.push(`rename from ${file.previous_filename}`);
    header.push(`rename to ${file.filename}`);
  }

  header.push(added ? '--- /dev/null' : `--- a/${previousPath}`);
  header.push(deleted ? '+++ /dev/null' : `+++ b/${currentPath}`);
  header.push(file.patch?.trimEnd() ?? '');

  return `${header.join('\n')}\n`;
}

function isAddedFileStatus(status: string) {
  return status === 'added' || status === 'new';
}

function isDeletedFileStatus(status: string) {
  return status === 'removed' || status === 'deleted';
}

function summarizePullRequestFiles(
  files: GitHubPullRequestFile[],
): GitHubDiffSummary {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    binaryFiles: files.filter((file) => file.binary).length,
  };
}
