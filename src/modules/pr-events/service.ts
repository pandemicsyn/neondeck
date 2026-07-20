/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  addPrReviewDraftComment,
  deletePrReviewDraftComment,
  discardPrReviewDraft,
  fetchPullRequestEventState,
  fetchPullRequestFiles,
  fetchPullRequestFilesWithCache,
  fetchPullRequestReviewComments,
  fetchPullRequestReviewSurfaceThreadsWithMetadata,
  fetchPullRequestReviewThreadsWithMetadata,
  fetchPullRequestReviewThread,
  GitHubPrReviewSubmitError,
  invalidatePullRequestReviewSurfaceThreadCache,
  listPullRequestComments,
  postPullRequestComment,
  prEventWatermarkTruncationCategories,
  pullRequestEventStateTruncation,
  readLivePrReviewDraft,
  readPrReviewDraft,
  readPrReviewDraftForComment,
  replyToPullRequestReviewThread,
  resolvePullRequestReviewThread,
  submitPullRequestReview,
  unresolvePullRequestReviewThread,
  updatePrReviewDraftComment,
  upsertPrReviewDraft,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
  type GitHubPullRequestEventState,
  type GitHubPullRequestReviewThread,
  type GitHubPullRequestReviewThreadComment,
} from '../github';
import {
  readLocalPullRequestFileDiff,
  readLocalPullRequestFiles,
} from '../pr-local-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  isAutopilotSetupBlocked,
  withAutopilotSetupWatchLease,
} from '../autopilot/setup-transactions';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from '../watches';
import {
  prCommentInputSchema,
  prEventTargetInputSchema,
  prFileDiffInputSchema,
  prFilesInputSchema,
  prReviewDraftCommentInputSchema,
  prReviewDraftCommentUpdateInputSchema,
  prReviewDraftInputSchema,
  prReviewSubmitInputSchema,
  prReviewThreadReplyInputSchema,
  prWatchEventWatermarkListInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import {
  resolvedReviewRevision,
  unavailableReviewRevision,
} from '../../../shared/review-source';
import {
  fetchEventState,
  isConfiguredRepoTarget,
  resolvePullRequestTarget,
} from './target';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
} from '../../../shared/patch-anchors';
import {
  conversationCommentFingerprint,
  readWatermarks,
  requestedChangesReviewDeliveryFingerprint,
  reviewThreadCommentDeliveryFingerprint,
  watermarksFromEventState,
} from './watermarks';
import {
  currentPrWatchEventWatermarkVersion,
  installPrWatchEventBaseline,
  readPendingPrWatchEventIntake,
  stagePrWatchEventIntake,
} from './intakes';
import { recordAddressedPrFeedback } from './addressed';
import {
  recordNeondeckPrDeliveries,
  recordNeondeckPrDelivery,
} from './deliveries';
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
  try {
    const fetcher =
      dependencies.fetchPullRequestReviewThreads ??
      (options.surface
        ? fetchPullRequestReviewSurfaceThreadsWithMetadata
        : fetchPullRequestReviewThreadsWithMetadata);
    const result = await fetcher({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      signal: options.signal,
    });
    threads = result.reviewThreads;
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
          reviewThreads: threads as unknown as JsonValue,
          reviewThreadsTruncated: truncated,
        }
      : {
          target: eventTargetJson(resolved.target),
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

export async function getGitHubPrReviewDraft(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return failResult('github_pr_review_draft_get', 'Invalid PR draft input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'github_pr_review_draft_get',
  );
  if (!resolved.ok) return resolved.result;

  const draft = readLivePrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
  });

  return okResult(
    'github_pr_review_draft_get',
    false,
    draft
      ? `Fetched review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`
      : `No review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      draft: draft as unknown as JsonValue,
    },
  );
}

export async function putGitHubPrReviewDraft(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  draftInput: v.InferInput<typeof prReviewDraftInputSchema>,
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsedDraft = v.safeParse(prReviewDraftInputSchema, draftInput);
  if (!parsedTarget.success || !parsedDraft.success) {
    return failResult('github_pr_review_draft_put', 'Invalid PR draft input.', {
      errors: [
        ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
        ...(!parsedDraft.success ? [v.summarize(parsedDraft.issues)] : []),
      ],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_draft_put',
  );
  if (!resolved.ok) return resolved.result;

  const draftUpdate: Parameters<typeof upsertPrReviewDraft>[0] = {
    databasePath: paths.neondeckDatabase,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
    headSha: parsedDraft.output.headSha,
  };
  if ('verdict' in parsedDraft.output) {
    draftUpdate.verdict = parsedDraft.output.verdict ?? null;
  }
  if ('body' in parsedDraft.output) {
    draftUpdate.body = parsedDraft.output.body ?? null;
  }
  if (parsedDraft.output.reanchorHeadSha) {
    draftUpdate.reanchorHeadSha = true;
  }
  let draft: ReturnType<typeof upsertPrReviewDraft>;
  try {
    draft = upsertPrReviewDraft(draftUpdate);
  } catch (error) {
    return failResult(
      'github_pr_review_draft_put',
      'Could not save review draft.',
      { errors: [errorMessage(error)] },
    );
  }

  return okResult(
    'github_pr_review_draft_put',
    true,
    `Saved review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      draft: draft as unknown as JsonValue,
    },
  );
}

export async function postGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  input: v.InferInput<typeof prReviewDraftCommentInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
  metadata: { origin?: 'human' | 'neon' } = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsed = v.safeParse(prReviewDraftCommentInputSchema, input);
  if (!parsedTarget.success || !parsed.success) {
    return failResult(
      'github_pr_review_draft_comment_post',
      'Invalid PR draft comment input.',
      {
        errors: [
          ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
          ...(!parsed.success ? [v.summarize(parsed.issues)] : []),
        ],
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_draft_comment_post',
  );
  if (!resolved.ok) return resolved.result;

  const draft = readPrReviewDraft({
    databasePath: paths.neondeckDatabase,
    draftId: parsed.output.draftId,
  });
  if (!draft || !draftMatchesTarget(draft, resolved.target)) {
    return failResult(
      'github_pr_review_draft_comment_post',
      'Review draft does not belong to this pull request.',
      { requires: ['draftId'] },
    );
  }

  const invalidAnchor = await validateDraftCommentAnchor(
    'github_pr_review_draft_comment_post',
    resolved.target,
    draft,
    {
      path: parsed.output.path,
      side: parsed.output.side,
      line: parsed.output.line,
      startLine: parsed.output.startLine ?? null,
      startSide: parsed.output.startSide ?? null,
    },
    paths,
    dependencies,
  );
  if (invalidAnchor) return invalidAnchor;

  try {
    const draft = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: parsed.output.draftId,
      path: parsed.output.path,
      side: parsed.output.side,
      line: parsed.output.line,
      startLine: parsed.output.startLine ?? null,
      startSide: parsed.output.startSide ?? null,
      body: parsed.output.body,
      origin: metadata.origin,
      sourceFindingId: parsed.output.sourceFindingId ?? null,
    });
    return okResult(
      'github_pr_review_draft_comment_post',
      true,
      'Saved PR review draft comment.',
      { draft: draft as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      'github_pr_review_draft_comment_post',
      'Could not save PR review draft comment.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function patchGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  commentId: string,
  input: v.InferInput<typeof prReviewDraftCommentUpdateInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsed = v.safeParse(prReviewDraftCommentUpdateInputSchema, input);
  if (!commentId || !parsedTarget.success || !parsed.success) {
    return failResult(
      'github_pr_review_draft_comment_patch',
      'Invalid PR draft comment update input.',
      {
        errors: [
          ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
          ...(!parsed.success ? [v.summarize(parsed.issues)] : []),
        ],
        requires: !commentId ? ['commentId'] : undefined,
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_draft_comment_patch',
  );
  if (!resolved.ok) return resolved.result;

  const draft = readPrReviewDraftForComment({
    databasePath: paths.neondeckDatabase,
    commentId,
  });
  if (!draft || !draftMatchesTarget(draft, resolved.target)) {
    return failResult(
      'github_pr_review_draft_comment_patch',
      'Review draft comment does not belong to this pull request.',
      { requires: ['commentId'] },
    );
  }

  const existing = draft.comments.find((comment) => comment.id === commentId);
  if (!existing) {
    return failResult(
      'github_pr_review_draft_comment_patch',
      'Review draft comment was not found.',
      { requires: ['commentId'] },
    );
  }
  const nextAnchor = {
    path: parsed.output.path ?? existing.path,
    side: parsed.output.side ?? existing.side,
    line: parsed.output.line ?? existing.line,
    startLine:
      'startLine' in parsed.output
        ? (parsed.output.startLine ?? null)
        : existing.startLine,
    startSide:
      'startSide' in parsed.output
        ? (parsed.output.startSide ?? null)
        : existing.startSide,
  };
  const invalidAnchor = await validateDraftCommentAnchor(
    'github_pr_review_draft_comment_patch',
    resolved.target,
    draft,
    nextAnchor,
    paths,
    dependencies,
  );
  if (invalidAnchor) return invalidAnchor;

  try {
    const draft = updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId,
      body: parsed.output.body,
      ...('path' in parsed.output ? { path: parsed.output.path } : {}),
      ...('side' in parsed.output ? { side: parsed.output.side } : {}),
      ...('line' in parsed.output ? { line: parsed.output.line } : {}),
      ...('startLine' in parsed.output
        ? { startLine: parsed.output.startLine ?? null }
        : {}),
      ...('startSide' in parsed.output
        ? { startSide: parsed.output.startSide ?? null }
        : {}),
    });
    return okResult(
      'github_pr_review_draft_comment_patch',
      true,
      'Updated PR review draft comment.',
      { draft: draft as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      'github_pr_review_draft_comment_patch',
      'Could not update PR review draft comment.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function deleteGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  commentId: string,
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  if (!commentId || !parsedTarget.success) {
    return failResult(
      'github_pr_review_draft_comment_delete',
      'Invalid PR draft comment delete input.',
      {
        errors: parsedTarget.success
          ? undefined
          : [v.summarize(parsedTarget.issues)],
        requires: !commentId ? ['commentId'] : undefined,
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_draft_comment_delete',
  );
  if (!resolved.ok) return resolved.result;

  const draft = readPrReviewDraftForComment({
    databasePath: paths.neondeckDatabase,
    commentId,
  });
  if (!draftMatchesTarget(draft, resolved.target)) {
    return failResult(
      'github_pr_review_draft_comment_delete',
      'Review draft comment does not belong to this pull request.',
      { requires: ['commentId'] },
    );
  }

  try {
    const draft = deletePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId,
    });
    return okResult(
      'github_pr_review_draft_comment_delete',
      true,
      'Deleted PR review draft comment.',
      { draft: draft as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      'github_pr_review_draft_comment_delete',
      'Could not delete PR review draft comment.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function deleteGitHubPrReviewDraft(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'github_pr_review_draft_delete',
      'Invalid PR draft delete input.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'github_pr_review_draft_delete',
  );
  if (!resolved.ok) return resolved.result;

  const draft = discardPrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
  });
  return okResult(
    'github_pr_review_draft_delete',
    draft !== null,
    draft
      ? `Discarded review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`
      : `No review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      draft: draft as unknown as JsonValue,
    },
  );
}

export async function postGitHubPrReview(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  reviewInput: v.InferInput<typeof prReviewSubmitInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsedReview = v.safeParse(prReviewSubmitInputSchema, reviewInput);
  if (!parsedTarget.success || !parsedReview.success) {
    return failResult('github_pr_review_post', 'Invalid PR review input.', {
      errors: [
        ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
        ...(!parsedReview.success ? [v.summarize(parsedReview.issues)] : []),
      ],
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pr_review_post',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
      },
    );
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    'github_pr_review_post',
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      'github_pr_review_post',
      `Repository "${resolved.target.repoFullName}" is not configured for PR reviews.`,
      { requires: ['repo'] },
    );
  }

  try {
    const submitter =
      dependencies.submitPullRequestReview ?? submitPullRequestReview;
    const result = await submitter({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      databasePath: paths.neondeckDatabase,
      paths,
      draftId: parsedReview.output.draftId,
      headSha: parsedReview.output.headSha,
      commentIds: parsedReview.output.commentIds,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
    });
    invalidatePullRequestReviewSurfaceThreadCache({
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
    });
    const selectedCommentIds = parsedReview.output.commentIds
      ? new Set(parsedReview.output.commentIds)
      : null;
    const submittedDraftComments = result.draft.comments.filter(
      (comment) =>
        selectedCommentIds === null || selectedCommentIds.has(comment.id),
    );
    const deliveredComments = await (
      dependencies.fetchPullRequestReviewComments ??
      fetchPullRequestReviewComments
    )({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      reviewId: result.review.id,
    });
    const deliveryIdentityError = submittedReviewDeliveryIdentityError(
      result.review.id,
      submittedDraftComments,
      deliveredComments,
    );
    if (deliveryIdentityError) {
      return failResult(
        'github_pr_review_post',
        'Submitted PR review but could not uniquely verify its durable delivery identity.',
        {
          requires: ['deliveryIdentity'],
          errors: [deliveryIdentityError],
        },
      );
    }
    recordNeondeckPrDeliveries(
      [
        {
          repoFullName: resolved.target.repoFullName,
          prNumber: resolved.target.number,
          itemKind: 'review' as const,
          itemId: result.review.id,
          itemFingerprint: requestedChangesReviewDeliveryFingerprint(
            result.review,
          ),
        },
        ...deliveredComments.map((comment) => ({
          repoFullName: resolved.target.repoFullName,
          prNumber: resolved.target.number,
          itemKind: 'review-comment' as const,
          itemId: comment.databaseId ?? comment.id,
          itemFingerprint: reviewThreadCommentDeliveryFingerprint(comment),
        })),
      ],
      paths,
    );
    return okResult(
      'github_pr_review_post',
      true,
      `Submitted PR review for ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        draft: result.draft as unknown as JsonValue,
        review: result.review as unknown as JsonValue,
      },
    );
  } catch (error) {
    if (error instanceof GitHubPrReviewSubmitError) {
      return {
        ok: false,
        action: 'github_pr_review_post',
        changed: false,
        message: error.failure.message,
        data: {
          code: error.failure.code,
          failingCommentIds: error.failure.failingCommentIds ?? [],
        },
        ...(error.failure.requires ? { requires: error.failure.requires } : {}),
      };
    }
    return failResult('github_pr_review_post', 'Could not submit PR review.', {
      errors: [errorMessage(error)],
    });
  }
}

function submittedReviewDeliveryIdentityError(
  reviewId: number,
  expected: GitHubPrReviewDraft['comments'],
  delivered: GitHubPullRequestReviewThreadComment[],
) {
  if (
    delivered.some(
      (comment) => comment.databaseId === null || comment.reviewId !== reviewId,
    )
  ) {
    return `GitHub returned a comment without an exact database id for submitted review ${reviewId}.`;
  }
  const deliveredIds = delivered.map((comment) => comment.databaseId!);
  if (new Set(deliveredIds).size !== deliveredIds.length) {
    return `GitHub returned duplicate comment ids for submitted review ${reviewId}.`;
  }
  const expectedSignatures = expected
    .map(submittedDraftCommentSignature)
    .sort();
  const deliveredSignatures = delivered
    .map(submittedReviewCommentSignature)
    .sort();
  if (
    expectedSignatures.length !== deliveredSignatures.length ||
    expectedSignatures.some(
      (signature, index) => signature !== deliveredSignatures[index],
    )
  ) {
    return `GitHub comments for submitted review ${reviewId} do not exactly match the submitted draft comments.`;
  }
  return null;
}

function submittedDraftCommentSignature(
  comment: GitHubPrReviewDraft['comments'][number],
) {
  return JSON.stringify([
    comment.path,
    comment.side,
    comment.line,
    comment.startLine,
    comment.startSide,
    comment.body,
  ]);
}

function submittedReviewCommentSignature(
  comment: GitHubPullRequestReviewThreadComment,
) {
  return JSON.stringify([
    comment.path,
    comment.side,
    comment.line,
    comment.startLine,
    comment.startSide,
    comment.body,
  ]);
}

function draftMatchesTarget(
  draft: {
    repo: string;
    prNumber: number;
  } | null,
  target: PullRequestTarget,
) {
  return (
    draft?.repo === target.repoFullName && draft.prNumber === target.number
  );
}

async function validateDraftCommentAnchor(
  action: string,
  target: PullRequestTarget,
  draft: GitHubPrReviewDraft,
  anchor: {
    path: string;
    side: GitHubPrReviewDraftComment['side'];
    line: number;
    startLine: number | null;
    startSide: GitHubPrReviewDraftComment['startSide'];
  },
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
): Promise<PrEventActionResult | null> {
  try {
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      return failResult(
        action,
        'GITHUB_TOKEN is required to validate anchors.',
        {
          requires: ['GITHUB_TOKEN'],
        },
      );
    }

    // Drafts bind the head but do not persist an authoritative base SHA. Fetch
    // live instead of consulting a cache entry whose base identity is unknown.
    const diff = await fetchPullRequestFilesWithCache({
      token: token!,
      owner: target.owner,
      repo: target.repo,
      number: target.number,
      headSha: draft.headSha,
      databasePath: paths.neondeckDatabase,
      fetcher: dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
    });
    const file = diff.files.find((item) => item.path === anchor.path);
    if (
      !file ||
      !commentAnchorExists(buildPatchAnchorIndex(file.patch), {
        side: anchor.side,
        line: anchor.line,
        startLine: anchor.startLine,
        startSide: anchor.startSide,
      })
    ) {
      return failResult(
        action,
        'Review draft comment anchor is not present in the PR patch.',
        { requires: ['validAnchor'] },
      );
    }
    return null;
  } catch (error) {
    return failResult(action, 'Could not validate PR review draft anchor.', {
      errors: [errorMessage(error)],
    });
  }
}

export async function postGitHubPrThreadReply(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  threadId: string,
  input: v.InferInput<typeof prReviewThreadReplyInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const action = 'github_pr_thread_reply_post';
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsed = v.safeParse(prReviewThreadReplyInputSchema, input);
  if (!threadId || !parsedTarget.success || !parsed.success) {
    return failResult(action, 'Invalid review thread reply input.', {
      errors: [
        ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
        ...(!parsed.success ? [v.summarize(parsed.issues)] : []),
      ],
      requires: !threadId ? ['threadId'] : undefined,
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(action, 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    action,
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      action,
      `Repository "${resolved.target.repoFullName}" is not configured for review thread replies.`,
      { requires: ['repo'] },
    );
  }

  const verified = await verifyReviewThreadTarget({
    action,
    token,
    threadId,
    target: resolved.target,
    dependencies,
  });
  if (!verified.ok) return verified.result;

  const replyBody = `${parsed.output.text}\n\n${neondeckSelfAuthoredMarker}`;
  if (replyBody.length > githubCommentLengthLimit) {
    return failResult(
      action,
      'Review thread reply plus its Neondeck marker exceeds GitHub’s comment length limit.',
      { requires: ['shorterComment'] },
    );
  }

  try {
    const replier =
      dependencies.replyToPullRequestReviewThread ??
      replyToPullRequestReviewThread;
    let thread: GitHubPullRequestReviewThread;
    try {
      thread = await replier({
        token,
        threadId,
        body: replyBody,
      });
    } finally {
      invalidatePullRequestReviewSurfaceThreadCache({
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
      });
    }
    const previousCommentIds = new Set(
      verified.thread.comments.map((comment) =>
        String(comment.databaseId ?? comment.id),
      ),
    );
    const deliveredComments = thread.comments.filter(
      (comment) =>
        !previousCommentIds.has(String(comment.databaseId ?? comment.id)) &&
        comment.body === replyBody,
    );
    if (deliveredComments.length !== 1) {
      return failResult(
        action,
        'Posted review thread reply but could not uniquely verify its durable delivery identity.',
        { requires: ['deliveryIdentity'] },
      );
    }
    const deliveredComment = deliveredComments[0]!;
    recordNeondeckPrDelivery(
      {
        repoFullName: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        itemKind: 'review-comment',
        itemId: deliveredComment.databaseId ?? deliveredComment.id,
        itemFingerprint: reviewThreadCommentDeliveryFingerprint(
          deliveredComment,
          thread,
        ),
      },
      paths,
    );
    return okResult(action, true, 'Posted review thread reply.', {
      thread: thread as unknown as JsonValue,
    });
  } catch (error) {
    return failResult(action, 'Could not post review thread reply.', {
      errors: [errorMessage(error)],
    });
  }
}

export async function postGitHubPrThreadResolution(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  threadId: string,
  resolved: boolean,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const action = resolved
    ? 'github_pr_thread_resolve_post'
    : 'github_pr_thread_unresolve_post';
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  if (!threadId || !parsedTarget.success) {
    return failResult(
      action,
      !threadId
        ? 'Review thread id is required.'
        : 'Invalid review thread target input.',
      {
        errors: parsedTarget.success
          ? undefined
          : [v.summarize(parsedTarget.issues)],
        requires: !threadId ? ['threadId'] : undefined,
      },
    );
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(action, 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const target = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    action,
  );
  if (!target.ok) return target.result;
  if (!(await isConfiguredRepoTarget(target.target, paths))) {
    return failResult(
      action,
      `Repository "${target.target.repoFullName}" is not configured for review thread resolution.`,
      { requires: ['repo'] },
    );
  }

  const verified = await verifyReviewThreadTarget({
    action,
    token,
    threadId,
    target: target.target,
    dependencies,
  });
  if (!verified.ok) return verified.result;

  try {
    const mutator = resolved
      ? (dependencies.resolvePullRequestReviewThread ??
        resolvePullRequestReviewThread)
      : (dependencies.unresolvePullRequestReviewThread ??
        unresolvePullRequestReviewThread);
    let thread: GitHubPullRequestReviewThread;
    try {
      thread = await mutator({ token, threadId });
    } finally {
      invalidatePullRequestReviewSurfaceThreadCache({
        owner: target.target.owner,
        repo: target.target.repo,
        number: target.target.number,
      });
    }
    return okResult(
      action,
      true,
      resolved ? 'Resolved review thread.' : 'Unresolved review thread.',
      { thread: thread as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      action,
      resolved
        ? 'Could not resolve review thread.'
        : 'Could not unresolve review thread.',
      { errors: [errorMessage(error)] },
    );
  }
}

async function verifyReviewThreadTarget(options: {
  action: string;
  token: string;
  threadId: string;
  target: PullRequestTarget;
  dependencies: PrEventStateDependencies;
}): Promise<
  | { ok: true; thread: GitHubPullRequestReviewThread }
  | { ok: false; result: PrEventActionResult }
> {
  try {
    const fetcher =
      options.dependencies.fetchPullRequestReviewThread ??
      fetchPullRequestReviewThread;
    const thread = await fetcher({
      token: options.token,
      threadId: options.threadId,
    });
    if (!reviewThreadBelongsToTarget(thread, options.target)) {
      return {
        ok: false,
        result: failResult(
          options.action,
          'Review thread does not belong to this pull request.',
          { requires: ['threadId'] },
        ),
      };
    }
    return { ok: true, thread };
  } catch (error) {
    return {
      ok: false,
      result: failResult(
        options.action,
        'Could not verify review thread target.',
        { errors: [errorMessage(error)] },
      ),
    };
  }
}

function reviewThreadBelongsToTarget(
  thread: GitHubPullRequestReviewThread,
  target: PullRequestTarget,
) {
  return (
    thread.pullRequestRepo?.toLowerCase() ===
      target.repoFullName.toLowerCase() &&
    thread.pullRequestNumber === target.number
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

export async function postGitHubPrComment(
  input: v.InferInput<typeof prCommentInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prCommentInputSchema, input);
  if (!parsed.success) {
    return failResult('pr_comment', 'Invalid PR comment input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult('pr_comment', 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'pr_comment',
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      'pr_comment',
      `Repository "${resolved.target.repoFullName}" is not configured for PR comments.`,
      { requires: ['repo'] },
    );
  }

  try {
    const fetcher =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    const eventState = await fetcher({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
    });
    const truncation = pullRequestEventStateTruncation(eventState);
    if (truncation.any) {
      return failResult(
        'pr_comment',
        'PR event facts are incomplete; refusing to post a PR comment from truncated GitHub data.',
        {
          requires: ['completePrEventFacts'],
          errors: [
            `Truncated PR event fact categories: ${truncation.categories.join(', ')}.`,
          ],
        },
      );
    }

    const idempotencyMarker = parsed.output.idempotencyKey
      ? `<!-- neondeck:idempotency:${createHmac('sha256', token).update(parsed.output.idempotencyKey).digest('hex')} -->`
      : undefined;
    if (idempotencyMarker) {
      const comments = await (
        dependencies.listPullRequestComments ?? listPullRequestComments
      )({
        token,
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
      });
      const existing = comments.find((comment) =>
        comment.body.includes(idempotencyMarker),
      );
      if (existing) {
        recordNeondeckPrDelivery(
          {
            repoFullName: resolved.target.repoFullName,
            prNumber: resolved.target.number,
            itemKind: 'conversation-comment',
            itemId: existing.id,
            itemFingerprint: conversationCommentFingerprint(existing),
          },
          paths,
        );
        persistAddressedFeedback(
          resolved.target,
          parsed.output,
          eventState,
          existing.id,
          paths,
        );
        return okResult(
          'pr_comment',
          false,
          `PR comment already exists on ${resolved.target.repoFullName}#${resolved.target.number}.`,
          {
            target: eventTargetJson(resolved.target),
            comment: existing as unknown as JsonValue,
            metadata: {
              idempotentReplay: true,
              addressedReviewThreadIds:
                parsed.output.addressedReviewThreadIds ?? [],
              addressedReviewCommentIds:
                parsed.output.addressedReviewCommentIds ?? [],
              checkRunIds: parsed.output.checkRunIds ?? [],
              commitSha: parsed.output.commitSha ?? null,
            },
          },
        );
      }
    }

    const poster =
      dependencies.postPullRequestComment ?? postPullRequestComment;
    const body = `${parsed.output.body}\n\n${idempotencyMarker ?? neondeckSelfAuthoredMarker}`;
    if (body.length > githubCommentLengthLimit) {
      return failResult(
        'pr_comment',
        'PR comment plus its idempotency marker exceeds GitHub’s comment length limit.',
        { requires: ['shorterComment'] },
      );
    }
    const comment = await poster({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      body,
    });
    recordNeondeckPrDelivery(
      {
        repoFullName: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        itemKind: 'conversation-comment',
        itemId: comment.id,
        itemFingerprint: conversationCommentFingerprint(comment),
      },
      paths,
    );
    persistAddressedFeedback(
      resolved.target,
      parsed.output,
      eventState,
      comment.id,
      paths,
    );

    return okResult(
      'pr_comment',
      true,
      `Posted PR comment on ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        comment: comment as unknown as JsonValue,
        metadata: {
          addressedReviewThreadIds:
            parsed.output.addressedReviewThreadIds ?? [],
          addressedReviewCommentIds:
            parsed.output.addressedReviewCommentIds ?? [],
          checkRunIds: parsed.output.checkRunIds ?? [],
          commitSha: parsed.output.commitSha ?? null,
        },
      },
    );
  } catch (error) {
    return failResult('pr_comment', 'Could not post GitHub PR comment.', {
      errors: [errorMessage(error)],
    });
  }
}

const neondeckSelfAuthoredMarker = '<!-- neondeck:generated -->';
const githubCommentLengthLimit = 65_536;

function persistAddressedFeedback(
  target: PullRequestTarget,
  input: {
    addressedReviewThreadIds?: string[];
    addressedReviewCommentIds?: string[];
  },
  eventState: GitHubPullRequestEventState,
  deliveryCommentId: string | number,
  paths: RuntimePaths,
) {
  const reviewThreadIds = input.addressedReviewThreadIds ?? [];
  const reviewCommentIds = input.addressedReviewCommentIds ?? [];
  if (reviewThreadIds.length === 0 && reviewCommentIds.length === 0) return;
  const fingerprints = addressedFeedbackFingerprints(eventState);
  const commentsAddressedByThread = reviewThreadIds.flatMap(
    (threadId) => fingerprints.reviewCommentsByThread.get(threadId) ?? [],
  );
  recordAddressedPrFeedback(
    {
      repoFullName: target.repoFullName,
      prNumber: target.number,
      reviewThreadFingerprints: Object.fromEntries(
        reviewThreadIds.flatMap((id) => {
          const fingerprint = fingerprints.reviewThreads.get(id);
          return fingerprint ? [[id, fingerprint]] : [];
        }),
      ),
      reviewCommentFingerprints: Object.fromEntries(
        [
          ...new Set([...reviewCommentIds, ...commentsAddressedByThread]),
        ].flatMap((id) => {
          const fingerprint = fingerprints.reviewComments.get(id);
          return fingerprint ? [[id, fingerprint]] : [];
        }),
      ),
      deliveryCommentId,
    },
    paths,
  );
}

function addressedFeedbackFingerprints(state: GitHubPullRequestEventState) {
  const reviewThreads = new Map<string, string>();
  const reviewComments = new Map<string, string>();
  const reviewCommentsByThread = new Map<string, string[]>();
  const watermark = watermarksFromEventState('addressed-feedback', state).find(
    (item) => item.category === 'review_threads',
  )?.value;
  const payload =
    watermark && typeof watermark === 'object' && !Array.isArray(watermark)
      ? (watermark as Record<string, unknown>)
      : {};
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  for (const value of threads) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const thread = value as Record<string, unknown>;
    const threadId = typeof thread.id === 'string' ? thread.id : null;
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const commentIds: string[] = [];
    let latestFingerprint: string | null = null;
    let latestUpdatedAt = '';
    for (const commentValue of comments) {
      if (
        !commentValue ||
        typeof commentValue !== 'object' ||
        Array.isArray(commentValue)
      ) {
        continue;
      }
      const comment = commentValue as Record<string, unknown>;
      const id =
        typeof comment.id === 'string' || typeof comment.id === 'number'
          ? String(comment.id)
          : null;
      const fingerprint =
        typeof comment.fingerprint === 'string' ? comment.fingerprint : null;
      if (id && fingerprint) {
        reviewComments.set(id, fingerprint);
        commentIds.push(id);
      }
      const updatedAt =
        typeof comment.updatedAt === 'string' ? comment.updatedAt : '';
      if (fingerprint && updatedAt >= latestUpdatedAt) {
        latestFingerprint = fingerprint;
        latestUpdatedAt = updatedAt;
      }
    }
    if (threadId && latestFingerprint) {
      reviewThreads.set(threadId, latestFingerprint);
      reviewCommentsByThread.set(threadId, commentIds);
    }
  }
  return { reviewThreads, reviewComments, reviewCommentsByThread };
}

export async function refreshPrWatchEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Invalid PR event refresh target.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }
  const localTarget = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'pr_watch_event_state_refresh',
  );
  if (!localTarget.ok) return localTarget.result;
  if (!localTarget.target.watch) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Refreshing event watermarks requires a configured PR watch.',
      { requires: ['watchId'] },
    );
  }
  const localWatch = localTarget.target.watch;
  return withAutopilotSetupWatchLease(localWatch.id, paths, async () => {
    // Setup can replace the watch's event generation or process-existing
    // choice while this call is waiting for its per-watch lease. Re-resolve
    // after acquiring it so every admission decision uses one serialized
    // durable snapshot rather than the pre-lease watch.
    const currentTarget = await resolvePullRequestTarget(
      parsed.output,
      paths,
      'pr_watch_event_state_refresh',
    );
    if (!currentTarget.ok) return currentTarget.result;
    if (!currentTarget.target.watch) {
      return failResult(
        'pr_watch_event_state_refresh',
        'Refreshing event watermarks requires a configured PR watch.',
        { requires: ['watchId'] },
      );
    }
    const currentWatch = currentTarget.target.watch;
    if (currentWatch.id !== localWatch.id) {
      return stalePrWatchGenerationResult(localWatch.id);
    }
    if (await isAutopilotSetupBlocked(localWatch.id, paths)) {
      return failResult(
        'pr_watch_event_state_refresh',
        'Watch event refresh is blocked until Autopilot setup recovers.',
        { requires: ['retrySetup'] },
      );
    }
    let pending: ReturnType<typeof readPendingPrWatchEventIntake>;
    try {
      pending = readPendingPrWatchEventIntake(paths, localWatch.id);
    } catch (error) {
      return invalidPersistedIntakeResult(localWatch.id, error);
    }
    if (
      pending &&
      pending.eventGenerationId !== currentWatch.eventGenerationId
    ) {
      return invalidPersistedIntakeResult(
        localWatch.id,
        new Error(
          `Pending intake generation ${pending.eventGenerationId} does not match current watch generation ${currentWatch.eventGenerationId}.`,
        ),
      );
    }
    if (pending) {
      return okResult(
        'pr_watch_event_state_refresh',
        true,
        `Resuming pending PR event intake ${pending.eventId}.`,
        {
          watchId: localWatch.id,
          target: eventTargetJson(currentTarget.target),
          intakeId: pending.eventId,
          changedCategories: pending.changedCategories,
          previousWatermarks:
            pending.previousWatermarks as unknown as JsonValue,
          watermarks: pending.candidateWatermarks as unknown as JsonValue,
          pending: true,
        },
      );
    }
    const resolved = await fetchEventState(
      'pr_watch_event_state_refresh',
      input,
      paths,
      dependencies,
    );
    if (!resolved.ok) return resolved.result;
    if (!resolved.target.watch) {
      return failResult(
        'pr_watch_event_state_refresh',
        'Refreshing event watermarks requires a configured PR watch.',
        { requires: ['watchId'] },
      );
    }
    const watch = resolved.target.watch;

    const truncation = pullRequestEventStateTruncation(resolved.state);
    if (truncation.any) {
      return failResult(
        'pr_watch_event_state_refresh',
        'PR event facts are incomplete; preserving the last acknowledged watermark baseline and retrying later.',
        {
          requires: ['completePrEventFacts'],
          errors: [
            `Incomplete PR event fact categories: ${truncation.categories.join(', ')}.`,
          ],
        },
      );
    }

    const next = watermarksFromEventState(watch.id, resolved.state);
    const incompleteWatermarks = prEventWatermarkTruncationCategories(next);
    if (incompleteWatermarks.length > 0) {
      return failResult(
        'pr_watch_event_state_refresh',
        'PR event facts are incomplete; preserving the last acknowledged watermark baseline and retrying later.',
        {
          requires: ['completePrEventFacts'],
          errors: [
            `Incomplete PR event watermark categories: ${incompleteWatermarks.join(', ')}.`,
          ],
        },
      );
    }

    if (watch.eventWatermarkVersion < currentPrWatchEventWatermarkVersion) {
      const installed = installPrWatchEventBaseline(paths, {
        watchId: watch.id,
        expectedEventGenerationId: currentWatch.eventGenerationId,
        nextEventGenerationId: randomUUID(),
        watermarks: next,
        markInitialProcessed: true,
      });
      if (!installed.installed) {
        return stalePrWatchGenerationResult(watch.id);
      }
      return okResult(
        'pr_watch_event_state_refresh',
        false,
        `Upgraded the PR event watermark baseline for ${watch.id} without replaying historical feedback.`,
        {
          watchId: watch.id,
          target: eventTargetJson(resolved.target),
          changedCategories: [],
          watermarks: readWatermarks(paths, watch.id) as unknown as JsonValue,
          seededUpgrade: true,
          watermarkVersion: currentPrWatchEventWatermarkVersion,
        },
      );
    }

    const staged = stagePrWatchEventIntake(paths, {
      watchId: watch.id,
      expectedEventGenerationId: currentWatch.eventGenerationId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      initialEvent: !watch.initialEventProcessedAt && watch.processExisting,
      next,
    });
    if (staged.kind === 'stale') {
      return stalePrWatchGenerationResult(watch.id);
    }
    if (staged.kind === 'pending') {
      await dependencies.afterPrWatchEventIntakeStaged?.({
        watchId: watch.id,
        eventId: staged.intake.eventId,
      });
    }

    const changedCategories =
      staged.kind === 'pending' ? staged.intake.changedCategories : [];
    const watermarks =
      staged.kind === 'pending'
        ? staged.intake.candidateWatermarks
        : staged.watermarks;

    return okResult(
      'pr_watch_event_state_refresh',
      changedCategories.length > 0,
      changedCategories.length > 0
        ? `Staged ${changedCategories.length} PR event watermark change(s) for durable processing on ${watch.id}.`
        : `No PR event watermark changes for ${watch.id}.`,
      {
        watchId: watch.id,
        target: eventTargetJson(resolved.target),
        intakeId: staged.kind === 'pending' ? staged.intake.eventId : null,
        changedCategories,
        previousWatermarks:
          staged.kind === 'pending'
            ? (staged.intake.previousWatermarks as unknown as JsonValue)
            : (watermarks as unknown as JsonValue),
        watermarks: watermarks as unknown as JsonValue,
        pending: staged.kind === 'pending',
      },
    );
  });
}

function stalePrWatchGenerationResult(watchId: string) {
  return failResult(
    'pr_watch_event_state_refresh',
    `PR watch "${watchId}" changed while GitHub event facts were being fetched; preserving current state and retrying on the next poll.`,
    { requires: ['currentWatchGeneration'] },
  );
}

function invalidPersistedIntakeResult(watchId: string, error: unknown) {
  return failResult(
    'pr_watch_event_state_refresh',
    `Stored PR event intake for ${watchId} is invalid and requires operator repair before polling can continue.`,
    {
      requires: ['repairPrWatchEventIntake'],
      errors: [errorMessage(error)],
    },
  );
}

export async function listPrWatchEventWatermarks(
  input: v.InferInput<typeof prWatchEventWatermarkListInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prWatchEventWatermarkListInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'pr_watch_event_watermarks_list',
      'Invalid PR watch event watermark input.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }

  const watermarks = readWatermarks(paths, parsed.output.watchId);
  return okResult(
    'pr_watch_event_watermarks_list',
    false,
    `Listed ${watermarks.length} PR watch event watermark(s).`,
    { watermarks: watermarks as unknown as JsonValue },
  );
}
