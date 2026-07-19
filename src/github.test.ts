import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrReviewDraftComment,
  buildPullRequestQueries,
  clearGitHubPullRequestQueueCache,
  clearPullRequestReviewSurfaceThreadCache,
  deletePrReviewNeonSeedsForComments,
  fetchFailingCheckFacts,
  fetchGitHubIssues,
  fetchCheckSummary,
  fetchPullRequestFiles,
  fetchPullRequestReviewComments,
  fetchPullRequestReviewSurfaceThreadsWithMetadata,
  fetchPullRequestReviewThreads,
  fetchPullRequestReviewThreadsWithMetadata,
  fetchPullRequestQueue,
  invalidatePullRequestReviewSurfaceThreadCache,
  listPullRequestCommentsWithMetadata,
  postPullRequestComment,
  readLivePrReviewDraft,
  recordPrReviewNeonSeed,
  deletePrReviewDraftComment,
  replyToPullRequestReviewThread,
  resolvePullRequestReviewThread,
  submitPullRequestReview,
  unresolvePullRequestReviewThread,
  updatePrReviewDraftComment,
  upsertPrReviewDraft,
} from './modules/github';
import { listWorkflowSummaries } from './modules/app-state/workflow-summaries';
import type { RepoConfig } from './runtime-home';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createPullRequestEventFetchBudget } from './modules/github/event-budget';

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearGitHubPullRequestQueueCache();
  clearPullRequestReviewSurfaceThreadCache();
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('github foundation', () => {
  it('builds authored PR queries scoped to configured repos', () => {
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

    expect(queries.every((query) => query.includes('is:open'))).toBe(true);
    expect(queries.some((query) => query.includes('draft:false'))).toBe(false);
    expect(queries).toEqual(
      expect.arrayContaining([
        'is:pr is:open archived:false author:pandemicsyn repo:pandemicsyn/neondeck',
        'is:pr is:open archived:false author:pandemicsyn repo:pandemicsyn/flue',
      ]),
    );
    expect(queries.every((query) => query.includes('repo:'))).toBe(true);
    expect(
      queries.some((query) => query.includes('assignee:pandemicsyn')),
    ).toBe(true);
    expect(queries.some((query) => query.includes('review-requested:'))).toBe(
      true,
    );
    expect(
      queries.some((query) =>
        query.startsWith(
          'is:pr is:open archived:false author:pandemicsyn repo:pandemicsyn/neondeck updated:<',
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.startsWith(
          'is:pr is:open archived:false author:pandemicsyn repo:pandemicsyn/flue updated:<',
        ),
      ),
    ).toBe(true);
  });

  it('keeps open draft PRs and drops PRs closed during enrichment', async () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
    ];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        const parsed = new URL(url);
        const query = parsed.searchParams.get('q') ?? '';
        if (
          query.includes('author:pandemicsyn') &&
          query.includes('repo:pandemicsyn/neondeck')
        ) {
          return jsonResponse({
            total_count: 2,
            items: [
              searchIssue(1, { draft: true }),
              searchIssue(2, { updatedAt: '2026-06-27T19:00:00Z' }),
            ],
          });
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
          state: number === 2 ? 'closed' : 'open',
          draft: number === 1,
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
      maxItems: 10,
    });

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      number: 1,
      state: 'open',
      draft: true,
    });
  });

  it('marks issue pagination truncated when limit stops inside a page', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse([githubIssue(1), githubIssue(2), githubIssue(3)]),
    );

    const issues = await fetchGitHubIssues({
      token: 'gho_test',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      limit: 2,
    });

    expect(issues.items.map((issue) => issue.number)).toEqual([1, 2]);
    expect(issues.truncated).toBe(true);
  });

  it('marks issue pagination truncated at the page cap', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (_input) =>
      jsonResponse([githubPullRequest(1)], 200, {
        Link: '<https://api.github.com/repos/pandemicsyn/neondeck/issues?page=2>; rel="next"',
      }),
    );

    const issues = await fetchGitHubIssues({
      token: 'gho_test',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      limit: 10,
      maxPages: 1,
    });

    expect(issues.items).toEqual([]);
    expect(issues.truncated).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates authored PR searches for duplicate configured repos', () => {
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
      buildPullRequestQueries('pandemicsyn', repos).filter((query) =>
        query.includes('repo:pandemicsyn/neondeck'),
      ),
    ).toHaveLength(4);
    expect(new Set(buildPullRequestQueries('pandemicsyn', repos)).size).toEqual(
      buildPullRequestQueries('pandemicsyn', repos).length,
    );
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
        if (
          query.includes('author:pandemicsyn') &&
          query.includes('repo:pandemicsyn/neondeck')
        ) {
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
      truncated: false,
    });
  });

  it('marks check summary truncated at the page cap', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/check-runs')) {
        return jsonResponse(
          {
            check_runs: [{ status: 'completed', conclusion: 'success' }],
          },
          200,
          {
            Link: '<https://api.github.com/repos/pandemicsyn/neondeck/commits/abc123/check-runs?per_page=100&page=2>; rel="next"',
          },
        );
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
        maxCheckRunPages: 1,
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      total: 2,
      successful: 1,
      pending: 1,
      truncated: true,
    });
  });

  it('fails closed when failing check facts are truncated', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ check_runs: [] }, 200, {
        Link: '<https://api.github.com/repos/pandemicsyn/neondeck/commits/abc123/check-runs?per_page=100&page=2>; rel="next"',
      }),
    );

    await expect(
      fetchFailingCheckFacts({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        ref: 'abc123',
      }),
    ).rejects.toThrow('GitHub check run facts are truncated');
  });

  it('collects failing check facts and records unavailable logs', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/check-runs') && !url.includes('/annotations')) {
        return jsonResponse({
          check_runs: [
            {
              id: 901,
              name: 'check',
              head_sha: 'abc123',
              status: 'completed',
              conclusion: 'failure',
              url: 'https://api.github.com/repos/pandemicsyn/neondeck/check-runs/901',
              html_url: 'https://github.com/pandemicsyn/neondeck/runs/901',
              details_url: 'https://example.com/check/901',
              started_at: '2026-06-30T00:00:00Z',
              completed_at: '2026-06-30T00:02:00Z',
              output: {
                title: 'Tests failed',
                summary: 'npm run check failed.',
                text: 'Expected value 3.',
              },
            },
            {
              id: 902,
              name: 'lint',
              head_sha: 'abc123',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        });
      }
      if (url.includes('/check-runs/901/annotations')) {
        return jsonResponse([
          {
            path: 'src/app.ts',
            start_line: 1,
            end_line: 1,
            annotation_level: 'failure',
            message: 'Expected value 3.',
            title: 'Assertion failed',
            raw_details: 'received 2',
          },
        ]);
      }
      return jsonResponse({}, 404);
    });

    await expect(
      fetchFailingCheckFacts({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        ref: 'abc123',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 901,
        name: 'check',
        outputSummary: 'npm run check failed.',
        annotations: [
          expect.objectContaining({
            path: 'src/app.ts',
            message: 'Expected value 3.',
          }),
        ],
        log: {
          available: false,
          source: null,
          text: null,
          truncated: false,
          unavailableReason:
            'Full logs are unavailable because the check details URL does not expose a GitHub Actions job id.',
        },
      }),
    ]);
  });

  it('bounds fetched GitHub Actions job logs', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/commits/abc123/check-runs')) {
        return jsonResponse({
          check_runs: [
            {
              id: 901,
              name: 'check',
              head_sha: 'abc123',
              status: 'completed',
              conclusion: 'failure',
              details_url:
                'https://github.com/pandemicsyn/neondeck/actions/runs/111/job/222',
            },
          ],
        });
      }
      if (url.includes('/check-runs/901/annotations')) {
        return jsonResponse([]);
      }
      if (url.includes('/actions/jobs/222/logs')) {
        return new Response('0123456789', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return jsonResponse({}, 404);
    });

    await expect(
      fetchFailingCheckFacts({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        ref: 'abc123',
        maxLogBytes: 5,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 901,
        log: {
          available: true,
          source: 'github-actions-job',
          text: '01234',
          truncated: true,
          unavailableReason: null,
        },
      }),
    ]);
  });

  it('paginates review thread comments', async () => {
    const fetchedBodies: unknown[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      fetchedBodies.push(body);
      if (body.variables && typeof body.variables === 'object') {
        const variables = body.variables as Record<string, unknown>;
        if (variables.threadId === 'thread-1') {
          return jsonResponse({
            data: {
              node: {
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [reviewThreadComment('comment-101', 101)],
                },
              },
            },
          });
        }
      }

      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/app.ts',
                    line: 12,
                    originalLine: null,
                    diffSide: 'RIGHT',
                    comments: {
                      pageInfo: { hasNextPage: true, endCursor: 'cursor-100' },
                      nodes: [reviewThreadComment('comment-1', 1)],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });

    await expect(
      fetchPullRequestReviewThreads({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'thread-1',
        diffSide: 'RIGHT',
        comments: [
          expect.objectContaining({ databaseId: 1 }),
          expect.objectContaining({ databaseId: 101 }),
        ],
      }),
    ]);
    expect(fetchedBodies).toHaveLength(2);
    expect((fetchedBodies[0] as { query?: string }).query).toContain(
      'reviewThreads(first: 10',
    );
    expect((fetchedBodies[0] as { query?: string }).query).toContain(
      'comments(first: 10)',
    );
    expect((fetchedBodies[1] as { query?: string }).query).toContain(
      'comments(first: 20',
    );
  });

  it('continues budgeted review-thread pagination beyond the former 50-thread cap', async () => {
    let page = 0;
    const queries: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      queries.push(body.query ?? '');
      page += 1;
      const offset = (page - 1) * 10;
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: true,
                  endCursor: `cursor-${page}`,
                },
                nodes: Array.from({ length: 10 }, (_value, index) => {
                  const id = offset + index + 1;
                  return {
                    id: `thread-${id}`,
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/app.ts',
                    line: id,
                    originalLine: null,
                    diffSide: 'RIGHT',
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [reviewThreadComment(`comment-${id}`, id)],
                    },
                  };
                }),
              },
            },
          },
        },
      });
    });

    const result = await fetchPullRequestReviewThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      eventBudget: createPullRequestEventFetchBudget({
        maxItems: 125,
        maxBytes: 10 * 1024 * 1024,
        maxElapsedMs: 30_000,
      }),
    });

    expect(result.reviewThreads).toHaveLength(63);
    expect(result.truncated).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(7);
    expect(
      queries.every((query) => query.includes('reviewThreads(first: 10')),
    ).toBe(true);
  });

  it('stops comment pagination when the shared byte or time budget is exhausted', async () => {
    let elapsedMs = 0;
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      elapsedMs = 31_000;
      return jsonResponse([
        {
          id: 301,
          node_id: 'comment-301',
          html_url:
            'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-301',
          user: { login: 'reviewer', type: 'User' },
          body: 'A'.repeat(1024),
          created_at: '2026-07-19T00:00:00.000Z',
          updated_at: '2026-07-19T00:00:00.000Z',
        },
      ]);
    });
    const timed = await listPullRequestCommentsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      eventBudget: createPullRequestEventFetchBudget({
        maxItems: 100,
        maxBytes: 10 * 1024,
        maxElapsedMs: 30_000,
        now: () => elapsedMs,
      }),
    });
    expect(timed).toEqual({ comments: [], truncated: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse([
        {
          id: 302,
          node_id: 'comment-302',
          html_url:
            'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-302',
          user: { login: 'reviewer', type: 'User' },
          body: 'B'.repeat(1024),
          created_at: '2026-07-19T00:00:00.000Z',
          updated_at: '2026-07-19T00:00:00.000Z',
        },
      ]),
    );
    const bytes = await listPullRequestCommentsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      eventBudget: createPullRequestEventFetchBudget({
        maxItems: 100,
        maxBytes: 128,
        maxElapsedMs: 30_000,
      }),
    });
    expect(bytes).toEqual({ comments: [], truncated: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('marks review thread facts truncated when GitHub omits a next-page cursor', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: null },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/app.ts',
                    line: 12,
                    originalLine: null,
                    diffSide: 'RIGHT',
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [reviewThreadComment('comment-1', 1)],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );

    await expect(
      fetchPullRequestReviewThreadsWithMetadata({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
      }),
    ).resolves.toMatchObject({
      reviewThreads: [expect.objectContaining({ id: 'thread-1' })],
      truncated: true,
    });
  });

  it('uses a lean review-thread query for the interactive review surface', async () => {
    const fetchedBodies: Array<{ query?: string }> = [];
    const controller = new AbortController();
    const requestSignals: AbortSignal[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal) requestSignals.push(init.signal);
      fetchedBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/app.ts',
                    line: 12,
                    originalLine: null,
                    diffSide: 'RIGHT',
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: 'comment-1',
                          body: 'Surface comment',
                          url: 'https://example.test/comment-1',
                          author: { login: 'reviewer' },
                          createdAt: '2026-06-30T20:05:00Z',
                          updatedAt: '2026-06-30T20:05:00Z',
                          path: 'src/app.ts',
                          line: 12,
                          originalLine: null,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });

    await expect(
      fetchPullRequestReviewSurfaceThreadsWithMetadata({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      reviewThreads: [
        {
          id: 'thread-1',
          pullRequestRepo: null,
          pullRequestNumber: null,
          comments: [
            {
              id: 'comment-1',
              databaseId: null,
              diffHunk: null,
              reviewId: null,
            },
          ],
        },
      ],
      truncated: false,
    });
    controller.abort();
    expect(requestSignals[0]?.aborted).toBe(true);
    await fetchPullRequestReviewSurfaceThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    invalidatePullRequestReviewSurfaceThreadCache({
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });
    await fetchPullRequestReviewSurfaceThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(fetchedBodies[0]?.query).toContain(
      'NeondeckPullRequestReviewSurfaceThreads',
    );
    expect(fetchedBodies[0]?.query).not.toContain('diffHunk');
    expect(fetchedBodies[0]?.query).not.toContain('pullRequestReview');
    expect(fetchedBodies[0]?.query).not.toContain('databaseId');
  });

  it('does not cache a review-thread read invalidated while in flight', async () => {
    const body = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    };
    let resolveFirst!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return jsonResponse(body);
    });

    const first = fetchPullRequestReviewSurfaceThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    invalidatePullRequestReviewSurfaceThreadCache({
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });
    resolveFirst(jsonResponse(body));
    await first;
    await fetchPullRequestReviewSurfaceThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves caller cancellation instead of reporting a GitHub timeout', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected a request signal.');
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const request = fetchPullRequestReviewSurfaceThreadsWithMetadata({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 124,
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('logs when review thread pagination reaches the page cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let page = 0;
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      page += 1;
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: true,
                  endCursor: `cursor-${page}`,
                },
                nodes: [
                  {
                    id: `thread-${page}`,
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/app.ts',
                    line: page,
                    originalLine: null,
                    diffSide: 'RIGHT',
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [reviewThreadComment(`comment-${page}`, page)],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });

    await expect(
      fetchPullRequestReviewThreads({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
      }),
    ).resolves.toHaveLength(5);

    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('review thread fetch reached the page cap'),
    );
  });

  it('paginates PR files and records missing patches', async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('page=2')) {
        return jsonResponse([
          {
            sha: 'sha-b',
            filename: 'assets/logo.png',
            status: 'modified',
            additions: 0,
            deletions: 0,
            changes: 0,
            blob_url:
              'https://github.com/pandemicsyn/neondeck/blob/head/assets/logo.png',
            raw_url:
              'https://raw.githubusercontent.com/pandemicsyn/neondeck/head/assets/logo.png',
            contents_url:
              'https://api.github.com/repos/pandemicsyn/neondeck/contents/assets/logo.png',
          },
        ]);
      }

      return jsonResponse(
        [
          {
            sha: 'sha-large',
            filename: 'docs/large.md',
            status: 'modified',
            additions: 1200,
            deletions: 10,
            changes: 1210,
          },
          {
            sha: 'sha-a',
            filename: 'src/app.ts',
            status: 'modified',
            additions: 5,
            deletions: 1,
            changes: 6,
            patch:
              '@@ -1,3 +1,7 @@\n-old\n+new\n+added\n+added\n+added\n+added',
          },
        ],
        200,
        {
          Link: '<https://api.github.com/repos/pandemicsyn/neondeck/pulls/123/files?per_page=100&page=2>; rel="next"',
        },
      );
    });

    await expect(
      fetchPullRequestFiles({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
      }),
    ).resolves.toMatchObject({
      repo: 'pandemicsyn/neondeck',
      number: 123,
      diffSummary: {
        files: 3,
        additions: 1205,
        deletions: 11,
        binaryFiles: 1,
      },
      files: expect.arrayContaining([
        expect.objectContaining({
          path: 'docs/large.md',
          patch: null,
          binary: false,
          truncated: true,
          message: expect.stringContaining('diff is too large'),
        }),
        expect.objectContaining({
          path: 'src/app.ts',
          patch: expect.stringContaining(
            'diff --git a/src/app.ts b/src/app.ts',
          ),
        }),
        expect.objectContaining({
          path: 'src/app.ts',
          patch: expect.stringContaining('--- a/src/app.ts'),
        }),
        expect.objectContaining({
          path: 'src/app.ts',
          patch: expect.stringContaining('+++ b/src/app.ts'),
        }),
        expect.objectContaining({
          path: 'src/app.ts',
          patch: expect.stringContaining('+new'),
          binary: false,
        }),
        expect.objectContaining({
          path: 'assets/logo.png',
          patch: null,
          binary: true,
          truncated: false,
          message: expect.stringContaining('binary file'),
        }),
      ]),
    });
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain('/pulls/123/files?per_page=100');
    expect(fetchedUrls[1]).toContain('page=2');
  });

  it('persists one live PR review draft and edits draft comments', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);

    const first = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      body: ' First pass ',
    });
    const second = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head456',
      verdict: 'request-changes',
      body: 'Needs changes',
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      headSha: 'head123',
      verdict: 'request-changes',
      body: 'Needs changes',
      comments: [],
    });
    const explicitReanchor = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head456',
      reanchorHeadSha: true,
    });
    expect(explicitReanchor).toMatchObject({
      id: first.id,
      headSha: 'head456',
      verdict: 'request-changes',
      body: 'Needs changes',
    });

    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: explicitReanchor.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: ' Add a null guard. ',
    });
    const commentId = withComment.comments[0]?.id;
    expect(commentId).toEqual(expect.any(String));
    expect(withComment.comments[0]).toMatchObject({
      body: 'Add a null guard.',
      side: 'RIGHT',
      line: 12,
    });

    const updated = updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: commentId ?? '',
      body: 'Prefer an early return.',
    });
    expect(updated.comments[0]).toMatchObject({
      id: commentId,
      body: 'Prefer an early return.',
    });

    const reanchored = updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: commentId ?? '',
      path: 'src/next.ts',
      side: 'LEFT',
      line: 8,
      startLine: 6,
      startSide: 'LEFT',
      body: 'Move this note to the deleted range.',
    });
    expect(reanchored.comments[0]).toMatchObject({
      id: commentId,
      path: 'src/next.ts',
      side: 'LEFT',
      line: 8,
      startLine: 6,
      startSide: 'LEFT',
      body: 'Move this note to the deleted range.',
    });

    expect(() =>
      updatePrReviewDraftComment({
        databasePath: paths.neondeckDatabase,
        commentId: commentId ?? '',
        side: 'LEFT',
        line: 6,
        startLine: 8,
        startSide: 'LEFT',
        body: 'Invalid reversed range.',
      }),
    ).toThrow(/range start/i);

    const leftToRightRange = updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: commentId ?? '',
      side: 'RIGHT',
      line: 10,
      startLine: 8,
      startSide: 'LEFT',
      body: 'Valid cross-side range.',
    });
    expect(leftToRightRange.comments[0]).toMatchObject({
      side: 'RIGHT',
      line: 10,
      startLine: 8,
      startSide: 'LEFT',
      body: 'Valid cross-side range.',
    });

    expect(() =>
      updatePrReviewDraftComment({
        databasePath: paths.neondeckDatabase,
        commentId: commentId ?? '',
        side: 'LEFT',
        line: 8,
        startLine: 10,
        startSide: 'RIGHT',
        body: 'Invalid cross-side range.',
      }),
    ).toThrow(/cross-side range/i);

    const deleted = deletePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: commentId ?? '',
    });
    expect(deleted.comments).toEqual([]);
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 123,
      })?.id,
    ).toBe(first.id);
  });

  it('lists every exact inline comment created by one submitted review', async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      const secondPage = url.includes('page=2');
      return jsonResponse(
        [
          {
            id: secondPage ? 112 : 111,
            node_id: secondPage ? 'comment-node-112' : 'comment-node-111',
            pull_request_review_id: 9001,
            diff_hunk: '@@',
            path: secondPage ? 'src/two.ts' : 'src/one.ts',
            side: 'RIGHT',
            line: secondPage ? 22 : 11,
            start_line: secondPage ? 20 : null,
            start_side: secondPage ? 'RIGHT' : null,
            original_line: secondPage ? 22 : 11,
            body: secondPage ? 'Second comment.' : 'First comment.',
            user: { login: 'neon', type: 'User' },
            created_at: '2026-07-19T00:00:00.000Z',
            updated_at: '2026-07-19T00:00:00.000Z',
            html_url: `https://github.com/pandemicsyn/neondeck/pull/123#discussion_r${secondPage ? 112 : 111}`,
          },
        ],
        200,
        secondPage
          ? {}
          : {
              link: '<https://api.github.com/repos/pandemicsyn/neondeck/pulls/123/reviews/9001/comments?per_page=100&page=2>; rel="next"',
            },
      );
    });

    await expect(
      fetchPullRequestReviewComments({
        token: 'test-token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        reviewId: 9001,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        databaseId: 111,
        reviewId: 9001,
        side: 'RIGHT',
        startLine: null,
      }),
      expect.objectContaining({
        databaseId: 112,
        reviewId: 9001,
        side: 'RIGHT',
        startLine: 20,
        startSide: 'RIGHT',
      }),
    ]);
    expect(requests).toHaveLength(2);
  });

  it('submits review drafts with modern GitHub line anchors and writes an audit row', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'request-changes',
      body: ' Please address these. ',
    });
    let saved = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Right side comment.',
    });
    saved = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'LEFT',
      line: 4,
      body: 'Left side comment.',
      origin: 'neon',
    });
    saved = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/renamed.ts',
      side: 'RIGHT',
      line: 22,
      startLine: 20,
      startSide: 'RIGHT',
      body: 'Range on renamed path.',
      origin: 'neon',
    });
    const right = saved.comments.find(
      (comment) => comment.body === 'Right side comment.',
    );
    const left = saved.comments.find(
      (comment) => comment.body === 'Left side comment.',
    );
    const range = saved.comments.find(
      (comment) => comment.body === 'Range on renamed path.',
    );
    expect(right?.id).toEqual(expect.any(String));
    expect(left?.id).toEqual(expect.any(String));
    expect(range?.id).toEqual(expect.any(String));
    if (!left || !range) throw new Error('Expected seeded Neon comments.');
    recordPrReviewNeonSeed({
      databasePath: paths.neondeckDatabase,
      draft: saved,
      comment: left,
      severity: 'minor',
      summary: 'Left side seeded finding.',
      source: 'test',
    });
    recordPrReviewNeonSeed({
      databasePath: paths.neondeckDatabase,
      draft: saved,
      comment: range,
      severity: 'major',
      summary: 'Range seeded finding.',
      source: 'test',
    });

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        id: 9001,
        node_id: 'review-node-9001',
        state: 'CHANGES_REQUESTED',
        user: { login: 'neon' },
        submitted_at: '2026-07-05T14:00:00Z',
        commit_id: 'head123',
        html_url:
          'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
        body: 'Please address these.',
      });
    });

    const result = await submitPullRequestReview({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      databasePath: paths.neondeckDatabase,
      paths,
      draftId: draft.id,
      headSha: 'head123',
      commentIds: [right?.id ?? '', range?.id ?? ''],
      fetchHeadSha: async () => 'head123',
    });

    expect(result.draft).toMatchObject({
      id: draft.id,
      status: 'submitted',
      submittedAt: expect.any(String),
    });
    expect(result.review).toMatchObject({
      id: 9001,
      state: 'CHANGES_REQUESTED',
      body: 'Please address these.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/pandemicsyn/neondeck/pulls/123/reviews',
      init: { method: 'POST' },
    });
    const payload = JSON.parse(String(requests[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      commit_id: 'head123',
      event: 'REQUEST_CHANGES',
      body: 'Please address these.',
      comments: [
        {
          path: 'src/app.ts',
          side: 'RIGHT',
          line: 12,
          body: 'Right side comment.',
        },
        {
          path: 'src/renamed.ts',
          side: 'RIGHT',
          line: 22,
          start_line: 20,
          start_side: 'RIGHT',
          body: 'Range on renamed path.',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('position');

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'github_pr_review',
        status: 'submitted',
        summary: expect.objectContaining({
          repo: 'pandemicsyn/neondeck',
          prNumber: 123,
          verdict: 'request-changes',
          commentCount: 2,
          skippedCommentCount: 1,
          neonDraftOutcome: {
            seededNeonCommentCount: 2,
            survivingNeonCommentCount: 2,
            submittedNeonCommentCount: 1,
            skippedNeonCommentCount: 1,
            deletedNeonCommentCount: 0,
            skippedOrDeletedNeonCommentCount: 1,
            editedSubmittedNeonCommentCount: 0,
            submittedNeonCommentIds: [range?.id],
            skippedNeonCommentIds: [left?.id],
            deletedNeonCommentIds: [],
            bySeverity: {
              major: {
                seeded: 1,
                submitted: 1,
                skipped: 0,
                deleted: 0,
                editedSubmitted: 0,
              },
              minor: {
                seeded: 1,
                submitted: 0,
                skipped: 1,
                deleted: 0,
                editedSubmitted: 0,
              },
            },
          },
          reviewUrl:
            'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
          headSha: 'head123',
        }),
      }),
    ]);
  });

  it('accounts for deleted Neon seeded comments when submitting a review', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Submitting body only.',
    });
    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Seeded issue.',
      origin: 'neon',
    });
    const seeded = withComment.comments[0];
    expect(seeded?.id).toEqual(expect.any(String));
    if (!seeded) throw new Error('Expected seeded comment.');
    recordPrReviewNeonSeed({
      databasePath: paths.neondeckDatabase,
      draft: withComment,
      comment: seeded,
      severity: 'major',
      summary: 'Seeded issue summary.',
      source: 'test',
    });
    deletePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: seeded.id,
    });

    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        id: 9002,
        node_id: 'review-node-9002',
        state: 'COMMENTED',
        user: { login: 'neon' },
        submitted_at: '2026-07-05T15:00:00Z',
        commit_id: 'head123',
        html_url:
          'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9002',
        body: 'Submitting body only.',
      }),
    );

    await submitPullRequestReview({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      databasePath: paths.neondeckDatabase,
      paths,
      draftId: draft.id,
      headSha: 'head123',
      fetchHeadSha: async () => 'head123',
    });

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'github_pr_review',
        summary: expect.objectContaining({
          commentCount: 0,
          neonDraftOutcome: {
            seededNeonCommentCount: 1,
            survivingNeonCommentCount: 0,
            submittedNeonCommentCount: 0,
            skippedNeonCommentCount: 0,
            deletedNeonCommentCount: 1,
            skippedOrDeletedNeonCommentCount: 1,
            editedSubmittedNeonCommentCount: 0,
            submittedNeonCommentIds: [],
            skippedNeonCommentIds: [],
            deletedNeonCommentIds: [seeded.id],
            bySeverity: {
              major: {
                seeded: 1,
                submitted: 0,
                skipped: 0,
                deleted: 1,
                editedSubmitted: 0,
              },
            },
          },
        }),
      }),
    ]);
  });

  it('does not count rolled-back Neon seed ledger rows as deleted seeds', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Submitting body only.',
    });
    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Seeded issue.',
      origin: 'neon',
    });
    const seeded = withComment.comments[0];
    expect(seeded?.id).toEqual(expect.any(String));
    if (!seeded) throw new Error('Expected seeded comment.');
    recordPrReviewNeonSeed({
      databasePath: paths.neondeckDatabase,
      draft: withComment,
      comment: seeded,
      severity: 'major',
      summary: 'Seeded issue summary.',
      source: 'test',
    });
    expect(
      deletePrReviewNeonSeedsForComments({
        databasePath: paths.neondeckDatabase,
        commentIds: [seeded.id],
      }),
    ).toBe(1);
    deletePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: seeded.id,
    });

    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        id: 9003,
        node_id: 'review-node-9003',
        state: 'COMMENTED',
        user: { login: 'neon' },
        submitted_at: '2026-07-05T15:05:00Z',
        commit_id: 'head123',
        html_url:
          'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9003',
        body: 'Submitting body only.',
      }),
    );

    await submitPullRequestReview({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      databasePath: paths.neondeckDatabase,
      paths,
      draftId: draft.id,
      headSha: 'head123',
      fetchHeadSha: async () => 'head123',
    });

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'github_pr_review',
        summary: expect.objectContaining({
          commentCount: 0,
          neonDraftOutcome: expect.objectContaining({
            seededNeonCommentCount: 0,
            deletedNeonCommentCount: 0,
            skippedOrDeletedNeonCommentCount: 0,
            bySeverity: {},
          }),
        }),
      }),
    ]);
  });

  it('rejects stale review drafts before posting to GitHub', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'request-changes',
      body: 'Body',
    });
    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Comment.',
    });
    globalThis.fetch = vi.fn<typeof fetch>();

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head456',
        fetchHeadSha: async () => 'head456',
      }),
    ).rejects.toMatchObject({
      failure: {
        code: 'stale-draft',
        failingCommentIds: [withComment.comments[0]?.id],
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('submits a stale draft after comments are re-anchored and the draft head is explicitly refreshed', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'request-changes',
      body: 'Body',
    });
    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Old anchor.',
    });
    const commentId = withComment.comments[0]?.id ?? '';
    updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 14,
      body: 'New anchor.',
    });
    upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head456',
      reanchorHeadSha: true,
    });

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        id: 9002,
        node_id: 'review-node-9002',
        state: 'CHANGES_REQUESTED',
        user: { login: 'neon' },
        submitted_at: '2026-07-05T14:10:00Z',
        commit_id: 'head456',
        html_url:
          'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9002',
        body: 'Body',
      });
    });

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head456',
        commentIds: [commentId],
        fetchHeadSha: async () => 'head456',
      }),
    ).resolves.toMatchObject({
      draft: { id: draft.id, status: 'submitted' },
      review: { id: 9002, commitId: 'head456' },
    });
    const payload = JSON.parse(String(requests[0]?.init?.body)) as {
      commit_id?: string;
      comments?: Array<{ line?: number; body?: string }>;
    };
    expect(payload.commit_id).toBe('head456');
    expect(payload.comments).toEqual([
      expect.objectContaining({ line: 14, body: 'New anchor.' }),
    ]);
  });

  it('keeps failed GitHub review submissions as live drafts with precise failing comment ids', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Body',
    });
    let withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Good comment.',
    });
    withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 99,
      body: 'Bad comment.',
    });
    const failingCommentId = withComment.comments.find(
      (comment) => comment.body === 'Bad comment.',
    )?.id;
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          message: 'Validation failed',
          errors: [
            {
              resource: 'PullRequestReviewComment',
              field: 'comments[1].line',
              code: 'invalid',
              message: 'line must have a valid diff anchor',
            },
          ],
        },
        422,
      ),
    );

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head123',
        fetchHeadSha: async () => 'head123',
      }),
    ).rejects.toMatchObject({
      failure: {
        code: 'github-review-submit-failed',
        failingCommentIds: [failingCommentId],
      },
    });
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 123,
      }),
    ).toMatchObject({ id: draft.id, status: 'draft' });
  });

  it('maps GitHub review validation errors by path and line when no comment index is returned', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Body',
    });
    let withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Good comment.',
    });
    withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 99,
      body: 'Bad comment.',
    });
    const failingCommentId = withComment.comments.find(
      (comment) => comment.body === 'Bad comment.',
    )?.id;
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          message: 'Validation failed',
          errors: [
            {
              resource: 'PullRequestReviewComment',
              path: 'src/app.ts',
              line: 99,
              code: 'invalid',
              message: 'line must have a valid diff anchor',
            },
          ],
        },
        422,
      ),
    );

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head123',
        fetchHeadSha: async () => 'head123',
      }),
    ).rejects.toMatchObject({
      failure: {
        code: 'github-review-submit-failed',
        failingCommentIds: [failingCommentId],
      },
    });
  });

  it('does not classify generic GitHub validation text as insufficient scope', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Body',
    });
    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 12,
      body: 'Comment.',
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          message: 'Validation failed',
          errors: [
            {
              message: 'comments must have valid line anchors',
              field: 'comments[0].line',
            },
          ],
        },
        422,
      ),
    );

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head123',
        fetchHeadSha: async () => 'head123',
      }),
    ).rejects.toMatchObject({
      failure: {
        code: 'github-review-submit-failed',
        failingCommentIds: [withComment.comments[0]?.id],
      },
    });
  });

  it('maps GitHub review submission 403s to insufficient scope failures', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 123,
      headSha: 'head123',
      verdict: 'comment',
      body: 'Body',
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          message: 'Resource not accessible by integration',
        },
        403,
      ),
    );

    await expect(
      submitPullRequestReview({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        databasePath: paths.neondeckDatabase,
        paths,
        draftId: draft.id,
        headSha: 'head123',
        fetchHeadSha: async () => 'head123',
      }),
    ).rejects.toMatchObject({
      failure: {
        code: 'insufficient-scope',
        requires: ['pull_requests:write'],
      },
    });
  });

  it('replies to and resolves review threads through GitHub GraphQL', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      bodies.push(body);
      const query = String(body.query ?? '');
      if (query.includes('addPullRequestReviewThreadReply')) {
        return jsonResponse({
          data: { addPullRequestReviewThreadReply: { comment: { id: 'c2' } } },
        });
      }
      if (query.includes('unresolveReviewThread')) {
        return jsonResponse({
          data: { unresolveReviewThread: { thread: { id: 'thread-1' } } },
        });
      }
      if (query.includes('resolveReviewThread')) {
        return jsonResponse({
          data: { resolveReviewThread: { thread: { id: 'thread-1' } } },
        });
      }
      return jsonResponse({
        data: {
          node: {
            id: 'thread-1',
            isResolved: true,
            isOutdated: false,
            path: 'src/app.ts',
            line: 12,
            originalLine: null,
            diffSide: 'RIGHT',
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [reviewThreadComment('comment-1', 1)],
            },
          },
        },
      });
    });

    await expect(
      replyToPullRequestReviewThread({
        token: 'token',
        threadId: 'thread-1',
        body: 'Thanks, fixed.',
      }),
    ).resolves.toMatchObject({
      id: 'thread-1',
      isResolved: true,
      comments: [expect.objectContaining({ body: 'Comment 1' })],
    });
    await expect(
      resolvePullRequestReviewThread({
        token: 'token',
        threadId: 'thread-1',
      }),
    ).resolves.toMatchObject({ id: 'thread-1', isResolved: true });
    await expect(
      unresolvePullRequestReviewThread({
        token: 'token',
        threadId: 'thread-1',
      }),
    ).resolves.toMatchObject({ id: 'thread-1', isResolved: true });

    expect(
      bodies
        .map((body) => String(body.query ?? ''))
        .filter((query) =>
          query.includes('query NeondeckPullRequestReviewThread'),
        ),
    ).toHaveLength(3);
    expect(bodies[0]).toMatchObject({
      variables: { threadId: 'thread-1', body: 'Thanks, fixed.' },
    });
    expect(String(bodies[0]?.query)).toContain(
      'addPullRequestReviewThreadReply',
    );
    expect(String(bodies[2]?.query)).toContain('resolveReviewThread');
    expect(String(bodies[4]?.query)).toContain('unresolveReviewThread');
  });

  it('posts PR comments through the GitHub issue-comments endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        id: 77,
        node_id: 'comment-node-77',
        html_url:
          'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-77',
        body: 'Addressed review feedback.',
        user: { login: 'neon' },
        created_at: '2026-06-30T21:00:00Z',
        updated_at: '2026-06-30T21:00:00Z',
      });
    });

    await expect(
      postPullRequestComment({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        body: 'Addressed review feedback.',
      }),
    ).resolves.toMatchObject({
      id: 77,
      nodeId: 'comment-node-77',
      url: 'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-77',
      authorLogin: 'neon',
      body: 'Addressed review feedback.',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/pandemicsyn/neondeck/issues/123/comments',
      init: { method: 'POST' },
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      body: 'Addressed review feedback.',
    });
  });
});

function searchIssue(
  number: number,
  options: {
    updatedAt?: string;
    createdAt?: string;
    state?: string;
    draft?: boolean;
  } = {},
) {
  return {
    id: number,
    title: `PR ${number}`,
    repository_url: 'https://api.github.com/repos/pandemicsyn/neondeck',
    number,
    html_url: `https://github.com/pandemicsyn/neondeck/pull/${number}`,
    state: options.state ?? 'open',
    draft: options.draft ?? false,
    user: { login: 'pandemicsyn' },
    labels: [],
    comments: 0,
    updated_at: options.updatedAt ?? '2026-06-27T20:00:00Z',
    created_at: options.createdAt ?? '2026-06-27T19:00:00Z',
  };
}

function githubIssue(number: number) {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/pandemicsyn/neondeck/issues/${number}`,
    body: `Body for issue ${number}`,
    user: { login: 'pandemicsyn' },
    assignees: [],
    labels: [],
    comments: 0,
    created_at: `2026-06-27T19:0${number}:00Z`,
    updated_at: `2026-06-27T20:0${number}:00Z`,
  };
}

function githubPullRequest(number: number) {
  return {
    ...githubIssue(number),
    pull_request: {
      url: `https://api.github.com/repos/pandemicsyn/neondeck/pulls/${number}`,
    },
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

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
}

function reviewThreadComment(id: string, databaseId: number) {
  return {
    id,
    databaseId,
    body: `Comment ${databaseId}`,
    url: `https://github.com/pandemicsyn/neondeck/pull/123#discussion_r${databaseId}`,
    author: { login: 'reviewer' },
    createdAt: '2026-06-30T20:05:00Z',
    updatedAt: '2026-06-30T20:05:00Z',
    path: 'src/app.ts',
    line: 12,
    originalLine: 12,
    diffHunk: '@@',
    pullRequestReview: { databaseId: 9001 },
  };
}
