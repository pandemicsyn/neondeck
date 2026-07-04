import * as v from 'valibot';
import { repoFullName } from '../repos';
import type { RepoConfig } from '../../runtime-home';
import { githubFetch } from './client';
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

const pullRequestQueueCache = new Map<
  string,
  { expiresAt: number; value: GitHubPullRequestQueue }
>();

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

function staleCutoffDate() {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
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
