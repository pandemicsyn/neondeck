import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrReviewDraftComment,
  buildPullRequestQueries,
  clearGitHubPullRequestQueueCache,
  fetchFailingCheckFacts,
  fetchCheckSummary,
  fetchPullRequestFiles,
  fetchPullRequestReviewThreads,
  fetchPullRequestQueue,
  postPullRequestComment,
  readLivePrReviewDraft,
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

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearGitHubPullRequestQueueCache();
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
    expect(queries.every((query) => query.includes('author:pandemicsyn'))).toBe(
      true,
    );
    expect(queries.every((query) => query.includes('repo:'))).toBe(true);
    expect(queries.some((query) => query.includes('assignee:'))).toBe(false);
    expect(queries.some((query) => query.includes('review-requested:'))).toBe(
      false,
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
    ).toHaveLength(2);
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
    });
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

    const withComment = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: second.id,
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
    });
    const right = saved.comments.find(
      (comment) => comment.body === 'Right side comment.',
    );
    const range = saved.comments.find(
      (comment) => comment.body === 'Range on renamed path.',
    );
    expect(right?.id).toEqual(expect.any(String));
    expect(range?.id).toEqual(expect.any(String));

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
          reviewUrl:
            'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
          headSha: 'head123',
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
