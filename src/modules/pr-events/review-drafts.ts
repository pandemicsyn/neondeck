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
    const { expectedDraftId, expectedHeadSha } = parsedDraft.output;
    if (!expectedDraftId || !expectedHeadSha) {
      return failResult(
        'github_pr_review_draft_put',
        'Re-anchoring a review draft requires its expected draft and head revision.',
        { requires: ['expectedDraftId', 'expectedHeadSha'] },
      );
    }
    let draft: ReturnType<typeof reanchorPrReviewDraft>;
    try {
      draft = reanchorPrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        draftId: expectedDraftId,
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

  const draftUpdate: Parameters<typeof upsertPrReviewDraft>[0] = {
    databasePath: paths.neondeckDatabase,
    repo: resolved.target.repoFullName,
    prNumber: resolved.target.number,
    headSha: parsedDraft.output.headSha,
  };
  if (parsedDraft.output.draftId) {
    draftUpdate.draftId = parsedDraft.output.draftId;
  }
  if (parsedDraft.output.expectedUpdatedAt) {
    draftUpdate.expectedUpdatedAt = parsedDraft.output.expectedUpdatedAt;
  }
  if (parsedDraft.output.expectedAbsent) {
    draftUpdate.expectedAbsent = true;
  }
  if ('verdict' in parsedDraft.output) {
    draftUpdate.verdict = parsedDraft.output.verdict ?? null;
  }
  if ('body' in parsedDraft.output) {
    draftUpdate.body = parsedDraft.output.body ?? null;
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
      { errors: [errorMessage(error)] },
    );
  }
}

export async function deleteGitHubPrReviewDraftComment(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  commentId: string,
  paths: RuntimePaths = runtimePaths(),
  metadata: { expectedHeadSha?: string } = {},
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
      { errors: [errorMessage(error)] },
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
    expectedUpdatedAt: parsedIdentity.output.expectedUpdatedAt,
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
