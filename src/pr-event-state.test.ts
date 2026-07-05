import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GitHubPullRequestDetail,
  GitHubPullRequestEventState,
  GitHubPullRequestReviewThread,
} from './modules/github';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrRequestedChanges,
  getGitHubPrReviewThreads,
  deleteGitHubPrReviewDraftComment,
  listPrWatchEventWatermarks,
  neondeckPrEventActions,
  neondeckPrEventTools,
  patchGitHubPrReviewDraftComment,
  postGitHubPrReviewDraftComment,
  postGitHubPrComment,
  postGitHubPrThreadReply,
  postGitHubPrThreadResolution,
  putGitHubPrReviewDraft,
  refreshPrWatchEventState,
} from './modules/pr-events';
import { runtimePaths } from './runtime-home';
import { addPrWatch, removePrWatch } from './modules/watches';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR event state watermarks', () => {
  it('exposes roadmap PR review fact tools and comment action names', () => {
    expect(neondeckPrEventTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'neondeck_pr_review_comments_lookup',
        'neondeck_pr_requested_changes_lookup',
        'neondeck_pr_branch_permissions_lookup',
      ]),
    );
    expect(neondeckPrEventActions.map((action) => action.name)).toEqual(
      expect.arrayContaining(['neondeck_pr_comment']),
    );
  });

  it('persists per-category event watermarks and reports silent unchanged refreshes', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      refreshPrWatchEventState({ watchId: 'pandemicsyn/neondeck#123' }, paths, {
        fetchPullRequestEventState: async () => prEventState(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      data: {
        watchId: 'pandemicsyn/neondeck#123',
        changedCategories: [
          'commits',
          'review_threads',
          'requested_changes_reviews',
          'check_suites',
          'check_runs',
          'mergeability',
          'out_of_date_branch',
        ],
      },
    });

    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#123' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({ category: 'commits' }),
          expect.objectContaining({ category: 'review_threads' }),
          expect.objectContaining({ category: 'requested_changes_reviews' }),
          expect.objectContaining({ category: 'check_suites' }),
          expect.objectContaining({ category: 'check_runs' }),
          expect.objectContaining({ category: 'mergeability' }),
          expect.objectContaining({ category: 'out_of_date_branch' }),
        ]),
      },
    });

    await expect(
      refreshPrWatchEventState({ watchId: 'pandemicsyn/neondeck#123' }, paths, {
        fetchPullRequestEventState: async () => prEventState(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      data: { changedCategories: [] },
    });

    await expect(
      refreshPrWatchEventState({ watchId: 'pandemicsyn/neondeck#123' }, paths, {
        fetchPullRequestEventState: async () =>
          prEventState({
            headSha: 'head456',
            commits: [
              ...prEventState().commits,
              {
                sha: 'head456',
                url: 'https://github.com/pandemicsyn/neondeck/commit/head456',
                authorLogin: 'reviewer',
                committedAt: '2026-06-30T21:00:00Z',
              },
            ],
          }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      data: {
        changedCategories: [
          'commits',
          'check_suites',
          'check_runs',
          'mergeability',
          'out_of_date_branch',
        ],
      },
    });
  });

  it('deletes watermarks when a PR watch is removed', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());
    await refreshPrWatchEventState(
      { watchId: 'pandemicsyn/neondeck#123' },
      paths,
      { fetchPullRequestEventState: async () => prEventState() },
    );

    await removePrWatch(
      { id: 'pandemicsyn/neondeck#123', confirm: true },
      paths,
    );

    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#123' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { watermarks: [] },
    });
  });

  it('detects requested-changes state clearing after a later approving review', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await refreshPrWatchEventState(
      { watchId: 'pandemicsyn/neondeck#123' },
      paths,
      { fetchPullRequestEventState: async () => prEventState() },
    );

    await expect(
      refreshPrWatchEventState({ watchId: 'pandemicsyn/neondeck#123' }, paths, {
        fetchPullRequestEventState: async () =>
          prEventState({
            requestedChangesReviews: [],
            requestedChangesState: {
              active: [],
              latestByReviewer: [
                {
                  id: 9002,
                  nodeId: 'review-9002',
                  state: 'APPROVED',
                  authorLogin: 'reviewer',
                  submittedAt: '2026-06-30T20:12:00Z',
                  commitId: 'head123',
                  url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9002',
                },
              ],
              history: [
                ...prEventState().requestedChangesState.history,
                {
                  id: 9002,
                  nodeId: 'review-9002',
                  state: 'APPROVED',
                  authorLogin: 'reviewer',
                  submittedAt: '2026-06-30T20:12:00Z',
                  commitId: 'head123',
                  url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9002',
                },
              ],
            },
          }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      data: { changedCategories: ['requested_changes_reviews'] },
    });

    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#123' },
        paths,
      ),
    ).resolves.toMatchObject({
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({
            category: 'requested_changes_reviews',
            watermark: expect.objectContaining({
              total: 0,
              reviewIds: [],
              latestByReviewer: [
                expect.objectContaining({ id: 9002, state: 'APPROVED' }),
              ],
            }),
          }),
        ]),
      },
    });
  });

  it('returns focused read-only PR event subsets', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    const dependencies = {
      fetchPullRequestEventState: async () => prEventState(),
    };

    await expect(
      getGitHubPrReviewThreads(
        { repo: 'neondeck', prNumber: 123 },
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      data: {
        reviewThreads: [
          expect.objectContaining({ id: 'thread-1', isResolved: false }),
          expect.objectContaining({ id: 'thread-2', isResolved: true }),
        ],
        unresolvedReviewComments: [
          expect.objectContaining({ databaseId: 111 }),
        ],
      },
    });
    await expect(
      getGitHubPrRequestedChanges(
        { repo: 'neondeck', prNumber: 123 },
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        requestedChangesReviews: [
          expect.objectContaining({ id: 9001, state: 'CHANGES_REQUESTED' }),
        ],
        requestedChangesState: expect.objectContaining({
          active: [
            expect.objectContaining({ id: 9001, state: 'CHANGES_REQUESTED' }),
          ],
        }),
      },
    });
    await expect(
      getGitHubPrBranchPermissions(
        { repo: 'neondeck', prNumber: 123 },
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        branchPermissions: expect.objectContaining({
          canLikelyPush: true,
        }),
      },
    });
  });

  it('posts PR comments through the server-side GitHub action boundary', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    const calls: unknown[] = [];

    await expect(
      postGitHubPrComment(
        {
          repo: 'neondeck',
          prNumber: 123,
          body: 'Addressed review feedback in commit abc123. Checks: test.',
          addressedReviewThreadIds: ['thread-1'],
          addressedReviewCommentIds: ['111'],
          checkRunIds: [6001],
          commitSha: 'abc123',
        },
        paths,
        {
          fetchPullRequestEventState: async () => prEventState(),
          postPullRequestComment: async (input) => {
            calls.push(input);
            return {
              id: 77,
              nodeId: 'comment-node-77',
              url: 'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-77',
              authorLogin: 'neon',
              body: input.body,
              createdAt: '2026-06-30T21:00:00Z',
              updatedAt: '2026-06-30T21:00:00Z',
            };
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'pr_comment',
      data: {
        target: {
          repoFullName: 'pandemicsyn/neondeck',
          number: 123,
        },
        comment: {
          id: 77,
          authorLogin: 'neon',
        },
        metadata: {
          addressedReviewThreadIds: ['thread-1'],
          addressedReviewCommentIds: ['111'],
          checkRunIds: [6001],
          commitSha: 'abc123',
        },
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        body: 'Addressed review feedback in commit abc123. Checks: test.',
      }),
    ]);
  });

  it('blocks PR comments for unconfigured repositories', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let posted = false;

    await expect(
      postGitHubPrComment(
        {
          repo: 'external/private-repo',
          prNumber: 123,
          body: 'This should not post.',
        },
        paths,
        {
          postPullRequestComment: async () => {
            posted = true;
            throw new Error('unexpected post');
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'pr_comment',
      requires: ['repo'],
      message:
        'Repository "external/private-repo" is not configured for PR comments.',
    });
    expect(posted).toBe(false);
  });

  it('keeps PR review draft comment mutations scoped to the route PR', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    const draftResult = await putGitHubPrReviewDraft(
      { repo: 'neondeck', prNumber: 123 },
      {
        headSha: 'head123',
        verdict: 'comment',
        body: 'Review body',
      },
      paths,
    );
    const draft = (
      draftResult.data as
        | { draft?: { id?: string; comments?: Array<{ id?: string }> } }
        | undefined
    )?.draft;
    expect(draft?.id).toEqual(expect.any(String));

    await expect(
      postGitHubPrReviewDraftComment(
        { repo: 'neondeck', prNumber: 124 },
        {
          draftId: draft?.id ?? '',
          path: 'src/app.ts',
          side: 'RIGHT',
          line: 12,
          body: 'Wrong PR.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'github_pr_review_draft_comment_post',
      message: 'Review draft does not belong to this pull request.',
    });

    const commentResult = await postGitHubPrReviewDraftComment(
      { repo: 'neondeck', prNumber: 123 },
      {
        draftId: draft?.id ?? '',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 12,
        body: 'Right PR.',
      },
      paths,
    );
    const commentId = (
      commentResult.data as
        { draft?: { comments?: Array<{ id?: string }> } } | undefined
    )?.draft?.comments?.[0]?.id;
    expect(commentId).toEqual(expect.any(String));

    await expect(
      patchGitHubPrReviewDraftComment(
        { repo: 'neondeck', prNumber: 124 },
        commentId ?? '',
        { body: 'Wrong PR edit.' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'github_pr_review_draft_comment_patch',
      message: 'Review draft comment does not belong to this pull request.',
    });

    await expect(
      deleteGitHubPrReviewDraftComment(
        { repo: 'neondeck', prNumber: 124 },
        commentId ?? '',
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'github_pr_review_draft_comment_delete',
      message: 'Review draft comment does not belong to this pull request.',
    });
  });

  it('keeps live PR review thread mutations scoped to the route PR', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    const mismatchCalls: string[] = [];

    await expect(
      postGitHubPrThreadReply(
        { repo: 'neondeck', prNumber: 123 },
        'thread-1',
        { text: 'Thanks, fixed.' },
        paths,
        {
          fetchPullRequestReviewThread: async (input) => {
            mismatchCalls.push(`fetch:${input.threadId}`);
            return reviewThread({ pullRequestNumber: 124 });
          },
          replyToPullRequestReviewThread: async (input) => {
            mismatchCalls.push(`reply:${input.threadId}`);
            return reviewThread();
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'github_pr_thread_reply_post',
      message: 'Review thread does not belong to this pull request.',
    });
    expect(mismatchCalls).toEqual(['fetch:thread-1']);

    const replyCalls: string[] = [];
    await expect(
      postGitHubPrThreadReply(
        { repo: 'neondeck', prNumber: 123 },
        'thread-1',
        { text: 'Thanks, fixed.' },
        paths,
        {
          fetchPullRequestReviewThread: async (input) => {
            replyCalls.push(`fetch:${input.threadId}`);
            return reviewThread();
          },
          replyToPullRequestReviewThread: async (input) => {
            replyCalls.push(`reply:${input.threadId}`);
            return reviewThread({
              comments: [
                {
                  id: 'comment-2',
                  databaseId: 112,
                  authorLogin: 'neon',
                  body: input.body,
                  url: null,
                  path: 'src/app.ts',
                  line: 12,
                  originalLine: 12,
                  diffHunk: '@@',
                  reviewId: 9002,
                  createdAt: '2026-06-30T20:10:00Z',
                  updatedAt: '2026-06-30T20:10:00Z',
                },
              ],
            });
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'github_pr_thread_reply_post',
      data: {
        thread: {
          id: 'thread-1',
          pullRequestRepo: 'pandemicsyn/neondeck',
          pullRequestNumber: 123,
        },
      },
    });
    expect(replyCalls).toEqual(['fetch:thread-1', 'reply:thread-1']);

    const resolveCalls: string[] = [];
    await expect(
      postGitHubPrThreadResolution(
        { repo: 'neondeck', prNumber: 123 },
        'thread-1',
        true,
        paths,
        {
          fetchPullRequestReviewThread: async (input) => {
            resolveCalls.push(`fetch:${input.threadId}`);
            return reviewThread();
          },
          resolvePullRequestReviewThread: async (input) => {
            resolveCalls.push(`resolve:${input.threadId}`);
            return reviewThread({ isResolved: true });
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'github_pr_thread_resolve_post',
      data: {
        thread: {
          id: 'thread-1',
          isResolved: true,
        },
      },
    });
    expect(resolveCalls).toEqual(['fetch:thread-1', 'resolve:thread-1']);
  });

  it('preserves omitted review draft fields on partial saves', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      putGitHubPrReviewDraft(
        { repo: 'neondeck', prNumber: 123 },
        {
          headSha: 'head123',
          verdict: 'comment',
          body: 'Initial body',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        draft: {
          verdict: 'comment',
          body: 'Initial body',
        },
      },
    });

    await expect(
      putGitHubPrReviewDraft(
        { repo: 'neondeck', prNumber: 123 },
        {
          headSha: 'head123',
          body: 'Edited body',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        draft: {
          verdict: 'comment',
          body: 'Edited body',
        },
      },
    });

    await expect(
      putGitHubPrReviewDraft(
        { repo: 'neondeck', prNumber: 123 },
        {
          headSha: 'head123',
          verdict: 'request-changes',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        draft: {
          verdict: 'request-changes',
          body: 'Edited body',
        },
      },
    });
  });

  it('validates inputs and reports missing credentials before fetching', async () => {
    delete process.env.GITHUB_TOKEN;
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      refreshPrWatchEventState({ repo: 'neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['GITHUB_TOKEN'],
    });
    process.env.GITHUB_TOKEN = 'token';
    await expect(
      refreshPrWatchEventState({ repo: 'neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['watchId', 'ref', 'repo', 'prNumber'],
    });
    await expect(
      postGitHubPrComment(
        { repo: 'neondeck', prNumber: 123, body: '   ' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'pr_comment',
      message: 'Invalid PR comment input.',
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
}

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}

function prDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
  return {
    number: 123,
    title: 'Test PR',
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/123',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    headRef: 'feature',
    baseRef: 'main',
    baseSha: 'base123',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    updatedAt: '2026-06-30T20:00:00Z',
    ...overrides,
  };
}

function prEventState(
  overrides: Partial<GitHubPullRequestEventState> = {},
): GitHubPullRequestEventState {
  return {
    repo: 'pandemicsyn/neondeck',
    number: 123,
    url: 'https://github.com/pandemicsyn/neondeck/pull/123',
    title: 'Test PR',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    headRef: 'feature',
    baseRef: 'main',
    baseSha: 'base123',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [
      {
        sha: 'head123',
        url: 'https://github.com/pandemicsyn/neondeck/commit/head123',
        authorLogin: 'author',
        committedAt: '2026-06-30T20:00:00Z',
      },
    ],
    reviewThreads: [
      {
        id: 'thread-1',
        isResolved: false,
        isOutdated: false,
        path: 'src/app.ts',
        line: 12,
        comments: [
          {
            id: 'comment-1',
            databaseId: 111,
            authorLogin: 'reviewer',
            body: 'Please adjust this.',
            url: 'https://github.com/pandemicsyn/neondeck/pull/123#discussion_r111',
            path: 'src/app.ts',
            line: 12,
            originalLine: 12,
            diffHunk: '@@',
            reviewId: 9001,
            createdAt: '2026-06-30T20:05:00Z',
            updatedAt: '2026-06-30T20:05:00Z',
          },
        ],
      },
      {
        id: 'thread-2',
        isResolved: true,
        isOutdated: false,
        path: 'src/github.ts',
        line: 8,
        comments: [],
      },
    ],
    requestedChangesReviews: [
      {
        id: 9001,
        nodeId: 'review-9001',
        state: 'CHANGES_REQUESTED',
        authorLogin: 'reviewer',
        submittedAt: '2026-06-30T20:06:00Z',
        commitId: 'head123',
        url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
      },
    ],
    requestedChangesState: {
      active: [
        {
          id: 9001,
          nodeId: 'review-9001',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T20:06:00Z',
          commitId: 'head123',
          url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
        },
      ],
      latestByReviewer: [
        {
          id: 9001,
          nodeId: 'review-9001',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T20:06:00Z',
          commitId: 'head123',
          url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
        },
      ],
      history: [
        {
          id: 9001,
          nodeId: 'review-9001',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T20:06:00Z',
          commitId: 'head123',
          url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
        },
      ],
    },
    checkSuites: [
      {
        id: 5001,
        headSha: overrides.headSha ?? 'head123',
        status: 'completed',
        conclusion: 'success',
        appSlug: 'github-actions',
        url: null,
        htmlUrl: null,
        createdAt: '2026-06-30T20:07:00Z',
        updatedAt: '2026-06-30T20:08:00Z',
      },
    ],
    checkRuns: [
      {
        id: 6001,
        name: 'test',
        headSha: overrides.headSha ?? 'head123',
        status: 'completed',
        conclusion: 'success',
        url: null,
        htmlUrl: null,
        detailsUrl: null,
        startedAt: '2026-06-30T20:07:00Z',
        completedAt: '2026-06-30T20:08:00Z',
      },
    ],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-06-30T20:09:00Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-06-30T20:10:00Z',
    ...overrides,
  };
}

function reviewThread(
  overrides: Partial<GitHubPullRequestReviewThread> = {},
): GitHubPullRequestReviewThread {
  return {
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    originalLine: 12,
    diffSide: 'RIGHT',
    pullRequestRepo: 'pandemicsyn/neondeck',
    pullRequestNumber: 123,
    comments: [],
    ...overrides,
  };
}
