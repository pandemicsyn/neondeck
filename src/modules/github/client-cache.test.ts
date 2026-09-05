import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearGitHubRequestCache, githubFetch } from './client';
import { GitHubApiError } from './errors';
const url = 'https://api.github.com/repos/example/fixture/issues/1';
const response = (value: unknown, headers: HeadersInit = {}) =>
  Response.json(value, { headers: { ETag: '"v1"', ...headers } });
const read = (token = 'synthetic-a', resource = url, init: RequestInit = {}) =>
  githubFetch(token, resource, init).then((r) => r.json());
beforeEach(clearGitHubRequestCache);
afterEach(() => {
  vi.unstubAllGlobals();
  clearGitHubRequestCache();
});
it('revalidates each read, carries Link through 304 and updates validators from 304 and changed 200', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response([1], { Link: '<https://api.github.com/page2>; rel="next"' }),
    )
    .mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { ETag: '"v2"' } }),
    )
    .mockResolvedValueOnce(response([2], { ETag: '"v3"' }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', mock);
  await read();
  const second = await githubFetch('synthetic-a', url);
  expect(second.headers.get('link')).toContain('rel="next"');
  expect(await second.json()).toEqual([1]);
  expect(await read()).toEqual([2]);
  expect(await read()).toEqual([2]);
  expect(
    mock.mock.calls.map((c) => new Headers(c[1]?.headers).get('if-none-match')),
  ).toEqual([null, '"v1"', '"v2"', '"v3"']);
});
it('isolates tokens, URLs including pagination, and representations', async () => {
  const mock = vi.fn<typeof fetch>(async () => response({ ok: true }));
  vi.stubGlobal('fetch', mock);
  await read();
  await read('synthetic-b');
  await read('synthetic-a', `${url}?page=2`);
  await read('synthetic-a', url, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  await read();
  expect(
    mock.mock.calls.map((c) => new Headers(c[1]?.headers).get('if-none-match')),
  ).toEqual([null, null, null, null, '"v1"']);
});
it.each(['success', 'error', 'ambiguous'])(
  'invalidates cached bodies on %s writes',
  async (mode) => {
    const mock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'PATCH') {
        if (mode === 'ambiguous') throw new TypeError('connection lost');
        return Response.json({}, { status: mode === 'error' ? 503 : 200 });
      }
      return response({ ok: true });
    });
    vi.stubGlobal('fetch', mock);
    await read();
    await read('synthetic-b');
    const write = githubFetch('synthetic-a', url, {
      method: 'PATCH',
      body: '{}',
    });
    const result = await Promise.allSettled([write.then((r) => r.json())]);
    expect(result[0]?.status).toBe(
      mode === 'success' ? 'fulfilled' : 'rejected',
    );
    await read();
    await read('synthetic-b');
    expect(
      new Headers(mock.mock.calls[3]?.[1]?.headers).get('if-none-match'),
    ).toBeNull();
    expect(
      new Headers(mock.mock.calls[4]?.[1]?.headers).get('if-none-match'),
    ).toBe('"v1"');
  },
);
it('cannot repopulate from a body completing after write invalidation', async () => {
  let finish: (() => void) | undefined;
  const mock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"old":'));
              finish = () => {
                controller.enqueue(new TextEncoder().encode('true}'));
                controller.close();
              };
            },
          }),
          { headers: { 'content-type': 'application/json', etag: '"old"' } },
        ),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(response({ fresh: true }));
  vi.stubGlobal('fetch', mock);
  const old = read();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await (
    await githubFetch('synthetic-a', url, { method: 'PATCH', body: '{}' })
  ).json();
  finish?.();
  await old;
  expect(await read()).toEqual({ fresh: true });
  expect(
    new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
  ).toBeNull();
});
it('rejects a 304 that crosses a write instead of returning invalidated authority', async () => {
  let finish: ((response: Response) => void) | undefined;
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ old: true }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', mock);
  await read();
  const pending = read().catch((error: unknown) => error);
  await vi.waitFor(() => expect(finish).toBeDefined());
  await (
    await githubFetch('synthetic-a', url, { method: 'PATCH', body: '{}' })
  ).json();
  finish?.(new Response(null, { status: 304 }));
  expect(await pending).toMatchObject({
    message: expect.stringContaining('invalidated'),
  });
});
it.each([200, 304])(
  'honors no-store on %s and drops the prior validator',
  async (status) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(
        status === 304
          ? new Response(null, {
              status,
              headers: { 'cache-control': 'private, no-store' },
            })
          : response({ ok: true }, { 'cache-control': 'no-store' }),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', mock);
    await read();
    await read();
    await read();
    expect(
      new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
    ).toBeNull();
  },
);
it.each(['invalid-json', 'partial', 'oversize', 'error'])(
  'does not retain %s responses',
  async (mode) => {
    const body =
      mode === 'invalid-json'
        ? '{'
        : mode === 'oversize'
          ? JSON.stringify('x'.repeat(2 * 1024 * 1024))
          : '{}';
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(body, {
          status: mode === 'partial' ? 206 : mode === 'error' ? 500 : 200,
          headers: { 'content-type': 'application/json', etag: '"bad"' },
        }),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', mock);
    const result = await Promise.allSettled([
      githubFetch('synthetic-a', url).then((r) => r.text()),
    ]);
    expect(result[0]?.status).toBe(mode === 'error' ? 'rejected' : 'fulfilled');
    await read();
    expect(
      new Headers(mock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
    ).toBeNull();
  },
);
it('constructs rate-limit errors safely for overflowing headers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {},
        {
          status: 429,
          headers: { 'retry-after': '1e309', 'x-ratelimit-reset': '1e309' },
        },
      ),
    ),
  );
  await expect(read()).rejects.toMatchObject({
    retry: { retryAt: null, rateLimited: true },
  } satisfies Partial<GitHubApiError>);
});

it('evicts least recently used validators at the entry bound', async () => {
  const mock = vi.fn<typeof fetch>(async () => response({ ok: true }));
  vi.stubGlobal('fetch', mock);
  for (let index = 0; index < 257; index++)
    await read('synthetic-a', `${url}?page=${index}`);
  await read('synthetic-a', `${url}?page=0`);
  expect(
    new Headers(mock.mock.calls[257]?.[1]?.headers).get('if-none-match'),
  ).toBeNull();
});
it('does not retain oversized response metadata', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response({}, { 'x-synthetic-metadata': 'x'.repeat(17 * 1024) }),
    )
    .mockResolvedValueOnce(response({}));
  vi.stubGlobal('fetch', mock);
  await read();
  await read();
  expect(
    new Headers(mock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
  ).toBeNull();
});
it('does not reuse partial streaming bodies after transport failure', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            controller.error(new Error('synthetic stream failure'));
          },
        }),
        { headers: { 'content-type': 'application/json', etag: '"partial"' } },
      ),
    )
    .mockResolvedValueOnce(response({}));
  vi.stubGlobal('fetch', mock);
  await expect(read()).rejects.toThrow('synthetic stream failure');
  await read();
  expect(
    new Headers(mock.mock.calls[1]?.[1]?.headers).get('if-none-match'),
  ).toBeNull();
});
it('bypasses validators for explicit no-store requests', async () => {
  const mock = vi.fn<typeof fetch>(async () => response({}));
  vi.stubGlobal('fetch', mock);
  await read('synthetic-a', url, { cache: 'no-store' });
  await read();
  await read('synthetic-a', url, { headers: { 'cache-control': 'no-store' } });
  expect(
    mock.mock.calls.map((c) => new Headers(c[1]?.headers).get('if-none-match')),
  ).toEqual([null, null, null]);
});
