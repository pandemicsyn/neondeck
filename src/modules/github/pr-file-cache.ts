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
  databasePath: string;
  fetcher?: typeof fetchPullRequestFiles;
  fetchHeadSha?: PullRequestHeadShaFetcher;
  now?: Date;
}): Promise<GitHubPullRequestFiles> {
  const fetcher = options.fetcher ?? fetchPullRequestFiles;
  const fetchHeadSha = options.fetchHeadSha ?? fetchCurrentPullRequestHeadSha;
  const repoFullName = `${options.owner}/${options.repo}`;
  const headSha = options.headSha?.trim() || null;
  if (!headSha) {
    return fetcher({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      number: options.number,
    });
  }

  const cached = readCachedPullRequestFiles({
    databasePath: options.databasePath,
    repo: repoFullName,
    number: options.number,
    headSha,
  });
  if (cached) return cached;

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
    console.warn(
      `[neondeck] Skipping GitHub PR file cache write because head verification failed for ${repoFullName}#${options.number}: ${errorMessage(error)}`,
    );
  }
  if (diff.files.length > 0 && currentHeadSha === headSha) {
    writeCachedPullRequestFiles({
      databasePath: options.databasePath,
      repo: repoFullName,
      number: options.number,
      headSha,
      files: diff.files,
      fetchedAt: diff.fetchedAt,
      now: options.now ?? new Date(),
    });
  }

  return diff;
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
}): GitHubPullRequestFiles | null {
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
      .get(options.repo, options.number, options.headSha) as
      CacheRow | undefined;
    if (!row) return null;

    const files = parseCachedFiles(row.payload);
    if (!files) {
      deleteCachedPullRequestFiles(database, options);
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
  files: GitHubPullRequestFile[];
  fetchedAt: string;
  now: Date;
}) {
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
        options.headSha,
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
  options: { repo: string; number: number; headSha: string },
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
    .run(options.repo, options.number, options.headSha);
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
