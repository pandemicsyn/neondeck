import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { readHostMetrics } from './metrics';

const kiloApiKey = process.env.KILOCODE_API_KEY ?? process.env.KILO_API_KEY;
const kiloOrganizationId =
  process.env.KILOCODE_ORGANIZATION_ID ?? process.env.KILO_ORGANIZATION_ID;

registerProvider('kilocode', {
  api: 'openai-completions',
  baseUrl: 'https://api.kilo.ai/api/gateway',
  apiKey: kiloApiKey,
  headers: kiloOrganizationId
    ? { 'X-KiloCode-OrganizationId': kiloOrganizationId }
    : undefined,
});

const app = new Hono();

const staticRoot = './web/dist';

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'xeneon-edge-dashboard',
    uptimeSeconds: Math.round(process.uptime()),
  }),
);

app.get('/api/dashboard/config', async (c) => {
  const source = await readFile('./config/dashboard.json', 'utf8');
  return c.json(JSON.parse(source));
});

app.get('/api/metrics/host', async (c) => {
  return c.json(await readHostMetrics());
});

app.get('/api/github/prs', async (c) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return c.json({ error: 'GITHUB_TOKEN is not configured', items: [] }, 503);
  }

  const login = process.env.GITHUB_LOGIN ?? (await fetchGitHubLogin(token));
  const queries = [
    `is:pr is:open archived:false author:${login}`,
    `is:pr is:open archived:false assignee:${login}`,
    `is:pr is:open archived:false review-requested:${login}`,
  ];

  const results = await Promise.all(queries.map((query) => searchPullRequests(token, query)));
  const items = new Map<string, GitHubPullRequest>();

  for (const result of results.flat()) {
    items.set(result.url, result);
  }

  return c.json({
    login,
    items: Array.from(items.values()).sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
    fetchedAt: new Date().toISOString(),
  });
});

app.route('/api/flue', flue());

app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/favicon.svg', serveStatic({ root: staticRoot, path: 'favicon.svg' }));
app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

type GitHubPullRequest = {
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

async function fetchGitHubLogin(token: string) {
  const response = await githubFetch(token, 'https://api.github.com/user');
  const data = (await response.json()) as { login?: string };
  if (!data.login) {
    throw new Error('GitHub API did not return a login');
  }
  return data.login;
}

async function searchPullRequests(token: string, query: string) {
  const params = new URLSearchParams({
    q: query,
    sort: 'updated',
    order: 'desc',
    per_page: '20',
  });
  const response = await githubFetch(token, `https://api.github.com/search/issues?${params}`);
  const data = (await response.json()) as { items?: GitHubSearchIssue[] };
  return (data.items ?? []).map(normalizePullRequest);
}

async function githubFetch(token: string, url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'xeneon-edge-dashboard',
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
    labels: (item.labels ?? []).map((label) => label.name).filter((name): name is string => !!name),
    comments: item.comments,
    updatedAt: item.updated_at,
    createdAt: item.created_at,
  };
}

export default app;
