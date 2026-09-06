import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearGitHubRequestCache } from './client';
import {
  readFactoryGitHubIssue,
  readFactoryGitHubIssuesPage,
  readFactoryGitHubCommentsPage,
  readFactoryGitHubComment,
  readFactoryGitHubRepository,
  factoryGitHubIdentity,
} from './factory-issues';
import type { GitHubConnection } from '../../../shared/factory-github';
const connection: GitHubConnection = {
  id: 'synthetic',
  enabled: true,
  repoId: 'fixture',
  repositoryId: '42',
  owner: 'example',
  name: 'fixture',
  tokenEnv: 'SYNTHETIC_TOKEN',
  webhookSecretEnv: 'SYNTHETIC_SECRET',
  admission: { mode: 'all' },
};
const issue = {
  id: 101,
  number: 1,
  title: 'Title',
  body: 'Body',
  state: 'open',
  updated_at: '2026-09-01T00:00:00Z',
  user: { login: 'synthetic' },
  labels: [],
};
const comment = {
  id: 102,
  body: 'Text',
  updated_at: issue.updated_at,
  created_at: issue.updated_at,
  user: { id: 1, login: 'synthetic' },
};
beforeEach(() => {
  clearGitHubRequestCache();
  vi.stubEnv('SYNTHETIC_TOKEN', 'synthetic-test-value');
});
afterEach(() => {
  clearGitHubRequestCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('retains pagination Link through 304 for issue discovery and comments, with per-page validators', async () => {
  const seen = new Set<string>();
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    const key = String(url);
    if (seen.has(key)) return new Response(null, { status: 304 });
    seen.add(key);
    expect(new Headers(init?.headers).get('if-none-match')).toBeNull();
    return Response.json(key.includes('/comments') ? [comment] : [issue], {
      headers: {
        etag: '"page"',
        link: '<https://api.github.com/next>; rel="next"',
      },
    });
  });
  vi.stubGlobal('fetch', mock);
  for (let round = 0; round < 2; round++) {
    expect(
      await readFactoryGitHubIssuesPage(connection, issue.updated_at, 1),
    ).toMatchObject({ hasNext: true, items: [{ id: 101 }] });
    expect(await readFactoryGitHubCommentsPage(connection, 1, 1)).toMatchObject(
      { hasNext: true, items: [{ id: 102 }] },
    );
    expect(await readFactoryGitHubCommentsPage(connection, 1, 2)).toMatchObject(
      { hasNext: true },
    );
  }
  expect(mock).toHaveBeenCalledTimes(6);
});
it.each([
  {
    name: 'issue',
    read: () => readFactoryGitHubIssue(connection, 1),
    body: issue,
  },
  {
    name: 'comment',
    read: () => readFactoryGitHubComment(connection, '102'),
    body: comment,
  },
  {
    name: 'repository',
    read: () => readFactoryGitHubRepository(connection),
    body: { id: 42, name: 'fixture', owner: { login: 'example' } },
  },
  {
    name: 'identity',
    read: () => factoryGitHubIdentity(connection),
    body: { id: 1, login: 'synthetic' },
  },
])(
  'revalidates authoritative $name reads rather than serving a TTL snapshot',
  async ({ read, body }) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(body, { headers: { etag: '"first"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', mock);
    expect(await read()).toEqual(await read());
    expect(mock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(mock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
    ).toBe('"first"');
  },
);
it('still validates reconstructed 304 bodies at the factory boundary', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ id: 101 }, { headers: { etag: '"invalid-shape"' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', mock);
  await expect(readFactoryGitHubIssue(connection, 1)).rejects.toThrow(
    'Invalid key',
  );
  await expect(readFactoryGitHubIssue(connection, 1)).rejects.toThrow(
    'Invalid key',
  );
});
it('preserves the 8 MiB read limit even when a body is too large for the validator cache', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json(
        { ...issue, body: 'x'.repeat(8 * 1024 * 1024) },
        { headers: { etag: '"large"' } },
      ),
    ),
  );
  await expect(readFactoryGitHubIssue(connection, 1)).rejects.toThrow('8 MiB');
});
it('honors cancellation before dispatch even with a retained validator', async () => {
  const mock = vi.fn<typeof fetch>(async () =>
    Response.json(issue, { headers: { etag: '"first"' } }),
  );
  vi.stubGlobal('fetch', mock);
  await readFactoryGitHubIssue(connection, 1);
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancellation'));
  await expect(
    readFactoryGitHubIssue(connection, 1, controller.signal),
  ).rejects.toThrow('synthetic cancellation');
  expect(mock).toHaveBeenCalledTimes(1);
});
