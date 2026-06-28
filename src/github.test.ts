import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPullRequestQueries,
  clearGitHubPullRequestQueueCache,
  fetchCheckSummary,
  fetchPullRequestQueue,
} from './github';
import type { RepoConfig } from './runtime-home';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGitHubPullRequestQueueCache();
  vi.restoreAllMocks();
});

describe('github foundation', () => {
  it('builds user and configured repo PR queries', () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
      {
        id: 'flue',
        github: { owner: 'pandemicsyn', name: 'flue' },
        path: '/src/flue',
        defaultBranch: 'main',
      },
    ];

    const queries = buildPullRequestQueries('pandemicsyn', repos);

    expect(queries).toEqual(
      expect.arrayContaining([
        'is:pr is:open archived:false author:pandemicsyn',
        'is:pr is:open archived:false assignee:pandemicsyn',
        'is:pr is:open archived:false review-requested:pandemicsyn',
        'is:pr is:open archived:false repo:pandemicsyn/neondeck',
        'is:pr is:open archived:false repo:pandemicsyn/flue',
      ]),
    );
    expect(
      queries.some((query) =>
        query.startsWith(
          'is:pr is:open archived:false author:pandemicsyn updated:<',
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.startsWith(
          'is:pr is:open archived:false repo:pandemicsyn/neondeck updated:<',
        ),
      ),
    ).toBe(true);
  });

  it('deduplicates duplicate configured repo queries', () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
      {
        id: 'neondeck-copy',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck-copy',
        defaultBranch: 'main',
      },
    ];

    expect(
      buildPullRequestQueries('pandemicsyn', repos).filter(
        (query) =>
          query === 'is:pr is:open archived:false repo:pandemicsyn/neondeck',
      ),
    ).toHaveLength(1);
    expect(
      buildPullRequestQueries('pandemicsyn', repos).filter((query) =>
        query.startsWith(
          'is:pr is:open archived:false repo:pandemicsyn/neondeck updated:<',
        ),
      ),
    ).toHaveLength(1);
  });

  it('paginates PR searches and merges queue relations', async () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
    ];
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('/search/issues')) {
        const parsed = new URL(url);
        const query = parsed.searchParams.get('q') ?? '';
        const page = parsed.searchParams.get('page') ?? '1';
        if (query.includes('author:pandemicsyn')) {
          return jsonResponse({
            total_count: 51,
            items:
              page === '1'
                ? Array.from({ length: 50 }, (_, index) =>
                    searchIssue(index + 1),
                  )
                : [searchIssue(51)],
          });
        }
        if (query.includes('repo:pandemicsyn/neondeck')) {
          return jsonResponse({ total_count: 1, items: [searchIssue(1)] });
        }
        return jsonResponse({ total_count: 0, items: [] });
      }

      const pullMatch = url.match(/\/pulls\/(?<number>\d+)/);
      if (pullMatch?.groups?.number) {
        const number = Number(pullMatch.groups.number);
        return jsonResponse({
          number,
          title: `PR ${number}`,
          html_url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          updated_at: '2026-06-27T20:00:00Z',
          head: { sha: `sha-${number}` },
          base: { ref: 'main' },
        });
      }

      if (url.includes('/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }

      if (url.endsWith('/status')) {
        return jsonResponse({ statuses: [] });
      }

      return jsonResponse({}, 404);
    });

    const queue = await fetchPullRequestQueue({
      token: 'token',
      login: 'pandemicsyn',
      repos,
      maxItems: 100,
    });

    expect(queue.items).toHaveLength(51);
    expect(queue.truncated).toBe(false);
    expect(queue.issues).toEqual([]);
    expect(queue.items.find((item) => item.number === 1)?.relations).toEqual([
      'authored',
      'configured-repo',
    ]);
    expect(
      fetchedUrls.some(
        (url) => url.includes('/search/issues') && url.includes('page=2'),
      ),
    ).toBe(true);
  });

  it('combines check runs and commit status contexts', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/check-runs')) {
        return jsonResponse({
          check_runs: [{ status: 'completed', conclusion: 'success' }],
        });
      }
      if (url.endsWith('/status')) {
        return jsonResponse({
          statuses: [{ state: 'failure' }, { state: 'pending' }],
        });
      }
      return jsonResponse({}, 404);
    });

    await expect(
      fetchCheckSummary({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        ref: 'abc123',
      }),
    ).resolves.toMatchObject({
      status: 'failure',
      total: 3,
      successful: 1,
      failed: 1,
      pending: 1,
      statusContexts: 2,
    });
  });

  it('encodes slash-bearing refs in check summary paths', async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      if (url.endsWith('/status')) {
        return jsonResponse({ statuses: [] });
      }
      return jsonResponse({}, 404);
    });

    await fetchCheckSummary({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      ref: 'release/2026-06',
    });

    expect(fetchedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/commits/release%2F2026-06/check-runs'),
        expect.stringContaining('/commits/release%2F2026-06/status'),
      ]),
    );
  });

  it('bounds expensive PR enrichment to the newest queue items by default', async () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
    ];
    const enrichedPulls: number[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        return jsonResponse({
          total_count: 30,
          items: Array.from({ length: 30 }, (_, index) =>
            searchIssue(index + 1, {
              updatedAt: `2026-06-${String(30 - index).padStart(2, '0')}T20:00:00Z`,
            }),
          ),
        });
      }

      const pullMatch = url.match(/\/pulls\/(?<number>\d+)/);
      if (pullMatch?.groups?.number) {
        const number = Number(pullMatch.groups.number);
        enrichedPulls.push(number);
        return jsonResponse({
          number,
          title: `PR ${number}`,
          html_url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          updated_at: `2026-06-${String(31 - number).padStart(2, '0')}T20:00:00Z`,
          head: { sha: `sha-${number}` },
          base: { ref: 'main' },
        });
      }

      if (url.includes('/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }

      if (url.endsWith('/status')) {
        return jsonResponse({ statuses: [] });
      }

      return jsonResponse({}, 404);
    });

    const queue = await fetchPullRequestQueue({
      token: 'token',
      login: 'pandemicsyn',
      repos,
    });

    expect(queue.items).toHaveLength(24);
    expect(queue.truncated).toBe(true);
    expect(queue.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'queue-truncated',
          message: expect.stringContaining('enriched the newest 24'),
        }),
      ]),
    );
    expect(enrichedPulls.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });

  it('paginates check runs before summarizing status', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/check-runs') && !url.includes('page=2')) {
        return jsonResponse(
          {
            check_runs: Array.from({ length: 100 }, () => ({
              status: 'completed',
              conclusion: 'success',
            })),
          },
          200,
          {
            Link: '<https://api.github.com/repos/pandemicsyn/neondeck/commits/abc123/check-runs?per_page=100&page=2>; rel="next"',
          },
        );
      }
      if (url.includes('/check-runs') && url.includes('page=2')) {
        return jsonResponse({
          check_runs: [{ status: 'completed', conclusion: 'failure' }],
        });
      }
      if (url.endsWith('/status')) {
        return jsonResponse({ statuses: [] });
      }
      return jsonResponse({}, 404);
    });

    await expect(
      fetchCheckSummary({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        ref: 'abc123',
      }),
    ).resolves.toMatchObject({
      status: 'failure',
      total: 101,
      successful: 100,
      failed: 1,
    });
  });
});

function searchIssue(
  number: number,
  options: { updatedAt?: string; createdAt?: string } = {},
) {
  return {
    id: number,
    title: `PR ${number}`,
    repository_url: 'https://api.github.com/repos/pandemicsyn/neondeck',
    number,
    html_url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
    state: 'open',
    user: { login: 'pandemicsyn' },
    labels: [],
    comments: 0,
    updated_at: options.updatedAt ?? '2026-06-27T20:00:00Z',
    created_at: options.createdAt ?? '2026-06-27T19:00:00Z',
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
