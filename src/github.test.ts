import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPullRequestQueries,
  fetchCheckSummary,
  fetchPullRequestQueue,
} from './github';
import type { RepoConfig } from './runtime-home';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});

function searchIssue(number: number) {
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
    updated_at: '2026-06-27T20:00:00Z',
    created_at: '2026-06-27T19:00:00Z',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
