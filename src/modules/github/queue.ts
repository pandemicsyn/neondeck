import * as v from 'valibot';
import { mapWithConcurrency } from '../../lib/concurrency';
import { repoFullName } from '../repos';
import type { RepoConfig } from '../../runtime-home';
import { githubFetch, githubTokenFingerprint } from './client';
import { fetchCheckSummary } from './checks';
import { errorMessage } from './errors';
import { fetchPullRequestDetail } from './pull-requests';
import { githubSearchIssuesApiResponseSchema } from './schemas';
import type {
  GitHubPullRequest,
  GitHubPullRequestQueue,
  GitHubQueueIssue,
  GitHubSearchIssue,
  PullRequestQueueRelation,
  PullRequestSearchResult,
} from './schemas';

const searchPerPage = 50;
const maxSearchPages = 2;
const maxSearchItemsPerQuery = searchPerPage * maxSearchPages;
const defaultMaxQueueItemsToEnrich = 24;
const searchConcurrency = 3;
const enrichmentConcurrency = 2;
const pullRequestQueueCacheTtlMs = 45_000;
const pullRequestQueueCacheMaxEntries = 8;

const pullRequestQueueCache = new Map<
  string,
  { expiresAt: number; value: GitHubPullRequestQueue }
>();
const pullRequestQueueRequestsInFlight = new Map<
  string,
  Promise<GitHubPullRequestQueue>
>();

export async function fetchPullRequestQueue(options: {
  token: string;
  login: string;
  repos: RepoConfig[];
  maxItems?: number;
}): Promise<GitHubPullRequestQueue> {
  const maxItems = options.maxItems ?? defaultMaxQueueItemsToEnrich;
  const cacheKey = pullRequestQueueCacheKey(
    options.token,
    options.login,
    options.repos,
    maxItems,
  );
  const cached = pullRequestQueueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    pullRequestQueueCache.delete(cacheKey);
    pullRequestQueueCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) pullRequestQueueCache.delete(cacheKey);

  const existing = pullRequestQueueRequestsInFlight.get(cacheKey);
  if (existing) return existing;
  const request = fetchPullRequestQueueUncached(
    options,
    maxItems,
    cacheKey,
  ).finally(() => {
    if (pullRequestQueueRequestsInFlight.get(cacheKey) === request) {
      pullRequestQueueRequestsInFlight.delete(cacheKey);
    }
  });
  pullRequestQueueRequestsInFlight.set(cacheKey, request);
  return request;
}

async function fetchPullRequestQueueUncached(
  options: {
    token: string;
    login: string;
    repos: RepoConfig[];
    maxItems?: number;
  },
  maxItems: number,
  cacheKey: string,
) {
  const queries = buildPullRequestQuerySpecs(options.login, options.repos);
  const primaryQueries = queries.filter((query) => !query.fallbackFor);
  const primaryResults = await fetchPullRequestSearches(
    options.token,
    primaryQueries,
  );
  const primaryByQuery = new Map(
    primaryResults.map((result) => [result.query, result.result]),
  );
  const fallbackQueries = queries.filter((query) => {
    if (!query.fallbackFor) return false;
    const primary = primaryByQuery.get(query.fallbackFor);
    return !primary || primary.truncated || primary.issues.length > 0;
  });
  const fallbackResults = await fetchPullRequestSearches(
    options.token,
    fallbackQueries,
  );
  const results = [...primaryResults, ...fallbackResults];
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
  if (!issues.some((issue) => issue.type === 'search-incomplete')) {
    pullRequestQueueCache.set(cacheKey, {
      expiresAt: Date.now() + pullRequestQueueCacheTtlMs,
      value: queue,
    });
    while (pullRequestQueueCache.size > pullRequestQueueCacheMaxEntries) {
      const oldestKey = pullRequestQueueCache.keys().next().value;
      if (oldestKey === undefined) break;
      pullRequestQueueCache.delete(oldestKey);
    }
  }

  return queue;
}

async function fetchPullRequestSearches(
  token: string,
  queries: ReturnType<typeof buildPullRequestQuerySpecs>,
) {
  return mapWithConcurrency(queries, searchConcurrency, async (query) => {
    try {
      return {
        query: query.query,
        relation: query.relation,
        result: await searchPullRequests(token, query.query),
      };
    } catch (error) {
      return {
        query: query.query,
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
  });
}

export function clearGitHubPullRequestQueueCache() {
  pullRequestQueueCache.clear();
  pullRequestQueueRequestsInFlight.clear();
}

export function buildPullRequestQueries(login: string, repos: RepoConfig[]) {
  return buildPullRequestQuerySpecs(login, repos).map((spec) => spec.query);
}

function buildPullRequestQuerySpecs(login: string, repos: RepoConfig[]) {
  const staleCutoff = staleCutoffDate();
  const queries: Array<{
    query: string;
    relation: PullRequestQueueRelation;
    fallbackFor?: string;
  }> = repos.flatMap((repo) => {
    const fullName = repoFullName(repo);
    const authoredQuery = `is:pr is:open archived:false author:${login} repo:${fullName}`;
    return [
      {
        query: authoredQuery,
        relation: 'authored' as const,
      },
      {
        query: `is:pr is:open archived:false author:${login} repo:${fullName} updated:<${staleCutoff}`,
        relation: 'authored' as const,
        fallbackFor: authoredQuery,
      },
      {
        query: `is:pr is:open archived:false assignee:${login} repo:${fullName}`,
        relation: 'assigned' as const,
      },
      {
        query: `is:pr is:open archived:false review-requested:${login} repo:${fullName}`,
        relation: 'review-requested' as const,
      },
    ];
  });

  return Array.from(
    new Map(queries.map((query) => [query.query, query])).values(),
  );
}

async function searchPullRequests(
  token: string,
  query: string,
): Promise<PullRequestSearchResult> {
  const items: GitHubPullRequest[] = [];
  let totalCount = 0;
  let incompleteResults = false;
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
    incompleteResults ||= data.incomplete_results;
    items.push(...data.items.map(normalizePullRequest));
    if (items.length >= data.total_count || data.items.length < searchPerPage) {
      break;
    }
  }
  const exceededItemLimit = totalCount > maxSearchItemsPerQuery;
  const truncated = exceededItemLimit || incompleteResults;
  return {
    items,
    truncated,
    issues: truncated
      ? [
          {
            type: incompleteResults
              ? ('search-incomplete' as const)
              : ('search-truncated' as const),
            query,
            message: incompleteResults
              ? `GitHub reported incomplete search results for this query; showing ${items.length} results and running any configured fallback.`
              : `GitHub search returned more than ${maxSearchItemsPerQuery} PRs for this query; showing the newest ${items.length}.`,
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
      baseSha: detail.baseSha ?? null,
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

function pullRequestQueueCacheKey(
  token: string,
  login: string,
  repos: RepoConfig[],
  maxItems: number,
) {
  return JSON.stringify({
    token: githubTokenFingerprint(token),
    login,
    maxItems,
    repos: repos
      .map((repo) => repoFullName(repo).toLowerCase())
      .sort((a, b) => a.localeCompare(b)),
  });
}

function staleCutoffDate() {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
}
