/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  addPrReviewDraftComment,
  deletePrReviewDraftComment,
  discardPrReviewDraft,
  fetchPullRequestEventState,
  fetchPullRequestFiles,
  fetchPullRequestFilesWithCache,
  fetchPullRequestReviewThread,
  GitHubPrReviewSubmitError,
  postPullRequestComment,
  pullRequestEventStateTruncation,
  readLivePrReviewDraft,
  readCachedPullRequestFiles,
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
} from '../github';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
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
  fetchEventState,
  isConfiguredRepoTarget,
  resolvePullRequestTarget,
} from './target';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
} from '../../../shared/patch-anchors';
import {
  readWatermarks,
  upsertWatermarks,
  watermarksFromEventState,
} from './watermarks';
import {
  errorMessage,
  eventTargetJson,
  failResult,
  okResult,
  stableJson,
} from './utils';

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
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_review_threads_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;
  const threads = resolved.state.reviewThreads;
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
    'github_pr_review_threads_get',
    false,
    `Fetched ${threads.length} review thread(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      reviewThreads: threads as unknown as JsonValue,
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

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pr_files_get',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
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
    'github_pr_files_get',
  );
  if (!resolved.ok) return resolved.result;

  try {
    const fetcher = dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles;
    const diff = await fetchPullRequestFilesWithCache({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      headSha: parsed.output.headSha ?? null,
      databasePath: paths.neondeckDatabase,
      fetcher,
      fetchHeadSha: dependencies.fetchPullRequestHeadSha,
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
    const cached = readCachedPullRequestFiles({
      databasePath: paths.neondeckDatabase,
      repo: target.repoFullName,
      number: target.number,
      headSha: draft.headSha,
    });
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!cached && !token) {
      return failResult(
        action,
        'GITHUB_TOKEN is required to validate anchors.',
        {
          requires: ['GITHUB_TOKEN'],
        },
      );
    }

    const diff =
      cached ??
      (await fetchPullRequestFilesWithCache({
        token: token!,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        headSha: draft.headSha,
        databasePath: paths.neondeckDatabase,
        fetcher: dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles,
        fetchHeadSha: dependencies.fetchPullRequestHeadSha,
      }));
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

  try {
    const replier =
      dependencies.replyToPullRequestReviewThread ??
      replyToPullRequestReviewThread;
    const thread = await replier({
      token,
      threadId,
      body: parsed.output.text,
    });
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
    const thread = await mutator({ token, threadId });
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

    const poster =
      dependencies.postPullRequestComment ?? postPullRequestComment;
    const comment = await poster({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      body: parsed.output.body,
    });

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

export async function refreshPrWatchEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
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

  const previous = readWatermarks(paths, resolved.target.watch.id);
  const next = watermarksFromEventState(
    resolved.target.watch.id,
    resolved.state,
  );
  const changedCategories = next
    .filter((item) => {
      const existing = previous.find(
        (record) => record.category === item.category,
      );
      return (
        stableJson(comparableWatermark(item.category, existing?.watermark)) !==
        stableJson(comparableWatermark(item.category, item.value))
      );
    })
    .map((item) => item.category);

  upsertWatermarks(paths, resolved.target.watch.id, next);

  return okResult(
    'pr_watch_event_state_refresh',
    changedCategories.length > 0,
    changedCategories.length > 0
      ? `Updated ${changedCategories.length} PR event watermark(s) for ${resolved.target.watch.id}.`
      : `No PR event watermark changes for ${resolved.target.watch.id}.`,
    {
      watchId: resolved.target.watch.id,
      target: eventTargetJson(resolved.target),
      changedCategories,
      watermarks: readWatermarks(
        paths,
        resolved.target.watch.id,
      ) as unknown as JsonValue,
    },
  );
}

function comparableWatermark(category: string, value: unknown) {
  if (category !== 'mergeability') return value ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? null;
  }
  const record = value as Record<string, unknown>;
  return {
    state: record.state,
    draft: typeof record.draft === 'boolean' ? record.draft : false,
    merged: record.merged,
    mergeable: record.mergeable,
    mergeableState: record.mergeableState,
    mergeCommitSha: record.mergeCommitSha,
    headSha: record.headSha,
    baseSha: record.baseSha,
  };
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
