import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubConnection } from '../../../shared/factory-github';
import { clearGitHubRequestCache } from './client';
import {
  createFactoryGitHubDraftPull,
  lookupFactoryGitHubPull,
  observeFactoryGitHubPull,
  readFactoryGitHubPull,
} from './factory-pulls';
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
const identity = {
  head: 'factory/work-1',
  base: 'main',
  marker: '<!-- neon-factory-pr:synthetic-1 -->',
};
const repo = { id: 42, name: 'fixture', owner: { login: 'example' } };
const pull = {
  id: 101,
  number: 7,
  html_url: 'https://github.com/example/fixture/pull/7',
  title: 'Synthetic change',
  body: `Description\n\n${identity.marker}`,
  state: 'open',
  draft: true,
  head: { ref: identity.head, sha: 'a'.repeat(40), repo },
  base: { ref: 'main', sha: 'b'.repeat(40), repo },
  user: { id: 4, login: 'synthetic-bot' },
  merged_at: null,
  merge_commit_sha: null,
  updated_at: '2026-09-01T00:00:00Z',
  merged: false,
  mergeable: null,
  mergeable_state: 'unknown',
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
function reply(body: unknown, headers?: HeadersInit) {
  const mock = vi.fn<typeof fetch>(async () =>
    Response.json(body, { headers }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}
it('looks up exact same-repo head/base in all states', async () => {
  const mock = reply([pull]);
  expect(await lookupFactoryGitHubPull(connection, identity)).toMatchObject({
    status: 'found',
    pull: { number: 7 },
    pages: 1,
  });
  const url = new URL(String(mock.mock.calls[0]?.[0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({
    state: 'all',
    head: 'example:factory/work-1',
    base: 'main',
    sort: 'created',
    direction: 'asc',
    per_page: '25',
    page: '1',
  });
});
it.each([
  { ...pull, body: 'no marker' },
  { ...pull, body: `${identity.marker}\n${identity.marker}` },
  { ...pull, body: '<!-- neon-factory-pr:other -->' },
  { ...pull, head: { ...pull.head, ref: 'other' } },
  { ...pull, base: { ...pull.base, ref: 'other' } },
  { ...pull, head: { ...pull.head, repo: { ...repo, id: 43 } } },
  {
    ...pull,
    base: { ...pull.base, repo: { ...repo, owner: { login: 'elsewhere' } } },
  },
  { ...pull, html_url: 'https://example.org/pull/7' },
])('rejects conflicting identity %#', async (value) => {
  reply([value]);
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    'identity conflict',
  );
});
it.each([
  { ...pull, draft: undefined },
  { ...pull, head: { ...pull.head, sha: 'bad' } },
  { ...pull, head: { ...pull.head, repo: null } },
  { ...pull, number: 0 },
])('rejects missing or malformed required facts %#', async (value) => {
  reply([value]);
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    /.+/,
  );
});
it('rejects duplicate results, including repeated pages', async () => {
  reply([pull, pull]);
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    'Duplicate',
  );
  const mock = reply([pull], {
    link: '<https://api.github.com/next>; rel="next"',
  });
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    'Duplicate',
  );
  expect(mock).toHaveBeenCalledTimes(2);
});
it('never claims uniqueness or absence from incomplete listing', async () => {
  reply([pull], { link: '<https://untrusted.example/next>; rel="next"' });
  expect(
    await lookupFactoryGitHubPull(connection, identity, { maxPages: 1 }),
  ).toMatchObject({ status: 'incomplete', candidate: { number: 7 }, pages: 1 });
  const mock = reply([], {
    link: '<https://untrusted.example/next>; rel="next"',
  });
  expect(
    await lookupFactoryGitHubPull(connection, identity, { maxPages: 2 }),
  ).toEqual({ status: 'incomplete', candidate: null, pages: 2 });
  expect(
    mock.mock.calls.every(([url]) =>
      String(url).startsWith(
        'https://api.github.com/repos/example/fixture/pulls?',
      ),
    ),
  ).toBe(true);
});
it('rejects oversized pages and malformed pagination', async () => {
  reply(Array.from({ length: 26 }, () => pull));
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    /.+/,
  );
  reply([], { link: 'not-a-link' });
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    'pagination',
  );
});
it('closed/merged PR is a receipt, not absence', async () => {
  reply([{ ...pull, state: 'closed', merged_at: pull.updated_at }]);
  expect(await lookupFactoryGitHubPull(connection, identity)).toMatchObject({
    status: 'found',
    pull: { state: 'closed' },
  });
});
it('creates exactly one draft POST with appended durable marker', async () => {
  const mock = vi.fn<typeof fetch>(async () =>
    Response.json(pull, { status: 201 }),
  );
  vi.stubGlobal('fetch', mock);
  await createFactoryGitHubDraftPull(connection, {
    ...identity,
    title: pull.title,
    body: 'Description',
  });
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    body: JSON.stringify({
      title: pull.title,
      body: pull.body,
      head: identity.head,
      base: 'main',
      draft: true,
      maintainer_can_modify: false,
    }),
  });
});
it.each(['network', 'http', 'malformed', 'not-draft'])(
  'never retries uncertain create: %s',
  async (kind) => {
    const mock = vi.fn<typeof fetch>(async () => {
      if (kind === 'network') throw new Error('synthetic timeout');
      if (kind === 'http')
        return Response.json({ message: 'validation failed' }, { status: 422 });
      return Response.json(
        kind === 'malformed' ? {} : { ...pull, draft: false },
        { status: 201 },
      );
    });
    vi.stubGlobal('fetch', mock);
    await expect(
      createFactoryGitHubDraftPull(connection, {
        ...identity,
        title: pull.title,
        body: 'Description',
      }),
    ).rejects.toThrow(/.+/);
    expect(mock).toHaveBeenCalledTimes(1);
  },
);
it('validates commands before dispatch', async () => {
  const mock = reply([]);
  await expect(
    createFactoryGitHubDraftPull(connection, {
      ...identity,
      title: pull.title,
      body: identity.marker,
    }),
  ).rejects.toThrow(/.+/);
  await expect(
    lookupFactoryGitHubPull(connection, { ...identity, head: '../bad' }),
  ).rejects.toThrow(/.+/);
  await expect(
    lookupFactoryGitHubPull(connection, identity, { maxPages: 11 }),
  ).rejects.toThrow(/.+/);
  expect(mock).not.toHaveBeenCalled();
});
it('observes bounded raw check/status/review facts pinned to head and preserves unknown mergeability', async () => {
  const mock = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('check-runs'))
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            id: 2,
            name: 'Unit',
            head_sha: pull.head.sha,
            status: 'completed',
            conclusion: 'success',
          },
        ],
      });
    if (String(url).includes('/statuses'))
      return Response.json([
        {
          id: 3,
          context: 'Legacy CI',
          state: 'pending',
          updated_at: pull.updated_at,
        },
      ]);
    if (String(url).includes('/reviews'))
      return Response.json([
        {
          id: 5,
          user: null,
          commit_id: 'c'.repeat(40),
          state: 'APPROVED',
          body: 'Synthetic top-level review prose',
          submitted_at: pull.updated_at,
        },
      ]);
    if (String(url).includes('/comments')) return Response.json([]);
    return Response.json(pull);
  });
  vi.stubGlobal('fetch', mock);
  const result = await observeFactoryGitHubPull(connection, 7, identity);
  expect(result).toMatchObject({
    pull: { mergeable: null },
    checks: { complete: true },
    statuses: { complete: true },
    reviews: {
      complete: true,
      items: [
        { commit_id: 'c'.repeat(40), body: 'Synthetic top-level review prose' },
      ],
    },
  });
  expect(result.complete).toBe(true);
  expect(mock).toHaveBeenCalledTimes(7);
});
it('reports incomplete checks from mismatched total; empty facts are retained', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).includes('check-runs')
          ? { total_count: 2, check_runs: [] }
          : String(url).includes('/pulls/7?') ||
              String(url).endsWith('/pulls/7')
            ? pull
            : [],
      ),
    ),
  );
  expect(await observeFactoryGitHubPull(connection, 7, identity)).toMatchObject(
    {
      checks: { items: [], complete: false },
      reviews: { items: [], complete: true },
    },
  );
});
it('rejects drift during observation and wrong detail number', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('check-runs'))
        return Response.json({ total_count: 0, check_runs: [] });
      if (String(url).endsWith('/pulls/7'))
        return Response.json(
          ++reads === 1
            ? pull
            : { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } },
        );
      return Response.json([]);
    }),
  );
  await expect(
    observeFactoryGitHubPull(connection, 7, identity),
  ).rejects.toThrow('changed');
  reply(pull);
  await expect(readFactoryGitHubPull(connection, 8, identity)).rejects.toThrow(
    'detail facts',
  );
});
it('propagates observation access errors instead of presenting missing CI as success', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) =>
      String(url).includes('check-runs')
        ? Response.json({ message: 'forbidden' }, { status: 403 })
        : Response.json(pull),
    ),
  );
  await expect(
    observeFactoryGitHubPull(connection, 7, identity),
  ).rejects.toMatchObject({ status: 403 });
});
it('fresh lookup revalidates a cached negative before accepting changed server facts', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([], { headers: { etag: '"negative"' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json([pull]));
  vi.stubGlobal('fetch', mock);
  expect(await lookupFactoryGitHubPull(connection, identity)).toMatchObject({
    status: 'absent',
  });
  expect(await lookupFactoryGitHubPull(connection, identity)).toMatchObject({
    status: 'absent',
  });
  expect(
    new Headers(mock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
  ).toBe('"negative"');
  expect(
    await lookupFactoryGitHubPull(connection, identity, { fresh: true }),
  ).toMatchObject({ status: 'found' });
  expect(
    new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
  ).toBe('"negative"');
  expect(mock.mock.calls[2]?.[1]?.cache).toBe('no-cache');
});
it('uncertain POST invalidates negative lookup for subsequent reconciliation', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([], { headers: { etag: '"negative"' } }),
    )
    .mockRejectedValueOnce(new Error('synthetic response loss'))
    .mockResolvedValueOnce(Response.json([pull]));
  vi.stubGlobal('fetch', mock);
  await lookupFactoryGitHubPull(connection, identity, { fresh: true });
  await expect(
    createFactoryGitHubDraftPull(connection, {
      ...identity,
      title: pull.title,
      body: 'Description',
    }),
  ).rejects.toThrow('response loss');
  expect(
    await lookupFactoryGitHubPull(connection, identity, { fresh: true }),
  ).toMatchObject({
    status: 'found',
  });
  expect(
    new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
  ).toBeNull();
});
it('preserves incomplete pagination through cached 304 and enforces body limit', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([], {
        headers: {
          etag: '"page"',
          link: '<https://api.github.com/next>; rel="next"',
        },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', mock);
  for (let i = 0; i < 2; i++)
    expect(
      await lookupFactoryGitHubPull(connection, identity, { maxPages: 1 }),
    ).toMatchObject({ status: 'incomplete' });
  reply([{ ...pull, body: 'x'.repeat(2 * 1024 * 1024) }]);
  await expect(lookupFactoryGitHubPull(connection, identity)).rejects.toThrow(
    '2 MiB',
  );
});
it('honors cancellation without dispatch', async () => {
  const mock = reply([]);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    lookupFactoryGitHubPull(connection, identity, {
      signal: controller.signal,
      fresh: true,
    }),
  ).rejects.toThrow('cancelled');
  expect(mock).not.toHaveBeenCalled();
});
it('retains inline and issue feedback, and fails closed on truncated comments', async () => {
  const comment = {
    id: 9,
    body: 'Synthetic feedback',
    user: { id: 4, login: 'synthetic' },
    created_at: pull.updated_at,
    updated_at: pull.updated_at,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.includes('/issues/7/comments')) return Response.json([comment]);
      if (path.includes('/pulls/7/comments'))
        return Response.json(
          [
            {
              ...comment,
              pull_request_review_id: 5,
              commit_id: pull.head.sha,
              original_commit_id: pull.head.sha,
              path: 'src/example.ts',
              line: 1,
              original_line: 1,
              side: 'RIGHT',
            },
          ],
          { headers: { link: '<https://api.github.com/next>; rel="next"' } },
        );
      if (path.includes('check-runs'))
        return Response.json({ total_count: 0, check_runs: [] });
      if (path.endsWith('/pulls/7')) return Response.json(pull);
      return Response.json([]);
    }),
  );
  expect(
    await observeFactoryGitHubPull(connection, 7, identity, { maxPages: 1 }),
  ).toMatchObject({
    complete: false,
    issueComments: { complete: true, items: [{ body: comment.body }] },
    inlineComments: {
      complete: false,
      items: [{ path: 'src/example.ts', line: 1 }],
    },
  });
});
it('fresh watch observations revalidate every cached resource with server 304s', async () => {
  const validators = new Map<string, string>();
  let notModified = 0;
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    const key = String(url);
    const validator = validators.get(key);
    expect(init?.cache).toBe('no-cache');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('if-none-match')).toBe(
      validator ?? null,
    );
    if (validator) {
      notModified++;
      return new Response(null, { status: 304 });
    }
    const etag = `"resource-${validators.size}"`;
    validators.set(key, etag);
    const body = key.endsWith('/pulls/7')
      ? pull
      : key.includes('/check-runs')
        ? { total_count: 0, check_runs: [] }
        : [];
    return Response.json(body, { headers: { etag } });
  });
  vi.stubGlobal('fetch', mock);
  const first = await observeFactoryGitHubPull(connection, 7, identity, {
    fresh: true,
  });
  const second = await observeFactoryGitHubPull(connection, 7, identity, {
    fresh: true,
  });
  expect(second).toEqual(first);
  expect(second.complete).toBe(true);
  expect(validators.size).toBe(6);
  expect(mock).toHaveBeenCalledTimes(14);
  expect(notModified).toBe(8);
});
it('two concurrent fresh authority reads neither join an earlier read nor each other', async () => {
  const earlier = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(pull, { headers: { etag: '"authority"' } }),
    )
    .mockImplementationOnce(() => earlier.promise)
    .mockImplementation(() => fresh.promise);
  vi.stubGlobal('fetch', mock);
  await readFactoryGitHubPull(connection, 7, identity, { fresh: true });
  const pendingEarlier = readFactoryGitHubPull(connection, 7, identity);
  const pendingFresh = [
    readFactoryGitHubPull(connection, 7, identity, { fresh: true }),
    readFactoryGitHubPull(connection, 7, identity, { fresh: true }),
  ];
  try {
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(4));
    for (const call of mock.mock.calls.slice(2)) {
      expect(new Headers(call[1]?.headers).get('if-none-match')).toBe(
        '"authority"',
      );
      expect(call[1]?.cache).toBe('no-cache');
    }
  } finally {
    fresh.resolve(new Response(null, { status: 304 }));
    earlier.resolve(new Response(null, { status: 304 }));
  }
  expect(await Promise.all(pendingFresh)).toEqual([pull, pull]);
  expect(await pendingEarlier).toEqual(pull);
});
it('fresh validators remain isolated by credential and are reusable after switching back', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(pull, { headers: { etag: '"credential-a"' } }),
    )
    .mockResolvedValueOnce(
      Response.json(pull, { headers: { etag: '"credential-b"' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', mock);
  for (const token of [
    'synthetic-a',
    'synthetic-b',
    'synthetic-a',
    'synthetic-b',
  ]) {
    vi.stubEnv('SYNTHETIC_TOKEN', token);
    expect(
      await readFactoryGitHubPull(connection, 7, identity, { fresh: true }),
    ).toEqual(pull);
  }
  expect(
    mock.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('if-none-match'),
    ),
  ).toEqual([null, null, '"credential-a"', '"credential-b"']);
});
