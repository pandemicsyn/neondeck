import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  fetchPullRequestFiles,
  fetchPullRequestFilesWithCache,
  fetchPullRequestReviewSurfaceThreadsFreshWithMetadata,
  fetchPullRequestReviewSurfaceThreadsWithMetadata,
  fetchPullRequestReviewThreadsWithMetadata,
  type GitHubPullRequestReviewThread,
} from '../github';
import {
  readLocalPullRequestFileDiff,
  readLocalPullRequestFiles,
} from '../pr-local-diffs';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  prEventTargetInputSchema,
  prFileDiffInputSchema,
  prFilesInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
} from './schemas';
import {
  resolvedReviewRevision,
  unavailableReviewRevision,
} from '../../../shared/review-source';
import { fetchEventState, resolvePullRequestTarget } from './target';
import { errorMessage, eventTargetJson, failResult, okResult } from './utils';

export async function getGitHubPrEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_event_state_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_event_state_get',
    false,
    `Fetched PR event state for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      state: resolved.state as unknown as JsonValue,
    },
  );
}

export async function getGitHubPrReviewThreads(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
  options: {
    signal?: AbortSignal;
    surface?: boolean;
    fresh?: boolean;
  } = {},
): Promise<PrEventActionResult> {
  const action = 'github_pr_review_threads_get';
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return failResult(action, 'Invalid PR review threads input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(action, 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const resolved = await resolvePullRequestTarget(parsed.output, paths, action);
  if (!resolved.ok) return resolved.result;

  let threads: GitHubPullRequestReviewThread[];
  let truncated = false;
  let headSha: string | null = null;
  try {
    const fetcher =
      dependencies.fetchPullRequestReviewThreads ??
      (options.surface
        ? options.fresh
          ? fetchPullRequestReviewSurfaceThreadsFreshWithMetadata
          : fetchPullRequestReviewSurfaceThreadsWithMetadata
        : fetchPullRequestReviewThreadsWithMetadata);
    const result = await fetcher({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      signal: options.signal,
    });
    threads = result.reviewThreads;
    headSha = result.headSha ?? null;
    truncated =
      result.truncated || threads.some((thread) => thread.commentsTruncated);
  } catch (error) {
    return failResult(action, 'Could not fetch GitHub PR review threads.', {
      errors: [errorMessage(error)],
    });
  }

  const unresolvedThreads = threads.filter((thread) => !thread.isResolved);
  const unresolvedReviewComments = unresolvedThreads.flatMap((thread) =>
    thread.comments.map((comment) => ({
      ...comment,
      threadId: thread.id,
      threadPath: thread.path,
      threadLine: thread.line,
      threadIsOutdated: thread.isOutdated,
    })),
  );

  return okResult(
    action,
    false,
    `Fetched ${threads.length} review thread(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    options.surface
      ? {
          headSha,
          reviewThreads: threads as unknown as JsonValue,
          reviewThreadsTruncated: truncated,
        }
      : {
          target: eventTargetJson(resolved.target),
          headSha,
          reviewThreads: threads as unknown as JsonValue,
          reviewThreadsTruncated: truncated,
          unresolvedReviewThreads: unresolvedThreads as unknown as JsonValue,
          unresolvedReviewComments:
            unresolvedReviewComments as unknown as JsonValue,
        },
  );
}

export async function getGitHubPrFiles(
  input: v.InferInput<typeof prFilesInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prFilesInputSchema, input);
  if (!parsed.success) {
    return failResult('github_pr_files_get', 'Invalid PR files input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const resolved = await resolvePullRequestTarget(
    {
      watchId: parsed.output.watchId,
      ref: parsed.output.ref,
      repo: parsed.output.repo,
      prNumber: parsed.output.prNumber,
    },
    paths,
    'github_pr_files_get',
  );
  if (!resolved.ok) return resolved.result;

  const patches = parsed.output.patches ?? 'all';
  const source = parsed.output.source ?? 'auto';
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  const localErrorMessages: string[] = [];
  if (source !== 'github') {
    try {
      const diff = await readLocalPullRequestFiles(
        {
          owner: resolved.target.owner,
          repo: resolved.target.repo,
          number: resolved.target.number,
          headSha: parsed.output.headSha ?? null,
          baseSha: parsed.output.baseSha ?? null,
          baseRef: parsed.output.baseRef ?? null,
          includePatches: patches === 'all',
        },
        paths,
      );

      return okResult(
        'github_pr_files_get',
        false,
        `Fetched ${diff.files.length} local PR file diff(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
        {
          target: eventTargetJson(resolved.target),
          files: diff.files as unknown as JsonValue,
          diffSummary: diff.diffSummary as unknown as JsonValue,
          fetchedAt: diff.fetchedAt,
          source: 'local',
          revision: githubFileRevision(parsed.output),
        },
      );
    } catch (error) {
      localErrorMessages.push(errorMessage(error));
      if (source === 'local') {
        return failResult(
          'github_pr_files_get',
          'Could not fetch local PR files.',
          { errors: localErrorMessages },
        );
      }
    }
  }

  if (!token) {
    return failResult(
      'github_pr_files_get',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
        errors: localErrorMessages.length ? localErrorMessages : undefined,
      },
    );
  }

  try {
    const fetcher = dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles;
    const diff = await fetchPullRequestFilesWithCache({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      headSha: parsed.output.headSha ?? null,
      baseSha: parsed.output.baseSha ?? null,
      patches,
      databasePath: paths.neondeckDatabase,
      fetcher,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
      fetchRevision: dependencies.fetchPullRequestRevision,
    });

    return okResult(
      'github_pr_files_get',
      false,
      `Fetched ${diff.files.length} PR file diff(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        files: diff.files as unknown as JsonValue,
        diffSummary: diff.diffSummary as unknown as JsonValue,
        fetchedAt: diff.fetchedAt,
        source: 'github',
        revision: githubFileRevision(parsed.output),
      },
    );
  } catch (error) {
    return failResult(
      'github_pr_files_get',
      'Could not fetch GitHub PR files.',
      {
        errors: [errorMessage(error)],
      },
    );
  }
}

export async function getGitHubPrFileDiff(
  input: v.InferInput<typeof prFileDiffInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prFileDiffInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'github_pr_file_diff_get',
      'Invalid PR file diff input.',
      {
        errors: [v.summarize(parsed.issues)],
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    {
      watchId: parsed.output.watchId,
      ref: parsed.output.ref,
      repo: parsed.output.repo,
      prNumber: parsed.output.prNumber,
    },
    paths,
    'github_pr_file_diff_get',
  );
  if (!resolved.ok) return resolved.result;

  const source = parsed.output.source ?? 'auto';
  const localErrorMessages: string[] = [];
  if (source !== 'github') {
    try {
      const diff = await readLocalPullRequestFileDiff(
        {
          owner: resolved.target.owner,
          repo: resolved.target.repo,
          number: resolved.target.number,
          headSha: parsed.output.headSha ?? null,
          baseSha: parsed.output.baseSha ?? null,
          baseRef: parsed.output.baseRef ?? null,
          path: parsed.output.path,
          maxPatchBytes: parsed.output.maxPatchBytes,
        },
        paths,
      );
      return okResult(
        'github_pr_file_diff_get',
        false,
        diff.file
          ? `Read local PR diff for ${parsed.output.path}.`
          : `No local PR diff found for ${parsed.output.path}.`,
        {
          target: eventTargetJson(resolved.target),
          file: diff.file as unknown as JsonValue,
          diff: diff.diff,
          diffSummary: diff.diffSummary as unknown as JsonValue,
          fetchedAt: diff.fetchedAt,
          source: 'local',
          revision: githubFileRevision(parsed.output),
        },
      );
    } catch (error) {
      localErrorMessages.push(errorMessage(error));
      if (source === 'local') {
        return failResult(
          'github_pr_file_diff_get',
          'Could not fetch local PR file diff.',
          { errors: localErrorMessages },
        );
      }
    }
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pr_file_diff_get',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
        errors: localErrorMessages.length ? localErrorMessages : undefined,
      },
    );
  }

  try {
    const diff = await fetchPullRequestFilesWithCache({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      headSha: parsed.output.headSha ?? null,
      baseSha: parsed.output.baseSha ?? null,
      patches: 'all',
      databasePath: paths.neondeckDatabase,
      fetcher: dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
      fetchRevision: dependencies.fetchPullRequestRevision,
    });
    const file =
      diff.files.find((item) => item.path === parsed.output.path) ?? null;
    return okResult(
      'github_pr_file_diff_get',
      false,
      file
        ? `Read GitHub PR diff for ${parsed.output.path}.`
        : `No GitHub PR diff found for ${parsed.output.path}.`,
      {
        target: eventTargetJson(resolved.target),
        file: file as unknown as JsonValue,
        diff: file?.patch ?? '',
        diffSummary: diff.diffSummary as unknown as JsonValue,
        fetchedAt: diff.fetchedAt,
        source: 'github',
        revision: githubFileRevision(parsed.output),
      },
    );
  } catch (error) {
    return failResult(
      'github_pr_file_diff_get',
      'Could not fetch GitHub PR file diff.',
      {
        errors: [errorMessage(error)],
      },
    );
  }
}

function githubFileRevision(input: {
  headSha?: string | null;
  baseSha?: string | null;
}) {
  const headSha = input.headSha?.trim();
  return headSha
    ? resolvedReviewRevision({
        kind: 'git-commit',
        id: headSha,
        baseId: input.baseSha?.trim() || null,
      })
    : unavailableReviewRevision(
        'git-commit',
        'The PR file response was not requested with a head SHA.',
      );
}

export async function getGitHubPrRequestedChanges(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_requested_changes_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_requested_changes_get',
    false,
    `Fetched ${resolved.state.requestedChangesReviews.length} requested-changes review(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      requestedChangesReviews: resolved.state
        .requestedChangesReviews as unknown as JsonValue,
      requestedChangesState: resolved.state
        .requestedChangesState as unknown as JsonValue,
    },
  );
}

export async function getGitHubPrBranchPermissions(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_branch_permissions_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_branch_permissions_get',
    false,
    `Fetched branch permission facts for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      branchPermissions: resolved.state
        .branchPermissions as unknown as JsonValue,
    },
  );
}
