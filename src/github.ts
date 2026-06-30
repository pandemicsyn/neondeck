import { repoFullName } from './repos';
import type { RepoConfig } from './runtime-home';
import * as v from 'valibot';

export type GitHubPullRequest = {
  id: number;
  title: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  draft?: boolean;
  author: string;
  labels: string[];
  comments: number;
  updatedAt: string;
  createdAt: string;
  relations: PullRequestQueueRelation[];
  ageDays: number;
  stale: boolean;
  headSha: string | null;
  baseRef: string | null;
  checks: GitHubCheckSummary | null;
  checkError?: string;
};

export type GitHubQueueIssue = {
  type:
    | 'search-truncated'
    | 'search-error'
    | 'enrichment-error'
    | 'queue-truncated';
  message: string;
  query?: string;
  repo?: string;
  number?: number;
};

export type GitHubPullRequestQueue = {
  login: string;
  repos: string[];
  items: GitHubPullRequest[];
  fetchedAt: string;
  truncated: boolean;
  issues: GitHubQueueIssue[];
};

export type PullRequestQueueRelation =
  'authored' | 'assigned' | 'review-requested' | 'configured-repo';

type PullRequestSearchResult = {
  items: GitHubPullRequest[];
  truncated: boolean;
  issues: GitHubQueueIssue[];
};

export type GitHubPullRequestDetail = {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: string;
  draft?: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef?: string | null;
  headOwner?: string | null;
  headName?: string | null;
  headRepoFullName?: string | null;
  baseRef: string;
  baseSha?: string | null;
  baseRepoFullName?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  maintainerCanModify?: boolean;
  updatedAt: string;
};

export type GitHubCheckSummary = {
  status: 'success' | 'failure' | 'pending' | 'none';
  total: number;
  successful: number;
  failed: number;
  pending: number;
  statusContexts?: number;
  checkedAt: string;
};

export type GitHubPullRequestCommit = {
  sha: string;
  url: string;
  authorLogin: string | null;
  committedAt: string | null;
};

export type GitHubPullRequestReview = {
  id: number;
  nodeId: string | null;
  state: string;
  authorLogin: string | null;
  submittedAt: string | null;
  commitId: string | null;
  url: string | null;
};

export type GitHubPullRequestRequestedChangesState = {
  active: GitHubPullRequestReview[];
  latestByReviewer: GitHubPullRequestReview[];
  history: GitHubPullRequestReview[];
};

export type GitHubPullRequestReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: GitHubPullRequestReviewThreadComment[];
};

export type GitHubPullRequestReviewThreadComment = {
  id: string;
  databaseId: number | null;
  authorLogin: string | null;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
  reviewId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubCheckSuiteDetail = {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
  url: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type GitHubCheckRunDetail = {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  htmlUrl: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type GitHubBranchPushPermissions = {
  headRepoFullName: string | null;
  baseRepoFullName: string | null;
  isFork: boolean;
  maintainerCanModify: boolean;
  headRepoPush: boolean | null;
  baseRepoPush: boolean | null;
  canLikelyPush: boolean | null;
  checkedAt: string;
};

export type GitHubPullRequestComment = {
  id: number;
  nodeId: string | null;
  url: string;
  authorLogin: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPullRequestEventState = {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string | null;
  baseRef: string;
  baseSha: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  maintainerCanModify: boolean;
  commits: GitHubPullRequestCommit[];
  reviewThreads: GitHubPullRequestReviewThread[];
  requestedChangesReviews: GitHubPullRequestReview[];
  requestedChangesState: GitHubPullRequestRequestedChangesState;
  checkSuites: GitHubCheckSuiteDetail[];
  checkRuns: GitHubCheckRunDetail[];
  branchPermissions: GitHubBranchPushPermissions;
  isOutOfDate: boolean;
  fetchedAt: string;
};

const searchPerPage = 50;
const maxSearchPages = 2;
const maxSearchItemsPerQuery = searchPerPage * maxSearchPages;
const defaultMaxQueueItemsToEnrich = 24;
const searchConcurrency = 3;
const enrichmentConcurrency = 2;
const pullRequestQueueCacheTtlMs = 45_000;
const githubRequestTimeoutMs = 15_000;

const pullRequestQueueCache = new Map<
  string,
  { expiresAt: number; value: GitHubPullRequestQueue }
>();

export async function fetchGitHubLogin(token: string) {
  const response = await githubFetch(token, 'https://api.github.com/user');
  const data = v.parse(
    v.object({
      login: v.string(),
    }),
    await response.json(),
  );
  if (!data.login) {
    throw new Error('GitHub API did not return a login');
  }
  return data.login;
}

export async function fetchPullRequestQueue(options: {
  token: string;
  login: string;
  repos: RepoConfig[];
  maxItems?: number;
}): Promise<GitHubPullRequestQueue> {
  const maxItems = options.maxItems ?? defaultMaxQueueItemsToEnrich;
  const cacheKey = pullRequestQueueCacheKey(
    options.login,
    options.repos,
    maxItems,
  );
  const cached = pullRequestQueueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const queries = buildPullRequestQuerySpecs(options.login, options.repos);
  const results = await mapWithConcurrency(
    queries,
    searchConcurrency,
    async (query) => {
      try {
        return {
          relation: query.relation,
          result: await searchPullRequests(options.token, query.query),
        };
      } catch (error) {
        return {
          relation: query.relation,
          result: {
            items: [],
            truncated: false,
            issues: [
              {
                type: 'search-error' as const,
                query: query.query,
                message: errorMessage(error),
              },
            ],
          },
        };
      }
    },
  );
  const flattenedResults: Array<{
    relation: PullRequestQueueRelation;
    result: PullRequestSearchResult;
  }> = results.map((result) => ({
    relation: result.relation,
    result: result.result,
  }));
  const items = new Map<string, GitHubPullRequest>();
  const issues: GitHubQueueIssue[] = [];

  for (const result of flattenedResults) {
    issues.push(...result.result.issues);
    for (const item of result.result.items) {
      const existing = items.get(item.url);
      if (existing) {
        existing.relations = Array.from(
          new Set([...existing.relations, result.relation]),
        );
      } else {
        items.set(item.url, {
          ...item,
          relations: [result.relation],
        });
      }
    }
  }

  const sortedQueueItems = Array.from(items.values())
    .filter((item) => item.state === 'open')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const queueItemsToEnrich = sortedQueueItems.slice(0, maxItems);
  if (sortedQueueItems.length > queueItemsToEnrich.length) {
    issues.push({
      type: 'queue-truncated',
      message: `GitHub queue found ${sortedQueueItems.length} PRs; enriched the newest ${queueItemsToEnrich.length}.`,
    });
  }

  const enriched = await mapWithConcurrency(
    queueItemsToEnrich,
    enrichmentConcurrency,
    (item) => enrichPullRequest(options.token, item),
  );
  const sortedItems = enriched
    .filter((item) => item.state === 'open')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  issues.push(
    ...sortedItems
      .filter((item) => item.checkError)
      .map((item) => ({
        type: 'enrichment-error' as const,
        repo: item.repo,
        number: item.number,
        message: item.checkError ?? 'PR enrichment failed.',
      })),
  );

  const queue = {
    login: options.login,
    repos: options.repos.map(repoFullName),
    items: sortedItems,
    fetchedAt: new Date().toISOString(),
    truncated:
      flattenedResults.some((result) => result.result.truncated) ||
      sortedQueueItems.length > queueItemsToEnrich.length,
    issues,
  };
  pullRequestQueueCache.set(cacheKey, {
    expiresAt: Date.now() + pullRequestQueueCacheTtlMs,
    value: queue,
  });

  return queue;
}

export function clearGitHubPullRequestQueueCache() {
  pullRequestQueueCache.clear();
}

export function buildPullRequestQueries(login: string, repos: RepoConfig[]) {
  return buildPullRequestQuerySpecs(login, repos).map((spec) => spec.query);
}

function buildPullRequestQuerySpecs(login: string, repos: RepoConfig[]) {
  const staleCutoff = staleCutoffDate();
  const queries: Array<{
    query: string;
    relation: PullRequestQueueRelation;
  }> = repos.flatMap((repo) => {
    const fullName = repoFullName(repo);
    return [
      {
        query: `is:pr is:open archived:false author:${login} repo:${fullName}`,
        relation: 'authored' as const,
      },
      {
        query: `is:pr is:open archived:false author:${login} repo:${fullName} updated:<${staleCutoff}`,
        relation: 'authored' as const,
      },
    ];
  });

  return Array.from(
    new Map(queries.map((query) => [query.query, query])).values(),
  );
}

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

export async function fetchCheckSummary(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<GitHubCheckSummary> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const [runs, statusResponse] = await Promise.all([
    fetchCheckRuns(
      options.token,
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
    ),
    githubFetch(
      options.token,
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
    ),
  ]);
  const statusData = v.parse(
    githubCommitStatusApiResponseSchema,
    await statusResponse.json(),
  );
  const failed = runs.filter((run) =>
    [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
    ].includes(run.conclusion ?? ''),
  ).length;
  const pending = runs.filter((run) => run.status !== 'completed').length;
  const successful = runs.filter((run) => run.conclusion === 'success').length;
  const statusContexts = statusData.statuses ?? [];
  const failedStatuses = statusContexts.filter(
    (status) => status.state === 'failure' || status.state === 'error',
  ).length;
  const pendingStatuses = statusContexts.filter(
    (status) => status.state === 'pending',
  ).length;
  const successfulStatuses = statusContexts.filter(
    (status) => status.state === 'success',
  ).length;
  const total = runs.length + statusContexts.length;
  const totalFailed = failed + failedStatuses;
  const totalPending = pending + pendingStatuses;
  const totalSuccessful = successful + successfulStatuses;
  const status =
    total === 0
      ? 'none'
      : totalFailed > 0
        ? 'failure'
        : totalPending > 0
          ? 'pending'
          : 'success';

  return {
    status,
    total,
    successful: totalSuccessful,
    failed: totalFailed,
    pending: totalPending,
    statusContexts: statusContexts.length,
    checkedAt: new Date().toISOString(),
  };
}

async function fetchCheckRuns(token: string, initialUrl: string) {
  const runs: GitHubCheckRun[] = [];
  let nextUrl: string | undefined = initialUrl;

  while (nextUrl) {
    const response = await githubFetch(token, nextUrl);
    const data = v.parse(
      githubCheckRunsApiResponseSchema,
      await response.json(),
    );
    runs.push(...(data.check_runs ?? []));
    nextUrl = nextLink(response.headers.get('link'));
  }

  return runs;
}

export async function fetchCheckRunDetails(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<GitHubCheckRunDetail[]> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const runs = await fetchCheckRuns(
    options.token,
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
  );

  return runs.map((run, index) => ({
    id: run.id ?? index,
    name: run.name ?? `check-run-${index + 1}`,
    headSha: run.head_sha ?? options.ref,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url ?? null,
    htmlUrl: run.html_url ?? null,
    detailsUrl: run.details_url ?? null,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
  }));
}

export async function fetchCheckSuites(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<GitHubCheckSuiteDetail[]> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const suites: GitHubCheckSuiteApiResponse['check_suites'] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-suites?per_page=100`;

  while (nextUrl) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      githubCheckSuitesApiResponseSchema,
      await response.json(),
    );
    suites.push(...(data.check_suites ?? []));
    nextUrl = nextLink(response.headers.get('link'));
  }

  return suites.map((suite) => ({
    id: suite.id,
    headSha: suite.head_sha,
    status: suite.status,
    conclusion: suite.conclusion,
    appSlug: suite.app?.slug ?? suite.app?.name ?? null,
    url: suite.url ?? null,
    htmlUrl: suite.html_url ?? null,
    createdAt: suite.created_at ?? null,
    updatedAt: suite.updated_at ?? null,
  }));
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

export async function fetchPullRequestReviews(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestReview[]> {
  const reviews: GitHubPullRequestReviewApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/reviews?per_page=100`;

  while (nextUrl) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestReviewApiItemSchema),
      await response.json(),
    );
    reviews.push(...data);
    nextUrl = nextLink(response.headers.get('link'));
  }

  return reviews.map((review) => ({
    id: review.id,
    nodeId: review.node_id ?? null,
    state: review.state,
    authorLogin: review.user?.login ?? null,
    submittedAt: review.submitted_at ?? null,
    commitId: review.commit_id ?? null,
    url: review.html_url ?? null,
  }));
}

export async function postPullRequestComment(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<GitHubPullRequestComment> {
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/issues/${options.number}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body: options.body }),
    },
  );
  const data = v.parse(
    githubIssueCommentApiResponseSchema,
    await response.json(),
  );

  return {
    id: data.id,
    nodeId: data.node_id ?? null,
    url: data.html_url,
    authorLogin: data.user?.login ?? null,
    body: data.body,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function fetchPullRequestReviewThreads(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestReviewThread[]> {
  const threads: GitHubPullRequestReviewThread[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 5; page += 1) {
    const data = await githubGraphqlFetch(
      options.token,
      pullRequestReviewThreadsQuery,
      {
        owner: options.owner,
        name: options.repo,
        number: options.number,
        after: cursor,
      },
    );
    const parsed = v.parse(githubReviewThreadsGraphqlResponseSchema, data);
    const pullRequest = parsed.data.repository?.pullRequest;
    if (!pullRequest) break;
    for (const thread of pullRequest.reviewThreads.nodes ?? []) {
      const comments = await fetchAllReviewThreadComments(
        options.token,
        thread,
      );
      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path ?? null,
        line: thread.line ?? null,
        comments: comments.map((comment) =>
          normalizeReviewThreadComment(comment, thread),
        ),
      });
    }

    if (!pullRequest.reviewThreads.pageInfo.hasNextPage) break;
    cursor = pullRequest.reviewThreads.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  return threads;
}

async function fetchAllReviewThreadComments(
  token: string,
  thread: GitHubReviewThreadGraphqlNode,
) {
  const comments = [...(thread.comments.nodes ?? [])];
  let cursor = thread.comments.pageInfo.endCursor;

  for (let page = 0; thread.comments.pageInfo.hasNextPage && page < 10;) {
    page += 1;
    if (!cursor) break;
    const data = await githubGraphqlFetch(token, reviewThreadCommentsQuery, {
      threadId: thread.id,
      after: cursor,
    });
    const parsed = v.parse(
      githubReviewThreadCommentsGraphqlResponseSchema,
      data,
    );
    const node = parsed.data.node;
    if (!node?.comments) break;
    comments.push(...(node.comments.nodes ?? []));
    if (!node.comments.pageInfo.hasNextPage) break;
    cursor = node.comments.pageInfo.endCursor;
  }

  return comments;
}

function normalizeReviewThreadComment(
  comment: GitHubReviewThreadCommentGraphqlNode,
  thread: Pick<GitHubReviewThreadGraphqlNode, 'path' | 'line'>,
): GitHubPullRequestReviewThreadComment {
  return {
    id: comment.id,
    databaseId: comment.databaseId ?? null,
    authorLogin: comment.author?.login ?? null,
    body: comment.body,
    url: comment.url ?? null,
    path: comment.path ?? thread.path ?? null,
    line: comment.line ?? thread.line ?? null,
    originalLine: comment.originalLine ?? null,
    diffHunk: comment.diffHunk ?? null,
    reviewId: comment.pullRequestReview?.databaseId ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
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

async function searchPullRequests(
  token: string,
  query: string,
): Promise<PullRequestSearchResult> {
  const items: GitHubPullRequest[] = [];
  let totalCount = 0;
  for (let page = 1; page <= maxSearchPages; page += 1) {
    const params = new URLSearchParams({
      q: query,
      sort: 'updated',
      order: 'desc',
      per_page: String(searchPerPage),
      page: String(page),
    });
    const response = await githubFetch(
      token,
      `https://api.github.com/search/issues?${params}`,
    );
    const data = v.parse(
      githubSearchIssuesApiResponseSchema,
      await response.json(),
    );
    totalCount = data.total_count;
    items.push(...data.items.map(normalizePullRequest));
    if (items.length >= data.total_count || data.items.length < searchPerPage) {
      break;
    }
  }
  const truncated = totalCount > maxSearchItemsPerQuery;
  return {
    items,
    truncated,
    issues: truncated
      ? [
          {
            type: 'search-truncated' as const,
            query,
            message: `GitHub search returned more than ${maxSearchItemsPerQuery} PRs for this query; showing the newest ${items.length}.`,
          },
        ]
      : [],
  };
}

async function enrichPullRequest(token: string, item: GitHubPullRequest) {
  const [owner, repo] = item.repo.split('/');
  if (!owner || !repo) {
    return {
      ...item,
      ageDays: ageDays(item.updatedAt),
      stale: isStale(item.updatedAt),
    };
  }

  try {
    const detail = await fetchPullRequestDetail({
      token,
      owner,
      repo,
      number: item.number,
    });
    const checks = await fetchCheckSummary({
      token,
      owner,
      repo,
      ref: detail.headSha,
    });

    return {
      ...item,
      state: detail.state,
      draft: detail.draft,
      headSha: detail.headSha,
      baseRef: detail.baseRef,
      checks,
      ageDays: ageDays(item.updatedAt),
      stale: isStale(item.updatedAt),
    };
  } catch (error) {
    return {
      ...item,
      ageDays: ageDays(item.updatedAt),
      stale: isStale(item.updatedAt),
      checkError: errorMessage(error),
    };
  }
}

async function githubGraphqlFetch(
  token: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await githubFetch(token, 'https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  const parsed = v.parse(githubGraphqlBaseResponseSchema, data);
  if (parsed.errors?.length) {
    throw new Error(
      `GitHub GraphQL request failed: ${parsed.errors.map((item) => item.message).join('; ')}`,
    );
  }

  return data;
}

async function githubFetch(token: string, url: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        'User-Agent': 'neondeck',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new Error(
        `GitHub request timed out after ${Math.round(githubRequestTimeoutMs / 1000)}s`,
      );
    }

    throw error;
  }

  if (!response.ok) {
    throw new Error(githubErrorMessage(response));
  }

  return response;
}

const githubSearchIssueSchema = v.object({
  id: v.number(),
  title: v.string(),
  repository_url: v.string(),
  number: v.number(),
  html_url: v.string(),
  state: v.string(),
  draft: v.optional(v.boolean()),
  user: v.optional(v.object({ login: v.optional(v.string()) })),
  labels: v.optional(v.array(v.object({ name: v.optional(v.string()) }))),
  comments: v.number(),
  updated_at: v.string(),
  created_at: v.string(),
});

const githubSearchIssuesApiResponseSchema = v.object({
  total_count: v.number(),
  items: v.array(githubSearchIssueSchema),
});

const githubPullRequestApiResponseSchema = v.object({
  number: v.number(),
  title: v.string(),
  html_url: v.string(),
  state: v.string(),
  draft: v.optional(v.boolean()),
  merged: v.boolean(),
  merge_commit_sha: v.nullable(v.string()),
  mergeable: v.optional(v.nullable(v.boolean())),
  mergeable_state: v.optional(v.nullable(v.string())),
  maintainer_can_modify: v.optional(v.boolean()),
  updated_at: v.string(),
  head: v.object({
    sha: v.string(),
    ref: v.optional(v.string()),
    repo: v.optional(
      v.nullable(
        v.object({
          full_name: v.string(),
          name: v.string(),
          owner: v.object({ login: v.string() }),
        }),
      ),
    ),
  }),
  base: v.object({
    sha: v.optional(v.string()),
    ref: v.string(),
    repo: v.optional(
      v.nullable(
        v.object({
          full_name: v.string(),
        }),
      ),
    ),
  }),
});

const githubCheckRunsApiResponseSchema = v.object({
  check_runs: v.optional(
    v.array(
      v.object({
        id: v.optional(v.number()),
        name: v.optional(v.string()),
        head_sha: v.optional(v.string()),
        status: v.string(),
        conclusion: v.nullable(v.string()),
        url: v.optional(v.nullable(v.string())),
        html_url: v.optional(v.nullable(v.string())),
        details_url: v.optional(v.nullable(v.string())),
        started_at: v.optional(v.nullable(v.string())),
        completed_at: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
});

type GitHubCheckRun = NonNullable<
  v.InferOutput<typeof githubCheckRunsApiResponseSchema>['check_runs']
>[number];

const githubCommitStatusApiResponseSchema = v.object({
  statuses: v.optional(
    v.array(
      v.object({
        state: v.picklist(['error', 'failure', 'pending', 'success']),
      }),
    ),
  ),
});

const githubCheckSuitesApiResponseSchema = v.object({
  check_suites: v.optional(
    v.array(
      v.object({
        id: v.number(),
        head_sha: v.string(),
        status: v.string(),
        conclusion: v.nullable(v.string()),
        url: v.optional(v.nullable(v.string())),
        html_url: v.optional(v.nullable(v.string())),
        created_at: v.optional(v.nullable(v.string())),
        updated_at: v.optional(v.nullable(v.string())),
        app: v.optional(
          v.nullable(
            v.object({
              slug: v.optional(v.nullable(v.string())),
              name: v.optional(v.nullable(v.string())),
            }),
          ),
        ),
      }),
    ),
  ),
});
type GitHubCheckSuiteApiResponse = v.InferOutput<
  typeof githubCheckSuitesApiResponseSchema
>;

const githubPullRequestCommitApiItemSchema = v.object({
  sha: v.string(),
  html_url: v.string(),
  author: v.optional(v.nullable(v.object({ login: v.string() }))),
  commit: v.object({
    author: v.optional(v.nullable(v.object({ date: v.string() }))),
    committer: v.optional(v.nullable(v.object({ date: v.string() }))),
  }),
});
type GitHubPullRequestCommitApiItem = v.InferOutput<
  typeof githubPullRequestCommitApiItemSchema
>;

const githubPullRequestReviewApiItemSchema = v.object({
  id: v.number(),
  node_id: v.optional(v.string()),
  state: v.string(),
  user: v.optional(v.nullable(v.object({ login: v.string() }))),
  submitted_at: v.optional(v.nullable(v.string())),
  commit_id: v.optional(v.nullable(v.string())),
  html_url: v.optional(v.nullable(v.string())),
});
type GitHubPullRequestReviewApiItem = v.InferOutput<
  typeof githubPullRequestReviewApiItemSchema
>;

const githubRepositoryApiResponseSchema = v.object({
  full_name: v.string(),
  permissions: v.optional(
    v.object({
      admin: v.optional(v.boolean()),
      maintain: v.optional(v.boolean()),
      push: v.optional(v.boolean()),
      triage: v.optional(v.boolean()),
      pull: v.optional(v.boolean()),
    }),
  ),
});

const githubIssueCommentApiResponseSchema = v.object({
  id: v.number(),
  node_id: v.optional(v.nullable(v.string())),
  html_url: v.string(),
  body: v.string(),
  user: v.optional(v.nullable(v.object({ login: v.string() }))),
  created_at: v.string(),
  updated_at: v.string(),
});

const githubGraphqlBaseResponseSchema = v.looseObject({
  errors: v.optional(v.array(v.object({ message: v.string() }))),
});

const githubReviewThreadCommentGraphqlNodeSchema = v.object({
  id: v.string(),
  databaseId: v.optional(v.nullable(v.number())),
  body: v.string(),
  url: v.optional(v.nullable(v.string())),
  author: v.optional(v.nullable(v.object({ login: v.string() }))),
  createdAt: v.string(),
  updatedAt: v.string(),
  path: v.optional(v.nullable(v.string())),
  line: v.optional(v.nullable(v.number())),
  originalLine: v.optional(v.nullable(v.number())),
  diffHunk: v.optional(v.nullable(v.string())),
  pullRequestReview: v.optional(
    v.nullable(
      v.object({
        databaseId: v.optional(v.nullable(v.number())),
      }),
    ),
  ),
});
type GitHubReviewThreadCommentGraphqlNode = v.InferOutput<
  typeof githubReviewThreadCommentGraphqlNodeSchema
>;

const githubReviewThreadsGraphqlResponseSchema = v.object({
  data: v.object({
    repository: v.nullable(
      v.object({
        pullRequest: v.nullable(
          v.object({
            reviewThreads: v.object({
              pageInfo: v.object({
                hasNextPage: v.boolean(),
                endCursor: v.nullable(v.string()),
              }),
              nodes: v.optional(
                v.array(
                  v.object({
                    id: v.string(),
                    isResolved: v.boolean(),
                    isOutdated: v.boolean(),
                    path: v.optional(v.nullable(v.string())),
                    line: v.optional(v.nullable(v.number())),
                    comments: v.object({
                      pageInfo: v.object({
                        hasNextPage: v.boolean(),
                        endCursor: v.nullable(v.string()),
                      }),
                      nodes: v.optional(
                        v.array(githubReviewThreadCommentGraphqlNodeSchema),
                      ),
                    }),
                  }),
                ),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});
type GitHubReviewThreadGraphqlNode = NonNullable<
  NonNullable<
    NonNullable<
      v.InferOutput<
        typeof githubReviewThreadsGraphqlResponseSchema
      >['data']['repository']
    >['pullRequest']
  >['reviewThreads']['nodes']
>[number];

const githubReviewThreadCommentsGraphqlResponseSchema = v.object({
  data: v.object({
    node: v.nullable(
      v.object({
        comments: v.object({
          pageInfo: v.object({
            hasNextPage: v.boolean(),
            endCursor: v.nullable(v.string()),
          }),
          nodes: v.optional(
            v.array(githubReviewThreadCommentGraphqlNodeSchema),
          ),
        }),
      }),
    ),
  }),
});

const pullRequestReviewThreadsQuery = `
  query NeondeckPullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                databaseId
                body
                url
                author {
                  login
                }
                createdAt
                updatedAt
                path
                line
                originalLine
                diffHunk
                pullRequestReview {
                  databaseId
                }
              }
            }
          }
        }
      }
    }
  }
`;

const reviewThreadCommentsQuery = `
  query NeondeckPullRequestReviewThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            body
            url
            author {
              login
            }
            createdAt
            updatedAt
            path
            line
            originalLine
            diffHunk
            pullRequestReview {
              databaseId
            }
          }
        }
      }
    }
  }
`;

type GitHubSearchIssue = v.InferOutput<typeof githubSearchIssueSchema>;

function normalizePullRequest(item: GitHubSearchIssue): GitHubPullRequest {
  return {
    id: item.id,
    title: item.title,
    repo: item.repository_url.replace('https://api.github.com/repos/', ''),
    number: item.number,
    url: item.html_url,
    state: item.state,
    draft: item.draft ?? false,
    author: item.user?.login ?? 'unknown',
    labels: (item.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => !!name),
    comments: item.comments,
    updatedAt: item.updated_at,
    createdAt: item.created_at,
    relations: [],
    ageDays: ageDays(item.updated_at),
    stale: isStale(item.updated_at),
    headSha: null,
    baseRef: null,
    checks: null,
  };
}

function ageDays(value: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
}

function isStale(value: string) {
  return ageDays(value) >= 7;
}

function requestedChangesStateFromReviews(
  reviews: GitHubPullRequestReview[],
): GitHubPullRequestRequestedChangesState {
  const relevantStates = new Set([
    'APPROVED',
    'CHANGES_REQUESTED',
    'DISMISSED',
  ]);
  const history = reviews
    .filter((review) => relevantStates.has(review.state))
    .sort(compareReviewAge);
  const latestByReviewer = Array.from(
    history
      .reduce((items, review) => {
        items.set(review.authorLogin ?? `review:${review.id}`, review);
        return items;
      }, new Map<string, GitHubPullRequestReview>())
      .values(),
  ).sort(compareReviewAge);

  return {
    active: latestByReviewer.filter(
      (review) => review.state === 'CHANGES_REQUESTED',
    ),
    latestByReviewer,
    history,
  };
}

function compareReviewAge(
  left: GitHubPullRequestReview,
  right: GitHubPullRequestReview,
) {
  const leftTime = left.submittedAt ? Date.parse(left.submittedAt) : 0;
  const rightTime = right.submittedAt ? Date.parse(right.submittedAt) : 0;
  return leftTime - rightTime || left.id - right.id;
}

function isOutOfDateMergeState(value: string | null | undefined) {
  return value === 'behind' || value === 'dirty' || value === 'blocked';
}

function pullRequestQueueCacheKey(
  login: string,
  repos: RepoConfig[],
  maxItems: number,
) {
  return JSON.stringify({
    login,
    maxItems,
    repos: repos
      .map((repo) => repoFullName(repo).toLowerCase())
      .sort((a, b) => a.localeCompare(b)),
  });
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

function nextLink(linkHeader: string | null) {
  if (!linkHeader) return undefined;

  for (const link of linkHeader.split(',')) {
    const match = link.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return match[1];
    }
  }

  return undefined;
}

function staleCutoffDate() {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
}

function githubErrorMessage(response: Response) {
  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
  const rateLimitReset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');

  if (
    response.status === 429 ||
    (response.status === 403 && rateLimitRemaining === '0')
  ) {
    const retryAt = retryAfter
      ? ` Retry after ${retryAfter}s.`
      : rateLimitReset
        ? ` Rate limit resets at ${new Date(Number(rateLimitReset) * 1000).toISOString()}.`
        : '';
    return `GitHub request was rate limited with ${response.status}.${retryAt}`;
  }

  return `GitHub request failed with ${response.status}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRequestTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    }),
  );

  return results;
}
