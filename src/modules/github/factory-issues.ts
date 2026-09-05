import * as v from 'valibot';
import {
  githubIssueSchema,
  githubCommentSchema,
  type GitHubConnection,
} from '../../../shared/factory-github';
import { githubFetch, nextLink } from './client';
const base = (connection: GitHubConnection) =>
  `https://api.github.com/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`;
async function readJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned no body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw new Error('GitHub response exceeds the 8 MiB read limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
export async function readFactoryGitHubIssue(
  connection: GitHubConnection,
  number: number,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues/${number}`,
    { signal, redirect: 'error' },
  );
  return v.parse(githubIssueSchema, await readJson(response));
}
export async function readFactoryGitHubIssuesPage(
  connection: GitHubConnection,
  since: string,
  page: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'asc',
    since,
    per_page: '25',
    page: String(page),
  });
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues?${query}`,
    { signal, redirect: 'error' },
  );
  return {
    items: v.parse(
      v.pipe(v.array(githubIssueSchema), v.maxLength(25)),
      await readJson(response),
    ),
    hasNext: !!nextLink(response.headers.get('link')),
  };
}
/** Neutral issue-comment reader; pagination stays with the caller's durable cursor. */
export async function readFactoryGitHubCommentsPage(
  connection: GitHubConnection,
  number: number,
  page: number,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues/${number}/comments?per_page=25&page=${page}`,
    { signal, redirect: 'error' },
  );
  return {
    items: v.parse(
      v.pipe(v.array(githubCommentSchema), v.maxLength(25)),
      await readJson(response),
    ),
    hasNext: !!nextLink(response.headers.get('link')),
  };
}
export async function readFactoryGitHubComment(
  connection: GitHubConnection,
  id: string,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues/comments/${encodeURIComponent(id)}`,
    { signal, redirect: 'error' },
  );
  return v.parse(githubCommentSchema, await readJson(response));
}
export async function readFactoryGitHubRepository(
  connection: GitHubConnection,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    base(connection),
    { signal, redirect: 'error' },
  );
  return v.parse(
    v.object({
      id: v.number(),
      name: v.string(),
      owner: v.object({ login: v.string() }),
    }),
    await readJson(response),
  );
}

/** These are issue comments, not PR review comments. */
export async function createFactoryGitHubComment(
  connection: GitHubConnection,
  number: number,
  body: string,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues/${number}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
      signal,
      redirect: 'error',
    },
  );
  return v.parse(githubCommentSchema, await readJson(response));
}
export async function updateFactoryGitHubComment(
  connection: GitHubConnection,
  id: string,
  body: string,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    `${base(connection)}/issues/comments/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
      signal,
      redirect: 'error',
    },
  );
  return v.parse(githubCommentSchema, await readJson(response));
}
export async function factoryGitHubIdentity(
  connection: GitHubConnection,
  signal?: AbortSignal,
) {
  const response = await githubFetch(
    process.env[connection.tokenEnv]!,
    'https://api.github.com/user',
    { signal, redirect: 'error' },
  );
  return v.parse(
    v.object({ login: v.string(), id: v.number() }),
    await readJson(response),
  );
}
