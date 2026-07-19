import * as v from 'valibot';
import { encodePathSegment, githubFetch, nextLink } from './client';
import {
  fetchCheckRunDetailsWithMetadata,
  fetchCheckSuitesWithMetadata,
} from './checks';
import {
  fetchPullRequestReviewThreadsWithMetadata,
  listPullRequestCommentsWithMetadata,
} from './comments';
import {
  fetchPullRequestReviewsWithMetadata,
  requestedChangesStateFromReviews,
} from './reviews';
import {
  createPullRequestEventFetchBudget,
  type PullRequestEventFetchBudget,
} from './event-budget';
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
    id: data.id,
    number: data.number,
    title: data.title,
    body: data.body ?? null,
    repo: `${options.owner}/${options.repo}`,
    url: data.html_url,
    state: data.state,
    draft: data.draft ?? false,
    author: data.user?.login ?? 'unknown',
    labels: (data.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => Boolean(name)),
    comments: data.comments ?? 0,
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
    createdAt: data.created_at ?? data.updated_at,
    updatedAt: data.updated_at,
  };
}

export async function fetchPullRequestEventState(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestEventState> {
  const eventBudget = createPullRequestEventFetchBudget(
    defaultPullRequestEventStateBudget,
  );
  const detail = await fetchPullRequestDetail(options);
  const [
    commitDetails,
    reviewDetails,
    reviewThreadDetails,
    conversationCommentDetails,
    checkSuiteDetails,
    checkRunDetails,
    branchPermissions,
    behindBy,
  ] = await Promise.all([
    fetchPullRequestCommitsWithMetadata({ ...options, eventBudget }),
    fetchPullRequestReviewsWithMetadata({ ...options, eventBudget }),
    fetchPullRequestReviewThreadsWithMetadata({ ...options, eventBudget }),
    listPullRequestCommentsWithMetadata({ ...options, eventBudget }),
    fetchCheckSuitesWithMetadata({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      ref: detail.headSha,
      eventBudget,
    }),
    fetchCheckRunDetailsWithMetadata({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      ref: detail.headSha,
      eventBudget,
    }),
    fetchBranchPushPermissions({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      detail,
    }),
    fetchPullRequestBehindBy(options, detail).catch(() => null),
  ]);
  const requestedChangesState = requestedChangesStateFromReviews(
    reviewDetails.reviews,
  );

  const state: GitHubPullRequestEventState = {
    repo: detail.repo,
    number: detail.number,
    url: detail.url,
    title: detail.title,
    body: detail.body ?? null,
    state: detail.state,
    draft: detail.draft ?? false,
    merged: detail.merged,
    mergeCommitSha: detail.mergeCommitSha,
    headSha: detail.headSha,
    headRef: detail.headRef ?? null,
    headOwner: detail.headOwner ?? null,
    headName: detail.headName ?? null,
    headRepoFullName: detail.headRepoFullName ?? null,
    baseRef: detail.baseRef,
    baseSha: detail.baseSha ?? null,
    baseRepoFullName: detail.baseRepoFullName ?? null,
    mergeable: detail.mergeable ?? null,
    mergeableState: detail.mergeableState ?? null,
    maintainerCanModify: detail.maintainerCanModify ?? false,
    commits: commitDetails.commits,
    commitsTruncated: commitDetails.truncated,
    reviewThreads: reviewThreadDetails.reviewThreads,
    reviewThreadsTruncated:
      reviewThreadDetails.truncated ||
      reviewThreadDetails.reviewThreads.some(
        (thread) => thread.commentsTruncated,
      ),
    requestedChangesReviews: requestedChangesState.active,
    requestedChangesState,
    conversationComments: conversationCommentDetails.comments,
    conversationCommentsTruncated: conversationCommentDetails.truncated,
    reviewsTruncated: reviewDetails.truncated,
    checkSuites: checkSuiteDetails.checkSuites,
    checkSuitesTruncated: checkSuiteDetails.truncated,
    checkRuns: checkRunDetails.checkRuns,
    checkRunsTruncated: checkRunDetails.truncated,
    branchPermissions,
    isOutOfDate: isOutOfDateState(behindBy, detail.mergeableState),
    fetchedAt: new Date().toISOString(),
  };
  return enforcePullRequestEventStateBudget(state, {
    ...eventBudget.snapshot(),
  });
}

export const defaultPullRequestEventStateBudget = {
  maxItems: 1_000,
  maxBytes: 2 * 1024 * 1024,
  maxElapsedMs: 30_000,
} as const;

export function enforcePullRequestEventStateBudget(
  state: GitHubPullRequestEventState,
  options: {
    maxItems?: number;
    maxBytes?: number;
    maxElapsedMs?: number;
    elapsedMs?: number;
  } = {},
): GitHubPullRequestEventState {
  const limits = {
    maxItems: options.maxItems ?? defaultPullRequestEventStateBudget.maxItems,
    maxBytes: options.maxBytes ?? defaultPullRequestEventStateBudget.maxBytes,
    maxElapsedMs:
      options.maxElapsedMs ?? defaultPullRequestEventStateBudget.maxElapsedMs,
  };
  const elapsedMs = options.elapsedMs ?? 0;
  const timeExhausted = elapsedMs > limits.maxElapsedMs;
  let retainedItems = 0;
  let retainedBytes = 0;
  const exhaustedCategories = new Set<string>();

  type BudgetBucket = {
    category: string;
    source: unknown[];
    retained: unknown[];
    itemCost: (value: unknown) => number;
  };
  const buckets: BudgetBucket[] = [
    {
      category: 'commits',
      source: state.commits,
      retained: [],
      itemCost: () => 1,
    },
    {
      category: 'review_threads',
      source: state.reviewThreads,
      retained: [],
      itemCost: (value) =>
        1 +
        (Array.isArray(
          (value as GitHubPullRequestEventState['reviewThreads'][number])
            .comments,
        )
          ? (value as GitHubPullRequestEventState['reviewThreads'][number])
              .comments.length
          : 0),
    },
    {
      category: 'requested_changes_reviews',
      source: state.requestedChangesState.history,
      retained: [],
      itemCost: () => 1,
    },
    {
      category: 'conversation_comments',
      source: state.conversationComments ?? [],
      retained: [],
      itemCost: () => 1,
    },
    {
      category: 'check_suites',
      source: state.checkSuites,
      retained: [],
      itemCost: () => 1,
    },
    {
      category: 'check_runs',
      source: state.checkRuns,
      retained: [],
      itemCost: () => 1,
    },
  ];

  if (timeExhausted) {
    for (const bucket of buckets) exhaustedCategories.add(bucket.category);
  } else {
    const offsets = new Map(buckets.map((bucket) => [bucket.category, 0]));
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const bucket of buckets) {
        const offset = offsets.get(bucket.category) ?? 0;
        const item = bucket.source[offset];
        if (item === undefined) continue;
        remaining = true;
        offsets.set(bucket.category, offset + 1);
        const itemCost = bucket.itemCost(item);
        const byteCost = Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (
          retainedItems + itemCost > limits.maxItems ||
          retainedBytes + byteCost > limits.maxBytes
        ) {
          exhaustedCategories.add(bucket.category);
          continue;
        }
        bucket.retained.push(item);
        retainedItems += itemCost;
        retainedBytes += byteCost;
      }
    }
  }

  const retained = new Map(
    buckets.map((bucket) => [bucket.category, bucket.retained]),
  );
  const retainedReviews = retained.get(
    'requested_changes_reviews',
  ) as GitHubPullRequestEventState['requestedChangesState']['history'];
  const requestedChangesState =
    requestedChangesStateFromReviews(retainedReviews);
  const exhausted = exhaustedCategories.size > 0;

  return {
    ...state,
    commits: retained.get('commits') as GitHubPullRequestEventState['commits'],
    commitsTruncated:
      Boolean(state.commitsTruncated) || exhaustedCategories.has('commits'),
    reviewThreads: retained.get(
      'review_threads',
    ) as GitHubPullRequestEventState['reviewThreads'],
    reviewThreadsTruncated:
      Boolean(state.reviewThreadsTruncated) ||
      exhaustedCategories.has('review_threads'),
    requestedChangesReviews: requestedChangesState.active,
    requestedChangesState,
    reviewsTruncated:
      Boolean(state.reviewsTruncated) ||
      exhaustedCategories.has('requested_changes_reviews'),
    conversationComments: retained.get('conversation_comments') as NonNullable<
      GitHubPullRequestEventState['conversationComments']
    >,
    conversationCommentsTruncated:
      Boolean(state.conversationCommentsTruncated) ||
      exhaustedCategories.has('conversation_comments'),
    checkSuites: retained.get(
      'check_suites',
    ) as GitHubPullRequestEventState['checkSuites'],
    checkSuitesTruncated:
      Boolean(state.checkSuitesTruncated) ||
      exhaustedCategories.has('check_suites'),
    checkRuns: retained.get(
      'check_runs',
    ) as GitHubPullRequestEventState['checkRuns'],
    checkRunsTruncated:
      Boolean(state.checkRunsTruncated) ||
      exhaustedCategories.has('check_runs'),
    eventBudget: {
      ...limits,
      retainedItems,
      retainedBytes,
      elapsedMs,
      exhausted,
      exhaustedCategories: [...exhaustedCategories].sort(),
    },
  };
}

export async function fetchPullRequestCommits(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestCommit[]> {
  return (await fetchPullRequestCommitsWithMetadata(options)).commits;
}

export async function fetchPullRequestCommitsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  eventBudget?: PullRequestEventFetchBudget;
}): Promise<{ commits: GitHubPullRequestCommit[]; truncated: boolean }> {
  const commits: GitHubPullRequestCommitApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/commits?per_page=100`;
  let pageCount = 0;

  while (
    nextUrl &&
    pageCount < 3 &&
    (options.eventBudget?.canFetch('commits') ?? true)
  ) {
    pageCount += 1;
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestCommitApiItemSchema),
      await response.json(),
    );
    let admittedPage = true;
    for (const commit of data) {
      if (options.eventBudget?.admit('commits', commit) === false) {
        admittedPage = false;
        break;
      }
      commits.push(commit);
    }
    nextUrl = nextLink(response.headers.get('link'));
    if (!admittedPage) break;
  }

  return {
    commits: commits.map((commit) => ({
      sha: commit.sha,
      url: commit.html_url,
      authorLogin: commit.author?.login ?? null,
      committedAt:
        commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
    })),
    truncated:
      Boolean(nextUrl) || Boolean(options.eventBudget?.exhausted('commits')),
  };
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

export function isOutOfDateMergeState(value: string | null | undefined) {
  return value === 'behind';
}

export function isOutOfDateState(
  behindBy: number | null,
  mergeableState: string | null | undefined,
) {
  return behindBy === null
    ? isOutOfDateMergeState(mergeableState)
    : behindBy > 0;
}

async function fetchPullRequestBehindBy(
  options: { token: string; owner: string; repo: string },
  detail: GitHubPullRequestDetail,
) {
  if (!detail.baseSha || !detail.headSha) return null;
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/compare/${encodePathSegment(detail.baseSha)}...${encodePathSegment(detail.headSha)}`,
  );
  const comparison = v.parse(
    v.object({ behind_by: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
    await response.json(),
  );
  return comparison.behind_by;
}

function normalizePullRequestFile(
  file: GitHubPullRequestFileApiItem,
): GitHubPullRequestFile {
  const patch = file.patch ? unifiedPatchFromGitHubFile(file) : null;
  const renameOnly = patch === null && isRenameOnlyPullRequestFile(file);
  const binary =
    patch === null && !renameOnly && isLikelyBinaryPullRequestFile(file);
  const truncated = patch === null && !binary && !renameOnly;
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
    message:
      patch === null ? missingPatchMessage(file, { binary, renameOnly }) : null,
  };
}

function isRenameOnlyPullRequestFile(file: GitHubPullRequestFileApiItem) {
  return (
    file.status === 'renamed' &&
    Boolean(file.previous_filename) &&
    file.additions === 0 &&
    file.deletions === 0 &&
    file.changes === 0
  );
}

function isLikelyBinaryPullRequestFile(file: GitHubPullRequestFileApiItem) {
  return file.additions === 0 && file.deletions === 0 && file.changes === 0;
}

function missingPatchMessage(
  file: GitHubPullRequestFileApiItem,
  options: { binary: boolean; renameOnly: boolean },
) {
  if (options.renameOnly) {
    return `File was renamed from ${file.previous_filename ?? 'its previous path'} with no content changes.`;
  }
  return options.binary
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

export function summarizePullRequestFiles(
  files: GitHubPullRequestFile[],
): GitHubDiffSummary {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    binaryFiles: files.filter((file) => file.binary).length,
  };
}
