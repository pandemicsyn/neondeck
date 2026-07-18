import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPullRequestFilesWithCache,
  type GitHubDiffSummary,
  type GitHubPullRequestFile,
  type GitHubPullRequestFiles,
} from './modules/github';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('GitHub PR file cache', () => {
  it('stores misses and serves hits without calling GitHub', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const files = [
      prFile({
        path: 'src/app.ts',
        additions: 2,
        deletions: 1,
        changes: 3,
        patch:
          'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      }),
    ];
    const fetched = prFiles(files, '2026-07-05T14:00:00.000Z');
    const callOrder: string[] = [];
    const missFetcher = vi.fn<() => Promise<GitHubPullRequestFiles>>(
      async () => {
        callOrder.push('files');
        return fetched;
      },
    );
    const headFetcher = vi.fn<() => Promise<string>>(async () => {
      callOrder.push('head');
      return 'head123';
    });

    const miss = await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'head123',
      databasePath: paths.neondeckDatabase,
      fetcher: missFetcher,
      fetchHeadSha: headFetcher,
      now: new Date('2026-07-05T14:00:00.000Z'),
    });

    expect(missFetcher).toHaveBeenCalledTimes(1);
    expect(headFetcher).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['files', 'head']);
    expect(miss).toEqual(fetched);
    const rows = readCacheRows(paths.neondeckDatabase);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: 'pandemicsyn/neondeck',
      pr_number: 123,
      head_sha: 'head123',
      fetched_at: fetched.fetchedAt,
    });
    expect(rows[0]?.payload).toBe(JSON.stringify(files));
    expect(rows[0]?.byte_size).toBe(
      Buffer.byteLength(JSON.stringify(files), 'utf8'),
    );

    const hitFetcher = vi.fn<() => Promise<GitHubPullRequestFiles>>(
      async () => {
        throw new Error('cache hit should not fetch');
      },
    );
    const hit = await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'head123',
      databasePath: paths.neondeckDatabase,
      fetcher: hitFetcher,
      fetchHeadSha: headFetcher,
    });

    expect(hitFetcher).not.toHaveBeenCalled();
    expect(headFetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hit.files)).toBe(rows[0]?.payload);
    expect(hit).toEqual(fetched);
  });

  it('serves patchless responses without stripping the cached payload', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const files = [
      prFile({
        path: 'src/app.ts',
        patch:
          'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      }),
    ];
    const fetched = prFiles(files, '2026-07-05T14:00:00.000Z');

    const miss = await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'head123',
      patches: 'none',
      databasePath: paths.neondeckDatabase,
      fetcher: async () => fetched,
      fetchHeadSha: async () => 'head123',
      now: new Date('2026-07-05T14:00:00.000Z'),
    });

    expect(miss.files[0]?.patch).toBeNull();
    expect(readCacheRows(paths.neondeckDatabase)[0]?.payload).toBe(
      JSON.stringify(files),
    );

    const hit = await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'head123',
      patches: 'none',
      databasePath: paths.neondeckDatabase,
      fetcher: async () => {
        throw new Error('cache hit should not fetch');
      },
    });

    expect(hit.files[0]?.patch).toBeNull();
    expect(hit.diffSummary).toEqual(fetched.diffSummary);
  });

  it('bypasses the cache without a head SHA and skips empty file lists', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const empty = prFiles([], '2026-07-05T14:00:00.000Z');
    const headlessFetcher = vi.fn<() => Promise<GitHubPullRequestFiles>>(
      async () => empty,
    );

    await expect(
      fetchPullRequestFilesWithCache({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        headSha: null,
        databasePath: paths.neondeckDatabase,
        fetcher: headlessFetcher,
      }),
    ).resolves.toEqual(empty);

    expect(headlessFetcher).toHaveBeenCalledTimes(1);
    expect(readCacheRows(paths.neondeckDatabase)).toEqual([]);

    const emptyFetcher = vi.fn<() => Promise<GitHubPullRequestFiles>>(
      async () => empty,
    );
    await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'empty-head',
      databasePath: paths.neondeckDatabase,
      fetcher: emptyFetcher,
      fetchHeadSha: async () => 'empty-head',
    });
    await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 123,
      headSha: 'empty-head',
      databasePath: paths.neondeckDatabase,
      fetcher: emptyFetcher,
      fetchHeadSha: async () => 'empty-head',
    });

    expect(emptyFetcher).toHaveBeenCalledTimes(2);
    expect(readCacheRows(paths.neondeckDatabase)).toEqual([]);
  });

  it('prunes to the newest three cached heads per pull request', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);

    for (let index = 0; index < 4; index += 1) {
      const date = `2026-07-0${index + 1}T12:00:00.000Z`;
      await fetchPullRequestFilesWithCache({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        headSha: `head-${index}`,
        databasePath: paths.neondeckDatabase,
        fetcher: async () =>
          prFiles([prFile({ path: `src/file-${index}.ts` })], date),
        fetchHeadSha: async () => `head-${index}`,
        now: new Date('2026-07-10T00:00:00.000Z'),
      });
    }
    await fetchPullRequestFilesWithCache({
      token: 'token',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 124,
      headSha: 'other-pr-head',
      databasePath: paths.neondeckDatabase,
      fetcher: async () =>
        prFiles([prFile({ path: 'src/other.ts' })], '2026-07-04T12:00:00.000Z'),
      fetchHeadSha: async () => 'other-pr-head',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });

    expect(
      readCacheRows(paths.neondeckDatabase)
        .filter((row) => row.pr_number === 123)
        .map((row) => row.head_sha),
    ).toEqual(['head-1', 'head-2', 'head-3']);
    expect(
      readCacheRows(paths.neondeckDatabase).some(
        (row) => row.pr_number === 124 && row.head_sha === 'other-pr-head',
      ),
    ).toBe(true);
  });

  it('rejects misses when the supplied head SHA is stale', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const first = prFiles(
      [prFile({ path: 'src/first.ts' })],
      '2026-07-05T14:00:00.000Z',
    );
    const second = prFiles(
      [prFile({ path: 'src/second.ts' })],
      '2026-07-05T14:01:00.000Z',
    );
    const fetcher = vi
      .fn<() => Promise<GitHubPullRequestFiles>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const headFetcher = vi.fn<() => Promise<string>>(
      async () => 'current-head',
    );

    await expect(
      fetchPullRequestFilesWithCache({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        headSha: 'stale-head',
        databasePath: paths.neondeckDatabase,
        fetcher,
        fetchHeadSha: headFetcher,
      }),
    ).rejects.toThrow('Pull request head changed');
    await expect(
      fetchPullRequestFilesWithCache({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        headSha: 'stale-head',
        databasePath: paths.neondeckDatabase,
        fetcher,
        fetchHeadSha: headFetcher,
      }),
    ).rejects.toThrow('Pull request head changed');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(headFetcher).toHaveBeenCalledTimes(2);
    expect(readCacheRows(paths.neondeckDatabase)).toEqual([]);
  });

  it('rejects an unverified response when head verification fails', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const fetched = prFiles(
      [prFile({ path: 'src/unverified.ts' })],
      '2026-07-05T14:00:00.000Z',
    );
    await expect(
      fetchPullRequestFilesWithCache({
        token: 'token',
        owner: 'pandemicsyn',
        repo: 'neondeck',
        number: 123,
        headSha: 'head123',
        databasePath: paths.neondeckDatabase,
        fetcher: async () => fetched,
        fetchHeadSha: async () => {
          throw new Error('GitHub timeout');
        },
      }),
    ).rejects.toThrow('Could not verify the current head');

    expect(readCacheRows(paths.neondeckDatabase)).toEqual([]);
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
}

function prFile(
  overrides: Partial<GitHubPullRequestFile> = {},
): GitHubPullRequestFile {
  return {
    path: 'src/app.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    binary: false,
    generatedLike: false,
    patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n+line\n',
    truncated: false,
    sha: 'sha',
    htmlUrl: null,
    rawUrl: null,
    contentsUrl: null,
    message: null,
    ...overrides,
  };
}

function prFiles(
  files: GitHubPullRequestFile[],
  fetchedAt: string,
): GitHubPullRequestFiles {
  return {
    repo: 'pandemicsyn/neondeck',
    number: 123,
    files,
    diffSummary: summarize(files),
    fetchedAt,
  };
}

function summarize(files: GitHubPullRequestFile[]): GitHubDiffSummary {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    binaryFiles: files.filter((file) => file.binary).length,
  };
}

type CacheRow = {
  repo: string;
  pr_number: number;
  head_sha: string;
  payload: string;
  byte_size: number;
  fetched_at: string;
};

function readCacheRows(databasePath: string): CacheRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `
          SELECT repo, pr_number, head_sha, payload, byte_size, fetched_at
          FROM github_pr_file_cache
          ORDER BY pr_number ASC, fetched_at ASC
        `,
      )
      .all() as CacheRow[];
  } finally {
    database.close();
  }
}
