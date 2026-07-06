import * as v from 'valibot';
import { encodePathSegment, githubFetch, nextLink } from './client';

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  authorLogin: string | null;
  assigneeLogins: string[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  bodyExcerpt: string;
};

export type FetchGitHubIssuesInput = {
  token: string;
  owner: string;
  repo: string;
  since?: string | null;
  limit?: number;
};

const issueSchema = v.looseObject({
  number: v.number(),
  title: v.string(),
  html_url: v.string(),
  body: v.optional(v.nullable(v.string())),
  user: v.nullable(v.looseObject({ login: v.string() })),
  assignees: v.optional(v.array(v.looseObject({ login: v.string() }))),
  labels: v.optional(
    v.array(
      v.union([
        v.string(),
        v.looseObject({
          name: v.string(),
        }),
      ]),
    ),
  ),
  created_at: v.string(),
  updated_at: v.string(),
  comments: v.number(),
  pull_request: v.optional(v.unknown()),
});

export async function fetchGitHubIssues(input: FetchGitHubIssuesInput) {
  const limit = Math.max(1, Math.min(200, input.limit ?? 100));
  const params = new URLSearchParams({
    state: 'open',
    per_page: String(Math.min(100, limit)),
    sort: 'updated',
    direction: 'desc',
  });
  if (input.since) params.set('since', input.since);
  let url: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(input.owner)}/${encodePathSegment(input.repo)}/issues?${params.toString()}`;
  const issues: GitHubIssue[] = [];

  while (url && issues.length < limit) {
    const response = await githubFetch(input.token, url);
    const page = v.parse(v.array(issueSchema), await response.json());
    for (const item of page) {
      if (item.pull_request) continue;
      issues.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        labels: (item.labels ?? []).map((label) =>
          typeof label === 'string' ? label : label.name,
        ),
        authorLogin: item.user?.login ?? null,
        assigneeLogins: (item.assignees ?? []).map(
          (assignee) => assignee.login,
        ),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        commentCount: item.comments,
        bodyExcerpt: excerpt(item.body ?? ''),
      });
      if (issues.length >= limit) break;
    }
    url =
      issues.length >= limit
        ? undefined
        : nextLink(response.headers.get('link'));
  }

  return {
    items: issues,
    fetchedAt: new Date().toISOString(),
    truncated: Boolean(url),
  };
}

function excerpt(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 600
    ? normalized
    : `${normalized.slice(0, 600)}...`;
}
