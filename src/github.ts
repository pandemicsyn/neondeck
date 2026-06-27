import { repoFullName } from './repos';
import type { RepoConfig } from './runtime-home';

export type GitHubPullRequest = {
  id: number;
  title: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  author: string;
  labels: string[];
  comments: number;
  updatedAt: string;
  createdAt: string;
};

export type GitHubPullRequestQueue = {
  login: string;
  repos: string[];
  items: GitHubPullRequest[];
  fetchedAt: string;
};

export async function fetchGitHubLogin(token: string) {
  const response = await githubFetch(token, 'https://api.github.com/user');
  const data = (await response.json()) as { login?: string };
  if (!data.login) {
    throw new Error('GitHub API did not return a login');
  }
  return data.login;
}

export async function fetchPullRequestQueue(options: {
  token: string;
  login: string;
  repos: RepoConfig[];
}): Promise<GitHubPullRequestQueue> {
  const queries = buildPullRequestQueries(options.login, options.repos);
  const results = await Promise.all(
    queries.map((query) => searchPullRequests(options.token, query)),
  );
  const items = new Map<string, GitHubPullRequest>();

  for (const result of results.flat()) {
    items.set(result.url, result);
  }

  return {
    login: options.login,
    repos: options.repos.map(repoFullName),
    items: Array.from(items.values()).sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
    fetchedAt: new Date().toISOString(),
  };
}

export function buildPullRequestQueries(login: string, repos: RepoConfig[]) {
  const queries = [
    `is:pr is:open archived:false author:${login}`,
    `is:pr is:open archived:false assignee:${login}`,
    `is:pr is:open archived:false review-requested:${login}`,
    ...repos.map(
      (repo) => `is:pr is:open archived:false repo:${repoFullName(repo)}`,
    ),
  ];

  return Array.from(new Set(queries));
}

async function searchPullRequests(token: string, query: string) {
  const params = new URLSearchParams({
    q: query,
    sort: 'updated',
    order: 'desc',
    per_page: '20',
  });
  const response = await githubFetch(
    token,
    `https://api.github.com/search/issues?${params}`,
  );
  const data = (await response.json()) as { items?: GitHubSearchIssue[] };
  return (data.items ?? []).map(normalizePullRequest);
}

async function githubFetch(token: string, url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'neondeck',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }

  return response;
}

type GitHubSearchIssue = {
  id: number;
  title: string;
  repository_url: string;
  number: number;
  html_url: string;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  comments: number;
  updated_at: string;
  created_at: string;
};

function normalizePullRequest(item: GitHubSearchIssue): GitHubPullRequest {
  return {
    id: item.id,
    title: item.title,
    repo: item.repository_url.replace('https://api.github.com/repos/', ''),
    number: item.number,
    url: item.html_url,
    state: item.state,
    author: item.user?.login ?? 'unknown',
    labels: (item.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => !!name),
    comments: item.comments,
    updatedAt: item.updated_at,
    createdAt: item.created_at,
  };
}
