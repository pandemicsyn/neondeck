import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { listGitHubPrQueue } from './actions';
import type { GitHubPullRequestQueue } from './schemas';
import {
  clearGitHubQueueSnapshotsForTests,
  githubQueueRefreshIntervalMs,
  readGitHubQueueSnapshot,
  refreshGitHubQueueSnapshot,
  subscribeGitHubQueueSnapshotEvents,
} from './queue-snapshot';

describe('GitHub queue snapshot', () => {
  beforeEach(() => {
    clearGitHubQueueSnapshotsForTests();
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('refreshes once within the three-minute cache window', async () => {
    const paths = runtimePaths('/tmp/neondeck-github-snapshot-cache');
    const list = vi.fn<typeof listGitHubPrQueue>(async () =>
      queueResult(queue('First')),
    );

    await refreshGitHubQueueSnapshot(paths, {
      listGitHubPrQueue: list,
      now: () => new Date('2026-07-23T15:00:00.000Z'),
    });
    await refreshGitHubQueueSnapshot(paths, {
      listGitHubPrQueue: list,
      now: () =>
        new Date(
          Date.parse('2026-07-23T15:00:00.000Z') +
            githubQueueRefreshIntervalMs -
            1,
        ),
    });

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('retains the last complete queue when a later search is partial', async () => {
    const paths = runtimePaths('/tmp/neondeck-github-snapshot-partial');
    const complete = queue('Known PR');
    const partial = {
      ...queue('Partial PR'),
      issues: [
        {
          type: 'search-error' as const,
          query: 'is:pr repo:owner/repo',
          message: 'GitHub timed out.',
        },
      ],
    };
    const list = vi
      .fn<typeof listGitHubPrQueue>()
      .mockResolvedValueOnce(queueResult(complete))
      .mockResolvedValueOnce(queueResult(partial));

    await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:00:00.000Z'),
      },
      { force: true },
    );
    const refreshed = await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:04:00.000Z'),
      },
      { force: true },
    );

    expect(refreshed.snapshot.status).toBe('degraded');
    expect(refreshed.snapshot.items).toEqual(complete.items);
    expect(refreshed.snapshot.lastCompleteAt).toBe('2026-07-23T15:00:00.000Z');
  });

  it('retains the last complete queue when GitHub reports incomplete search results', async () => {
    const paths = runtimePaths('/tmp/neondeck-github-snapshot-incomplete');
    const complete = queue('Known PR');
    const incomplete = {
      ...queue('Incomplete PR'),
      truncated: true,
      issues: [
        {
          type: 'search-incomplete' as const,
          query: 'is:pr repo:owner/repo',
          message: 'GitHub reported incomplete search results.',
        },
      ],
    };
    const list = vi
      .fn<typeof listGitHubPrQueue>()
      .mockResolvedValueOnce(queueResult(complete))
      .mockResolvedValueOnce(queueResult(incomplete));

    await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:00:00.000Z'),
      },
      { force: true },
    );
    const refreshed = await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:04:00.000Z'),
      },
      { force: true },
    );

    expect(refreshed.snapshot.status).toBe('degraded');
    expect(refreshed.snapshot.items).toEqual(complete.items);
    expect(refreshed.snapshot.lastCompleteAt).toBe('2026-07-23T15:00:00.000Z');
  });

  it('emits only when queue contents or health materially change', async () => {
    const paths = runtimePaths('/tmp/neondeck-github-snapshot-events');
    const events: unknown[] = [];
    const unsubscribe = subscribeGitHubQueueSnapshotEvents((event) =>
      events.push(event),
    );
    const list = vi.fn<typeof listGitHubPrQueue>(async () =>
      queueResult(queue('Stable PR')),
    );

    await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:00:00.000Z'),
      },
      { force: true },
    );
    await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: list,
        now: () => new Date('2026-07-23T15:04:00.000Z'),
      },
      { force: true },
    );

    expect(events).toHaveLength(1);
    expect(readGitHubQueueSnapshot(paths).lastAttemptAt).toBe(
      '2026-07-23T15:04:00.000Z',
    );
    unsubscribe();
  });

  it('retains valid queue items when a sibling item is malformed', async () => {
    const paths = runtimePaths('/tmp/neondeck-github-snapshot-mixed');
    const mixed = queue('Valid PR');
    mixed.items.push({ id: 'malformed' } as never);

    const refreshed = await refreshGitHubQueueSnapshot(
      paths,
      {
        listGitHubPrQueue: vi.fn<typeof listGitHubPrQueue>(async () =>
          queueResult(mixed),
        ),
        now: () => new Date('2026-07-23T15:00:00.000Z'),
      },
      { force: true },
    );

    expect(refreshed.snapshot.status).toBe('degraded');
    expect(refreshed.snapshot.truncated).toBe(true);
    expect(refreshed.snapshot.issues).toEqual([
      expect.objectContaining({
        type: 'enrichment-error',
        message: expect.stringContaining('Skipped 1 malformed'),
      }),
    ]);
    expect(refreshed.snapshot.items.map((item) => item.title)).toEqual([
      'Valid PR',
    ]);
  });
});

function queue(title: string): GitHubPullRequestQueue {
  return {
    login: 'syn',
    repos: ['owner/repo'],
    fetchedAt: '2026-07-23T15:00:00.000Z',
    truncated: false,
    issues: [],
    items: [
      {
        id: 1,
        title,
        repo: 'owner/repo',
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        state: 'open',
        draft: false,
        author: 'syn',
        labels: [],
        comments: 0,
        updatedAt: '2026-07-23T14:00:00.000Z',
        createdAt: '2026-07-23T13:00:00.000Z',
        relations: ['authored'],
        ageDays: 0,
        stale: false,
        headSha: 'head',
        baseSha: 'base',
        baseRef: 'main',
        checks: {
          status: 'success',
          total: 1,
          successful: 1,
          failed: 0,
          pending: 0,
          checkedAt: '2026-07-23T15:00:00.000Z',
        },
      },
    ],
  };
}

function queueResult(queueValue: GitHubPullRequestQueue) {
  return {
    ok: true,
    action: 'github_pr_queue_list',
    changed: false as const,
    message: 'Fetched queue.',
    data: { queue: queueValue },
  } as Awaited<ReturnType<typeof listGitHubPrQueue>>;
}
