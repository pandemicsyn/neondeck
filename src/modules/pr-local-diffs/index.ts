import { runUnattendedGit } from '../../lib/git';
import {
  gitDiff,
  type RepoDiffFile,
  type RepoDiffResult,
} from '../../repo-edit/git';
import {
  ensureRuntimeHome,
  parseRepoRegistry,
  type RepoConfig,
  type RuntimePaths,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import type {
  GitHubDiffSummary,
  GitHubPullRequestFile,
  GitHubPullRequestFiles,
} from '../github';
import { repoFullName } from '../repos';

export type PrDiffSource = 'auto' | 'local' | 'github';

export class LocalPrDiffUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalPrDiffUnavailableError';
  }
}

export type LocalPullRequestDiffInput = {
  owner: string;
  repo: string;
  number: number;
  headSha?: string | null;
  baseSha?: string | null;
  baseRef?: string | null;
  includePatches?: boolean;
  paths?: string[];
  maxPatchBytes?: number;
};

const fetchFlights = new Map<string, Promise<void>>();
const metadataFlights = new Map<string, Promise<CachedRevisionMetadata>>();
const metadataCache = new Map<string, CachedRevisionMetadata>();
const metadataCacheMaxEntries = 8;
const metadataCacheTtlMs = 10 * 60 * 1_000;

type LocalPullRequestRevision = {
  repo: RepoConfig;
  head: string;
  mergeBase: string;
};

type CachedRevisionMetadata = {
  diff: RepoDiffResult;
  fetchedAt: string;
  expiresAt: number;
};

export async function readLocalPullRequestFiles(
  input: LocalPullRequestDiffInput,
  paths: RuntimePaths = runtimePaths(),
): Promise<GitHubPullRequestFiles> {
  const repo = await resolveRegisteredRepo(input, paths);
  const refs = await resolveLocalPullRequestRefs(repo, input);
  return readResolvedPullRequestFiles(input, { repo, ...refs });
}

export async function readLocalPullRequestFileDiff(
  input: LocalPullRequestDiffInput & { path: string },
  paths: RuntimePaths = runtimePaths(),
): Promise<{
  file: GitHubPullRequestFile | null;
  diff: string;
  diffSummary: GitHubDiffSummary;
  fetchedAt: string;
}> {
  const repo = await resolveRegisteredRepo(input, paths);
  const refs = await resolveLocalPullRequestRefs(repo, input);
  const revision = { repo, ...refs };
  const metadata = await readResolvedPullRequestFiles(
    {
      ...input,
      paths: undefined,
      includePatches: false,
    },
    revision,
  );
  const metadataFile =
    metadata.files.find((item) => item.path === input.path) ?? null;
  const pathspec = [
    ...(metadataFile?.previousPath ? [metadataFile.previousPath] : []),
    input.path,
  ];
  const diff = await readResolvedPullRequestFiles(
    {
      ...input,
      paths: pathspec,
      includePatches: true,
    },
    revision,
  );
  const file =
    diff.files.find((item) => item.path === input.path) ?? metadataFile;
  return {
    file,
    diff: file?.patch ?? '',
    diffSummary: diff.diffSummary,
    fetchedAt: diff.fetchedAt,
  };
}

async function readResolvedPullRequestFiles(
  input: LocalPullRequestDiffInput,
  revision: LocalPullRequestRevision,
): Promise<GitHubPullRequestFiles> {
  const metadataOnly = !(input.includePatches ?? false) && !input.paths?.length;
  const result = metadataOnly
    ? await readRevisionMetadata(revision)
    : {
        diff: await gitDiff(revision.repo.path, {
          base: revision.mergeBase,
          head: revision.head,
          paths: input.paths,
          includePatch: input.includePatches ?? false,
          maxPatchBytes: input.maxPatchBytes,
        }),
        fetchedAt: new Date().toISOString(),
      };
  return {
    repo: repoFullName(revision.repo),
    number: input.number,
    files: result.diff.files.map(toPullRequestFile),
    diffSummary: { ...result.diff.summary },
    fetchedAt: result.fetchedAt,
  };
}

function readRevisionMetadata(revision: LocalPullRequestRevision) {
  const key = metadataKey(revision);
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    metadataCache.delete(key);
    metadataCache.set(key, cached);
    return Promise.resolve(cached);
  }
  if (cached) metadataCache.delete(key);

  const existing = metadataFlights.get(key);
  if (existing) return existing;
  const promise = gitDiff(revision.repo.path, {
    base: revision.mergeBase,
    head: revision.head,
    includePatch: false,
  })
    .then((diff) => {
      const value = {
        diff,
        fetchedAt: new Date().toISOString(),
        expiresAt: Date.now() + metadataCacheTtlMs,
      };
      storeRevisionMetadata(key, value);
      return value;
    })
    .finally(() => metadataFlights.delete(key));
  metadataFlights.set(key, promise);
  return promise;
}

function storeRevisionMetadata(key: string, value: CachedRevisionMetadata) {
  const now = Date.now();
  for (const [cachedKey, cached] of metadataCache) {
    if (cached.expiresAt <= now) metadataCache.delete(cachedKey);
  }
  metadataCache.delete(key);
  metadataCache.set(key, value);
  while (metadataCache.size > metadataCacheMaxEntries) {
    const oldestKey = metadataCache.keys().next().value;
    if (oldestKey === undefined) break;
    metadataCache.delete(oldestKey);
  }
}

function metadataKey(revision: LocalPullRequestRevision) {
  return [revision.repo.path, revision.mergeBase, revision.head].join('\u0000');
}

async function resolveRegisteredRepo(
  input: Pick<LocalPullRequestDiffInput, 'owner' | 'repo'>,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const fullName = `${input.owner}/${input.repo}`.toLowerCase();
  const repo = registry.repos.find(
    (item) => repoFullName(item).toLowerCase() === fullName,
  );
  if (!repo) {
    throw unavailable(
      `Repository ${input.owner}/${input.repo} is not registered locally.`,
    );
  }
  return repo;
}

async function resolveLocalPullRequestRefs(
  repo: RepoConfig,
  input: LocalPullRequestDiffInput,
) {
  const head = normalizeSha(input.headSha, 'head SHA');
  const baseSha = input.baseSha
    ? normalizeSha(input.baseSha, 'base SHA')
    : null;
  const baseRef = input.baseRef ? validateBranchName(input.baseRef) : null;
  if (!head) {
    throw unavailable('A PR head SHA is required for local PR diffs.');
  }
  if (!baseSha && !baseRef) {
    throw unavailable('A base SHA or base ref is required for local PR diffs.');
  }

  const base = baseSha ?? neondeckBaseRef(baseRef!);
  const warmMergeBase = await mergeBase(repo.path, base, head).catch(
    () => null,
  );
  if (warmMergeBase) {
    return { head, mergeBase: warmMergeBase };
  }

  await assertOriginMatches(repo);
  await singleFlight(fetchKey(repo, input, head), async () => {
    const currentMergeBase = await mergeBase(repo.path, base, head).catch(
      () => null,
    );
    if (currentMergeBase) {
      return;
    }

    const refspecs = [
      `+refs/pull/${input.number}/head:refs/neondeck/pull/${input.number}/head`,
    ];
    if (baseRef) {
      refspecs.push(`+refs/heads/${baseRef}:${neondeckBaseRef(baseRef)}`);
    }
    await git(repo.path, [
      'fetch',
      '--no-tags',
      '--refmap=',
      'origin',
      ...refspecs,
    ]);
  });

  const fetchedMergeBase = await mergeBase(repo.path, base, head).catch(
    () => null,
  );
  if (!fetchedMergeBase) {
    throw unavailable(
      `Could not find a merge-base for ${repoFullName(repo)}#${input.number}.`,
    );
  }

  return { head, mergeBase: fetchedMergeBase };
}

async function assertOriginMatches(repo: RepoConfig) {
  const origin = await git(repo.path, [
    'config',
    '--get',
    'remote.origin.url',
  ]).then((output) => output.trim());
  const parsed = parseGitHubRemote(origin);
  if (!parsed) {
    throw unavailable(`Origin remote is not a GitHub repository: ${origin}`);
  }
  const expected = repoFullName(repo).toLowerCase();
  const actual = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  if (actual !== expected) {
    throw unavailable(
      `Origin remote ${actual} does not match configured repo ${expected}.`,
    );
  }
}

function parseGitHubRemote(url: string) {
  const trimmed = url.trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

async function mergeBase(repoPath: string, base: string, head: string) {
  const output = await git(repoPath, ['merge-base', base, head]);
  const value = output.trim();
  if (!value) throw unavailable('Git merge-base returned no commit.');
  return value;
}

function toPullRequestFile(file: RepoDiffFile): GitHubPullRequestFile {
  return {
    path: file.path,
    previousPath: file.previousPath ?? null,
    status: normalizeStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    binary: file.binary,
    generatedLike: file.generatedLike,
    patch: file.patch ?? null,
    truncated: file.truncated ?? false,
    sha: null,
    htmlUrl: null,
    rawUrl: null,
    contentsUrl: null,
    message: missingPatchMessage(file),
  };
}

function normalizeStatus(status: string) {
  const code = status.toUpperCase();
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'removed';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  return 'modified';
}

function missingPatchMessage(file: RepoDiffFile) {
  if (file.patch) return null;
  if (file.truncated)
    return 'Local git patch exceeded the configured size limit.';
  if (file.binary) return 'Local git identified this as a binary file.';
  return null;
}

function normalizeSha(value: string | null | undefined, label: string) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (!/^[0-9a-f]{40}$/i.test(trimmed)) {
    throw unavailable(`Invalid PR ${label}.`);
  }
  return trimmed;
}

function validateBranchName(value: string) {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.includes('\u0000') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    /[\s\\~^:?*[\]]/.test(trimmed)
  ) {
    throw unavailable(`Invalid PR base ref: ${value}`);
  }
  return trimmed;
}

function neondeckBaseRef(baseRef: string) {
  return `refs/neondeck/base/${baseRef}`;
}

function fetchKey(
  repo: RepoConfig,
  input: LocalPullRequestDiffInput,
  head: string,
) {
  return [
    repo.path,
    input.number,
    head,
    input.baseSha ?? '',
    input.baseRef ?? '',
  ].join('\u0000');
}

async function singleFlight(key: string, fn: () => Promise<void>) {
  const existing = fetchFlights.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => fetchFlights.delete(key));
  fetchFlights.set(key, promise);
  return promise;
}

async function git(cwd: string, args: string[]) {
  try {
    return await runUnattendedGit(cwd, args, {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw unavailable(errorMessage(error));
  }
}

function unavailable(message: string) {
  return new LocalPrDiffUnavailableError(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
