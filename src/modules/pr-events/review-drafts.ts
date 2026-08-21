import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  addPrReviewDraftComment,
  deletePrReviewDraftComment,
  discardPrReviewDraft,
  fetchPullRequestFiles,
  fetchPullRequestFilesWithCache,
  readLivePrReviewDraft,
  readPrReviewDraft,
  readPrReviewDraftForComment,
  reanchorPrReviewDraft,
  updatePrReviewDraftComment,
  upsertPrReviewDraft,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  prEventTargetInputSchema,
  prReviewDraftCommentInputSchema,
  prReviewDraftCommentUpdateInputSchema,
  prReviewDraftDiscardInputSchema,
  prReviewDraftInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import { resolvePullRequestTarget } from './target';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
} from '../../../shared/patch-anchors';
import { errorMessage, eventTargetJson, failResult, okResult } from './utils';

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

  if (parsedDraft.output.reanchorHeadSha) {
    const { expectedDraftId, expectedHeadSha, expectedRevision } =
      parsedDraft.output;
    if (!expectedDraftId || !expectedHeadSha || !expectedRevision) {
      return failResult(
        'github_pr_review_draft_put',
        'Re-anchoring a review draft requires its expected draft and head revision.',
        {
          requires: ['expectedDraftId', 'expectedHeadSha', 'expectedRevision'],
        },
      );
    }
    let draft: ReturnType<typeof reanchorPrReviewDraft>;
    try {
      draft = reanchorPrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        draftId: expectedDraftId,
        expectedRevision,
        expectedHeadSha,
        headSha: parsedDraft.output.headSha,
      });
    } catch (error) {
      return failResult(
        'github_pr_review_draft_put',
        'Could not re-anchor review draft.',
        { errors: [errorMessage(error)] },
      );
    }
    if (!draft) {
      return failResult(
        'github_pr_review_draft_put',
        'The review draft changed before it could be re-anchored. Refresh and try again.',
        { requires: ['currentDraft'] },
      );
    }
    return okResult(
      'github_pr_review_draft_put',
      true,
      `Re-anchored review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        draft: draft as unknown as JsonValue,
      },
    );
  }

  const hasCreateIdentity =
    parsedDraft.output.expectedAbsent === true &&
    !parsedDraft.output.draftId &&
    parsedDraft.output.expectedRevision === undefined;
  const hasUpdateIdentity = Boolean(
    parsedDraft.output.draftId &&
    parsedDraft.output.expectedRevision &&
    !parsedDraft.output.expectedAbsent,
  );
  if (!hasCreateIdentity && !hasUpdateIdentity) {
    return failResult(
      'github_pr_review_draft_put',
      'Saving a review draft requires an exact create or update identity.',
      { requires: ['currentDraft'] },
    );
  }

  const draftValues = {
    databasePath: paths.neondeckDatabase,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
    headSha: parsedDraft.output.headSha,
    ...('verdict' in parsedDraft.output
      ? { verdict: parsedDraft.output.verdict ?? null }
      : {}),
    ...('body' in parsedDraft.output
      ? { body: parsedDraft.output.body ?? null }
      : {}),
  };
  let draft: ReturnType<typeof upsertPrReviewDraft>;
  try {
    draft = parsedDraft.output.expectedAbsent
      ? upsertPrReviewDraft({ ...draftValues, expectedAbsent: true })
      : upsertPrReviewDraft({
          ...draftValues,
          draftId: parsedDraft.output.draftId!,
          expectedRevision: parsedDraft.output.expectedRevision!,
        });
  } catch (error) {
    return failResult(
      'github_pr_review_draft_put',
      'Could not save review draft.',
      draftWriteFailure(error),
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
  metadata: {
    expectedHeadSha?: string;
    id?: string;
    origin?: 'human' | 'neon';
  } = {},
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
  if (draft.revision !== parsed.output.expectedRevision) {
    return failResult(
      'github_pr_review_draft_comment_post',
      'The review draft changed before the comment could be saved.',
      { requires: ['currentDraft'] },
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
      id: metadata.id,
      databasePath: paths.neondeckDatabase,
      draftId: parsed.output.draftId,
      expectedDraftRevision: parsed.output.expectedRevision,
      expectedHeadSha: metadata.expectedHeadSha,
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
      draftWriteFailure(error),
    );
  }
}

export async function patchGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  commentId: string,
  input: v.InferInput<typeof prReviewDraftCommentUpdateInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
  metadata: {
    expectedHeadSha?: string;
    origin?: 'human' | 'neon';
  } = {},
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
  if (
    draft.id !== parsed.output.draftId ||
    draft.revision !== parsed.output.expectedRevision
  ) {
    return failResult(
      'github_pr_review_draft_comment_patch',
      'The review draft changed before the comment could be updated.',
      { requires: ['currentDraft'] },
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
      expectedDraftId: parsed.output.draftId,
      expectedDraftRevision: parsed.output.expectedRevision,
      expectedHeadSha: metadata.expectedHeadSha,
      origin: metadata.origin,
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
      draftWriteFailure(error),
    );
  }
}

export async function deleteGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  commentId: string,
  paths: RuntimePaths = runtimePaths(),
  metadata: {
    draftId?: string;
    expectedRevision?: number;
    expectedHeadSha?: string;
  } = {},
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
  if (
    !metadata.draftId ||
    metadata.expectedRevision === undefined ||
    draft?.id !== metadata.draftId ||
    draft.revision !== metadata.expectedRevision
  ) {
    return failResult(
      'github_pr_review_draft_comment_delete',
      'The review draft changed before the comment could be deleted.',
      { requires: ['currentDraft'] },
    );
  }

  try {
    const draft = deletePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId,
      expectedDraftId: metadata.draftId,
      expectedDraftRevision: metadata.expectedRevision,
      expectedHeadSha: metadata.expectedHeadSha,
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
      draftWriteFailure(error),
    );
  }
}

export async function deleteGitHubPrReviewDraft(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  identity: v.InferInput<typeof prReviewDraftDiscardInputSchema>,
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
  const parsedIdentity = v.safeParse(prReviewDraftDiscardInputSchema, identity);
  if (!parsedIdentity.success) {
    return failResult(
      'github_pr_review_draft_delete',
      'An exact PR review draft identity is required.',
      { errors: [v.summarize(parsedIdentity.issues)] },
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
    draftId: parsedIdentity.output.draftId,
    expectedRevision: parsedIdentity.output.expectedRevision,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
  });
  if (!draft) {
    return failResult(
      'github_pr_review_draft_delete',
      'Review draft changed or is no longer editable. Refresh and try again.',
    );
  }
  return okResult(
    'github_pr_review_draft_delete',
    true,
    `Discarded review draft for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      draft: draft as unknown as JsonValue,
    },
  );
}

function draftWriteFailure(error: unknown) {
  const message = errorMessage(error);
  const changed =
    message.includes('Review draft changed') ||
    message.includes('Review draft is not editable') ||
    message.includes('Review draft no longer matches') ||
    message.includes('review draft appeared') ||
    message.includes('Review draft is being submitted');
  return {
    errors: [message],
    ...(changed ? { requires: ['currentDraft'] } : {}),
  };
}

function draftMatchesTarget(
  draft: {
    repo: string;
    prNumber: number;
  } | null,
  target: PullRequestTarget,
) {
  return (
    draft?.repo.toLowerCase() === target.repoFullName.toLowerCase() &&
    draft.prNumber === target.number
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
