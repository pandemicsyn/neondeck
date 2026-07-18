import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import { errorMessage } from './errors';
import {
  fetchPullRequestDetail,
  fetchPullRequestFiles,
  summarizePullRequestFiles,
} from './pull-requests';
import { githubPullRequestFileSchema } from './schemas';
import type { GitHubPullRequestFile, GitHubPullRequestFiles } from './schemas';

const CACHE_ROWS_PER_PULL_REQUEST = 3;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type CacheRow = {
  payload: string;
  fetched_at: string;
};

type PullRequestHeadShaFetcher = (options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}) => Promise<string | null | undefined>;

export async function fetchPullRequestFilesWithCache(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  headSha?: string | null;
  baseSha?: string | null;
  patches?: 'all' | 'none';
  databasePath: string;
  fetcher?: typeof fetchPullRequestFiles;
  fetchHeadSha?: PullRequestHeadShaFetcher;
  now?: Date;
}): Promise<GitHubPullRequestFiles> {
  const fetcher = options.fetcher ?? fetchPullRequestFiles;
  const fetchHeadSha = options.fetchHeadSha ?? fetchCurrentPullRequestHeadSha;
  const repoFullName = `${options.owner}/${options.repo}`;
  const headSha = options.headSha?.trim() || null;
  const baseSha = options.baseSha?.trim() || null;
  if (!headSha) {
    return maybeStripPatches(
      await fetcher({
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        number: options.number,
      }),
      options.patches,
    );
  }

  const cached = baseSha
    ? readCachedPullRequestFiles({
        databasePath: options.databasePath,
        repo: repoFullName,
        number: options.number,
        headSha,
        baseSha,
      })
    : null;
  if (cached) return maybeStripPatches(cached, options.patches);

  const request = {
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    number: options.number,
  };
  const diff = await fetcher(request);
  let currentHeadSha: string | null | undefined = null;
  try {
    currentHeadSha = await fetchHeadSha(request);
  } catch (error) {
    throw new Error(
      `Could not verify the current head for ${repoFullName}#${options.number}: ${errorMessage(error)}`,
    );
  }
  if (currentHeadSha !== headSha) {
    throw new Error(
      `Pull request head changed from ${headSha} to ${currentHeadSha ?? 'unavailable'} while loading files.`,
    );
  }
  if (diff.files.length > 0 && baseSha) {
    writeCachedPullRequestFiles({
      databasePath: options.databasePath,
      repo: repoFullName,
      number: options.number,
      headSha,
      baseSha,
      files: diff.files,
      fetchedAt: diff.fetchedAt,
      now: options.now ?? new Date(),
    });
  }

  return maybeStripPatches(diff, options.patches);
}

export function stripPullRequestPatches(
  diff: GitHubPullRequestFiles,
): GitHubPullRequestFiles {
  return {
    ...diff,
    files: diff.files.map((file) => ({
      ...file,
      patch: null,
      message: file.message,
    })),
  };
}

function maybeStripPatches(
  diff: GitHubPullRequestFiles,
  patches: 'all' | 'none' | undefined,
) {
  return patches === 'none' ? stripPullRequestPatches(diff) : diff;
}

async function fetchCurrentPullRequestHeadSha(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}) {
  const detail = await fetchPullRequestDetail(options);
  return detail.headSha;
}

export function readCachedPullRequestFiles(options: {
  databasePath: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
}): GitHubPullRequestFiles | null {
  const revisionCacheKey = pullRequestRevisionCacheKey(options);
  const database = openDb(options.databasePath);
  try {
    const row = database
      .prepare(
        `
          SELECT payload, fetched_at
          FROM github_pr_file_cache
          WHERE repo = ?
            AND pr_number = ?
            AND head_sha = ?
        `,
      )
      .get(options.repo, options.number, revisionCacheKey) as
      CacheRow | undefined;
    if (!row) return null;

    const files = parseCachedFiles(row.payload);
    if (!files) {
      deleteCachedPullRequestFiles(database, {
        ...options,
        revisionCacheKey,
      });
      return null;
    }

    return {
      repo: options.repo,
      number: options.number,
      files,
      diffSummary: summarizePullRequestFiles(files),
      fetchedAt: row.fetched_at,
    };
  } finally {
    database.close();
  }
}

function writeCachedPullRequestFiles(options: {
  databasePath: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  files: GitHubPullRequestFile[];
  fetchedAt: string;
  now: Date;
}) {
  const revisionCacheKey = pullRequestRevisionCacheKey(options);
  const payload = JSON.stringify(options.files);
  const database = openDb(options.databasePath);
  try {
    database
      .prepare(
        `
          INSERT OR REPLACE INTO github_pr_file_cache (
            repo,
            pr_number,
            head_sha,
            payload,
            byte_size,
            fetched_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        options.repo,
        options.number,
        revisionCacheKey,
        payload,
        Buffer.byteLength(payload, 'utf8'),
        options.fetchedAt,
      );
    prunePullRequestFileCache(
      database,
      options.repo,
      options.number,
      options.now,
    );
  } finally {
    database.close();
  }
}

function parseCachedFiles(payload: string): GitHubPullRequestFile[] | null {
  try {
    return v.parse(v.array(githubPullRequestFileSchema), JSON.parse(payload));
  } catch {
    return null;
  }
}

function deleteCachedPullRequestFiles(
  database: ReturnType<typeof openDb>,
  options: { repo: string; number: number; revisionCacheKey: string },
) {
  database
    .prepare(
      `
        DELETE FROM github_pr_file_cache
        WHERE repo = ?
          AND pr_number = ?
          AND head_sha = ?
      `,
    )
    .run(options.repo, options.number, options.revisionCacheKey);
}

function pullRequestRevisionCacheKey(options: {
  baseSha: string;
  headSha: string;
}) {
  return `revision-v2:${options.baseSha}:${options.headSha}`;
}

function prunePullRequestFileCache(
  database: ReturnType<typeof openDb>,
  repo: string,
  number: number,
  now: Date,
) {
  const cutoff = new Date(now.getTime() - CACHE_MAX_AGE_MS).toISOString();
  database
    .prepare(
      `
        DELETE FROM github_pr_file_cache
        WHERE fetched_at < ?
      `,
    )
    .run(cutoff);
  database
    .prepare(
      `
        DELETE FROM github_pr_file_cache
        WHERE repo = ?
          AND pr_number = ?
          AND head_sha NOT IN (
            SELECT head_sha
            FROM github_pr_file_cache
            WHERE repo = ?
              AND pr_number = ?
            ORDER BY fetched_at DESC, head_sha DESC
            LIMIT ?
          )
      `,
    )
    .run(repo, number, repo, number, CACHE_ROWS_PER_PULL_REQUEST);
}
