import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitHubRequestCache,
  fetchGitHubLogin,
  githubFetch,
  githubGraphqlFetch,
} from './client';

const originalFetch = globalThis.fetch;

beforeEach(() => clearGitHubRequestCache());

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGitHubRequestCache();
  vi.restoreAllMocks();
});

describe('GitHub request budgeting', () => {
  it('revalidates cached REST responses with ETags', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('if-none-match') === '"pr-v1"') {
        return new Response(null, {
          status: 304,
          headers: { 'x-ratelimit-remaining': '4999' },
        });
      }
      return jsonResponse({ number: 42, state: 'open' }, { ETag: '"pr-v1"' });
    });
    globalThis.fetch = fetchMock;

    const first = await githubFetch(
      'token-a',
      'https://api.github.com/repos/acme/app/pulls/42',
    );
    const second = await githubFetch(
      'token-a',
      'https://api.github.com/repos/acme/app/pulls/42',
    );

    await expect(first.json()).resolves.toEqual({ number: 42, state: 'open' });
    await expect(second.json()).resolves.toEqual({
      number: 42,
      state: 'open',
    });
    expect(second.headers.get('x-ratelimit-remaining')).toBe('4999');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
    ).toBe('"pr-v1"');
  });

  it('coalesces identical GitHub GETs that are already in flight', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await blocked;
      return jsonResponse({ state: 'open' });
    });
    globalThis.fetch = fetchMock;

    const first = githubFetch(
      'token-a',
      'https://api.github.com/repos/acme/app/pulls/42',
    );
    const second = githubFetch(
      'token-a',
      'https://api.github.com/repos/acme/app/pulls/42',
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release?.();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    await expect(firstResponse.json()).resolves.toEqual({ state: 'open' });
    await expect(secondResponse.json()).resolves.toEqual({ state: 'open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the authenticated login by token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ login: 'octocat' }),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchGitHubLogin('token-a')).resolves.toBe('octocat');
    await expect(fetchGitHubLogin('token-a')).resolves.toBe('octocat');
    await expect(fetchGitHubLogin('token-b')).resolves.toBe('octocat');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces identical in-flight GraphQL queries', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await blocked;
      return jsonResponse({ data: { viewer: { login: 'octocat' } } });
    });
    globalThis.fetch = fetchMock;
    const query = 'query Viewer { viewer { login } }';

    const first = githubGraphqlFetch('token-a', query, {});
    const second = githubGraphqlFetch('token-a', query, {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: { viewer: { login: 'octocat' } } },
      { data: { viewer: { login: 'octocat' } } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a post-write query join a pre-write query', async () => {
    let releaseOldQuery: (() => void) | undefined;
    const oldQueryBlocked = new Promise<void>((resolve) => {
      releaseOldQuery = resolve;
    });
    let queryCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (/^\s*mutation\b/.test(body.query)) {
        return jsonResponse({ data: { resolveReviewThread: { ok: true } } });
      }
      queryCalls += 1;
      if (queryCalls === 1) {
        await oldQueryBlocked;
        return jsonResponse({ data: { thread: { isResolved: false } } });
      }
      return jsonResponse({ data: { thread: { isResolved: true } } });
    });
    globalThis.fetch = fetchMock;
    const query = 'query Thread { thread { isResolved } }';

    const oldQuery = githubGraphqlFetch('token-a', query, {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await githubGraphqlFetch(
      'token-a',
      'mutation Resolve { resolveReviewThread { ok } }',
      {},
    );
    const freshQuery = githubGraphqlFetch('token-a', query, {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    releaseOldQuery?.();

    await expect(oldQuery).resolves.toEqual({
      data: { thread: { isResolved: false } },
    });
    await expect(freshQuery).resolves.toEqual({
      data: { thread: { isResolved: true } },
    });
  });

  it('keys coalesced GETs by representation-affecting headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      jsonResponse({ range: new Headers(init?.headers).get('range') }),
    );
    globalThis.fetch = fetchMock;

    const [first, second] = await Promise.all([
      githubFetch('token-a', 'https://api.github.com/resource', {
        headers: { Range: 'bytes=0-9' },
      }).then((response) => response.json()),
      githubFetch('token-a', 'https://api.github.com/resource', {
        headers: { Range: 'bytes=10-19' },
      }).then((response) => response.json()),
    ]);

    expect(first).toEqual({ range: 'bytes=0-9' });
    expect(second).toEqual({ range: 'bytes=10-19' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects authorization header overrides', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;

    await expect(
      githubFetch('token-a', 'https://api.github.com/resource', {
        headers: { Authorization: 'Bearer token-b' },
      }),
    ).rejects.toThrow(
      'GitHub Authorization must be supplied through the token argument.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds concurrency slots until response bodies finish', async () => {
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releases.push(() => {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ ok: true })),
            );
            controller.close();
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock;

    const requests = Array.from({ length: 9 }, (_, index) =>
      githubFetch('token-a', `https://api.github.com/resource/${index}`).then(
        (response) => response.json(),
      ),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    for (const release of releases) release();

    await expect(Promise.all(requests)).resolves.toHaveLength(9);
  });
});

function jsonResponse(value: unknown, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: responseHeaders,
  });
}
