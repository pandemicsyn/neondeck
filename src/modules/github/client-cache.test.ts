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

it.each(['provider', 'network'])(
  'evicts a cached validator after a %s failure and rejects a subsequent stale 304',
  async (failure) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ old: true }))
      .mockImplementationOnce(async () => {
        if (failure === 'network')
          throw new TypeError('synthetic network failure');
        return Response.json({}, { status: 500 });
      })
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(response({ fresh: true }, { ETag: '"fresh"' }));
    vi.stubGlobal('fetch', mock);
    await read();
    await expect(read()).rejects.toThrow(
      failure === 'network'
        ? 'synthetic network failure'
        : 'GitHub request failed with 500',
    );
    await expect(read()).rejects.toMatchObject({ status: 304 });
    expect(await read()).toEqual({ fresh: true });
    expect(
      mock.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('if-none-match'),
      ),
    ).toEqual([null, '"v1"', null, null]);
  },
);

it.each([200, 304])(
  'preserves a newer successful %s validator when an older read fails',
  async (status) => {
    let fail: ((reason: Error) => void) | undefined;
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ old: true }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(
        status === 200
          ? response({ fresh: true }, { ETag: '"fresh"' })
          : new Response(null, { status: 304, headers: { ETag: '"fresh"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', mock);
    await read();
    const old = read('synthetic-a', url, {
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fail).toBeDefined());
    const expected = status === 200 ? { fresh: true } : { old: true };
    expect(await read()).toEqual(expected);
    fail?.(new TypeError('synthetic late failure'));
    expect(await old).toBeInstanceOf(TypeError);
    expect(await read()).toEqual(expected);
    expect(
      new Headers(mock.mock.calls[3]?.[1]?.headers).get('if-none-match'),
    ).toBe('"fresh"');
  },
);

it.each(['same-token', 'other-token', 'clear'])(
  'fences conditional reads for %s invalidation',
  async (invalidation) => {
    const delayed = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ old: true }))
      .mockImplementationOnce(() => {
        started.resolve();
        return delayed.promise;
      })
      .mockResolvedValueOnce(Response.json({ written: true }))
      .mockResolvedValueOnce(response({ next: true }));
    vi.stubGlobal('fetch', mock);
    await read();
    const pending = read().catch((error: unknown) => error);
    await started.promise;
    if (invalidation === 'clear') clearGitHubRequestCache();
    else
      await (
        await githubFetch(
          invalidation === 'same-token' ? 'synthetic-a' : 'synthetic-b',
          url,
          { method: 'PATCH', body: '{}' },
        )
      ).json();
    delayed.resolve(
      new Response(null, { status: 304, headers: { ETag: '"validated"' } }),
    );
    if (invalidation === 'other-token')
      expect(await pending).toEqual({ old: true });
    else
      expect(await pending).toMatchObject({
        message: expect.stringContaining('invalidated'),
      });
    await read();
    expect(
      new Headers(mock.mock.calls.at(-1)?.[1]?.headers).get('if-none-match'),
    ).toBe(invalidation === 'other-token' ? '"validated"' : null);
  },
);

it.each([
  { slow: 304, fast: 200, noStore: 'none' },
  { slow: 304, fast: 304, noStore: 'none' },
  { slow: 304, fast: 200, noStore: 'slow' },
  { slow: 304, fast: 304, noStore: 'slow' },
  { slow: 304, fast: 200, noStore: 'fast' },
  { slow: 304, fast: 304, noStore: 'fast' },
])(
  'preserves the winning response for $slow/$fast reads with $noStore no-store',
  async ({ slow, fast, noStore }) => {
    const delayed = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const makeResponse = (status: number, version: string) => {
      const headers = {
        ETag: `"${version}"`,
        Link: `<https://api.github.com/${version}>; rel="next"`,
        ...(noStore === version ? { 'Cache-Control': 'no-store' } : {}),
      };
      return status === 304
        ? new Response(null, { status, headers })
        : response({ version }, headers);
    };
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ version: 'original' }))
      .mockImplementationOnce(() => {
        started.resolve();
        return delayed.promise;
      })
      .mockResolvedValueOnce(makeResponse(fast, 'fast'))
      .mockResolvedValueOnce(
        noStore === 'fast'
          ? response({ version: 'uncached' })
          : new Response(null, { status: 304 }),
      );
    vi.stubGlobal('fetch', mock);
    await read();
    const pending = read('synthetic-a', url, {
      signal: new AbortController().signal,
    });
    await started.promise;
    await read();
    delayed.resolve(makeResponse(slow, 'slow'));
    await pending;
    const retained = await githubFetch('synthetic-a', url);
    expect(
      new Headers(mock.mock.calls.at(-1)?.[1]?.headers).get('if-none-match'),
    ).toBe(noStore === 'fast' ? null : '"fast"');
    if (noStore !== 'fast')
      expect(retained.headers.get('link')).toContain('/fast>');
    expect(await retained.json()).toEqual({
      version:
        noStore === 'fast' ? 'uncached' : fast === 200 ? 'fast' : 'original',
    });
  },
);

it.each(['headers', 'buffering'])(
  'does not resurrect a %s response after a newer no-store response',
  async (phase) => {
    const started = Promise.withResolvers<void>();
    let finish: (() => void) | undefined;
    const mock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"old":'));
                finish = () => {
                  controller.enqueue(new TextEncoder().encode('true}'));
                  controller.close();
                };
                started.resolve();
              },
            }),
            { headers: { 'Content-Type': 'application/json', ETag: '"old"' } },
          ),
      )
      .mockResolvedValueOnce(
        response({ fresh: true }, { 'Cache-Control': 'no-store' }),
      )
      .mockResolvedValueOnce(response({ next: true }));
    vi.stubGlobal('fetch', mock);
    const pending = read('synthetic-a', url, {
      signal: new AbortController().signal,
    });
    await started.promise;
    // Let the pending read claim the empty entry and begin body buffering before
    // the next request observes the absent cache entry.
    if (phase === 'buffering')
      await new Promise<void>((resolve) => setImmediate(resolve));
    await read();
    finish?.();
    expect(await pending).toEqual({ old: true });
    await read();
    expect(
      new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
    ).toBeNull();
  },
);

it('does not fence an uncached body completing across an unrelated token write', async () => {
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  const mock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    })
    .mockResolvedValueOnce(Response.json({ written: true }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', mock);
  const pending = read();
  await started.promise;
  await (
    await githubFetch('synthetic-b', url, { method: 'PATCH', body: '{}' })
  ).json();
  delayed.resolve(response({ fresh: true }));
  await pending;
  expect(await read()).toEqual({ fresh: true });
  expect(
    new Headers(mock.mock.calls[2]?.[1]?.headers).get('if-none-match'),
  ).toBe('"v1"');
});

it.each(['failure', '304', 'no-store'])(
  'allows a later full response after an earlier %s cache update',
  async (first) => {
    const delayed = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ original: true }))
      .mockImplementationOnce(() => {
        started.resolve();
        return delayed.promise;
      })
      .mockResolvedValueOnce(
        first === 'failure'
          ? Response.json({}, { status: 500 })
          : new Response(null, {
              status: 304,
              headers:
                first === 'no-store'
                  ? { 'Cache-Control': 'no-store' }
                  : { ETag: '"validated"' },
            }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', mock);
    await read();
    const pending = read('synthetic-a', url, {
      signal: new AbortController().signal,
    });
    await started.promise;
    if (first === 'failure')
      await expect(read()).rejects.toThrow('GitHub request failed with 500');
    else await read();
    delayed.resolve(response({ fresh: true }, { ETag: '"fresh"' }));
    await pending;
    expect(await read()).toEqual({ fresh: true });
    expect(
      new Headers(mock.mock.calls[3]?.[1]?.headers).get('if-none-match'),
    ).toBe('"fresh"');
  },
);
