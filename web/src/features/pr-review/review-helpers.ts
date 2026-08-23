import type { SelectedLineRange } from '@pierre/diffs/react';
import {
  ApiError,
  type GitHubPrReviewDraft,
  type GitHubPrReviewVerdict,
  type GitHubPrReviewSubmitResponse,
} from '../../api';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
  patchAnchorKey,
  type PatchAnchorIndex,
} from '../../../../shared/patch-anchors';
import type { DiffFilePatch } from '../diff-viewer/types';

export { buildPatchAnchorIndex, commentAnchorExists, patchAnchorKey };
export type { PatchAnchorIndex };

type PierreDiffSide = 'additions' | 'deletions';
export type GitHubReviewCommentInput = ReturnType<
  typeof commentInputFromSelection
>;

export function commentInputFromSelection(
  selection: SelectedLineRange,
  index?: PatchAnchorIndex,
) {
  const ordered = orderSelectionEndpoints(selection, index);
  const side = ordered.endSide === 'deletions' ? 'LEFT' : 'RIGHT';
  const startSide = ordered.startSide === 'deletions' ? 'LEFT' : 'RIGHT';
  const isRange =
    ordered.startLine !== ordered.endLine ||
    ordered.startSide !== ordered.endSide;
  return {
    side,
    line: ordered.endLine,
    startLine: isRange ? ordered.startLine : null,
    startSide: isRange ? startSide : null,
  } as const;
}

export function staleDraftCommentIds(
  draft: GitHubPrReviewDraft | null,
  patchIndexesByPath: Map<string, PatchAnchorIndex>,
) {
  const stale = new Set<string>();
  if (!draft) return stale;
  for (const comment of draft.comments) {
    const index = patchIndexesByPath.get(comment.path);
    if (!index || !commentAnchorExists(index, comment)) {
      stale.add(comment.id);
    }
  }
  return stale;
}

export function draftCommentIdsForSubmission({
  draft,
  failedCommentIds,
  patchIndexesByPath,
  unknownPatchCommentIds,
}: {
  draft: GitHubPrReviewDraft | null;
  failedCommentIds: ReadonlySet<string>;
  patchIndexesByPath: Map<string, PatchAnchorIndex>;
  unknownPatchCommentIds: ReadonlySet<string>;
}) {
  const blockedCommentIds = staleDraftCommentIds(draft, patchIndexesByPath);
  for (const commentId of unknownPatchCommentIds) {
    blockedCommentIds.delete(commentId);
  }
  for (const commentId of failedCommentIds) {
    blockedCommentIds.add(commentId);
  }
  return (
    draft?.comments
      .filter((comment) => !blockedCommentIds.has(comment.id))
      .map((comment) => comment.id) ?? []
  );
}

export async function waitForPendingDraftMutations(
  pendingMutations: ReadonlySet<Promise<unknown>>,
) {
  while (pendingMutations.size > 0) {
    const results = await Promise.allSettled(pendingMutations);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }
}

export function hasUnsettledDraftEditor({
  completedEditorKeys,
  editorKeys,
  hasPendingAnchor,
  inFlightEditorKeys,
}: {
  completedEditorKeys: ReadonlySet<string>;
  editorKeys: readonly string[];
  hasPendingAnchor: boolean;
  inFlightEditorKeys: ReadonlySet<string>;
}) {
  return (
    hasPendingAnchor ||
    editorKeys.some(
      (key) => !inFlightEditorKeys.has(key) && !completedEditorKeys.has(key),
    )
  );
}

export function failingCommentIdsFromError(error: unknown) {
  if (!(error instanceof ApiError)) return [];
  const data = error.data as GitHubPrReviewSubmitResponse | undefined;
  if (data?.data?.code !== 'github-review-submit-failed') return [];
  const ids = data.data.failingCommentIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

export function submissionMayHaveBeenAccepted(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const result = error.data as GitHubPrReviewSubmitResponse | undefined;
  if (result?.data?.code === 'submission-uncertain') return true;
  return Boolean(
    result?.changed &&
    result.data?.draft?.status === 'submitted' &&
    result.data.review,
  );
}

export function normalizeReviewBody(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function draftSnapshotMatches(
  left: Pick<GitHubPrReviewDraft, 'id' | 'revision'> | null,
  right: Pick<GitHubPrReviewDraft, 'id' | 'revision'> | null,
) {
  return left?.id === right?.id && left?.revision === right?.revision;
}

export async function settleAndSubmitPrReview(input: {
  barrierDraft: GitHubPrReviewDraft | null;
  body: string | null;
  commentIds: (draft: GitHubPrReviewDraft) => string[];
  headSha: string;
  number: number;
  onSubmitStart?: () => void;
  refetchDraft: () => Promise<GitHubPrReviewDraft | null>;
  repo: string;
  saveDraft: (input: {
    body: string | null;
    draftId?: string;
    expectedAbsent?: boolean;
    expectedRevision?: number;
    headSha: string;
    number: number;
    repo: string;
    verdict: GitHubPrReviewVerdict;
  }) => Promise<GitHubPrReviewDraft>;
  submitReview: (input: {
    body: string | null;
    commentIds: string[];
    draftId: string;
    expectedDraftRevision: number;
    headSha: string;
    number: number;
    repo: string;
    verdict: GitHubPrReviewVerdict;
  }) => Promise<unknown>;
  verdict: GitHubPrReviewVerdict;
}) {
  const refreshedDraft = await input.refetchDraft();
  if (!draftSnapshotMatches(refreshedDraft, input.barrierDraft)) {
    throw new Error(
      'The review draft changed after pending edits settled. Review it and submit again.',
    );
  }
  if (refreshedDraft && refreshedDraft.headSha !== input.headSha) {
    throw new Error(
      'The local review draft does not match the reviewed pull request head.',
    );
  }
  const settledDraft = await input.saveDraft({
    ...(refreshedDraft
      ? {
          draftId: refreshedDraft.id,
          expectedRevision: refreshedDraft.revision,
        }
      : { expectedAbsent: true }),
    body: input.body,
    verdict: input.verdict,
    headSha: input.headSha,
    repo: input.repo,
    number: input.number,
  });
  input.onSubmitStart?.();
  await input.submitReview({
    draftId: settledDraft.id,
    expectedDraftRevision: settledDraft.revision,
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
    body: input.body,
    verdict: input.verdict,
    commentIds: input.commentIds(settledDraft),
  });
  return settledDraft;
}

export function draftSnapshotIsAtOrBeyondFrontier(
  frontier: string | null,
  incomingUpdatedAt: string,
) {
  return (
    frontier === null || Date.parse(incomingUpdatedAt) >= Date.parse(frontier)
  );
}

export function reviewDraftNeedsSubmitSave(
  draft: Pick<GitHubPrReviewDraft, 'body' | 'headSha' | 'verdict'> | null,
  normalizedBody: string | null,
  verdict: GitHubPrReviewVerdict,
  currentHeadSha: string,
) {
  return (
    !draft ||
    draft.body !== normalizedBody ||
    draft.verdict !== verdict ||
    draft.headSha !== currentHeadSha
  );
}

export function reviewCommentPreview(
  value: string,
  fallback = 'Review thread',
) {
  const withoutHtml = stripHtmlTags(
    value
      .split(/\n\s*Useful\? React with/i)[0]
      .replace(/```[\s\S]*?```/g, (block) =>
        block.replace(/```[\w-]*\n?/g, '').replace(/```/g, ''),
      )
      .replace(/!\[[^\]]*]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1'),
  );
  const preview = withoutHtml
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return preview || fallback;
}

function stripHtmlTags(value: string) {
  let tagDepth = 0;
  let plainText = '';
  for (const character of value) {
    if (character === '<') {
      tagDepth += 1;
    } else if (character === '>' && tagDepth > 0) {
      tagDepth -= 1;
    } else if (tagDepth === 0) {
      plainText += character;
    }
  }
  return plainText;
}

export function patchAnchorIndexesByPath(files: DiffFilePatch[]) {
  return new Map(
    files.map((file) => [file.path, buildPatchAnchorIndex(file.patch)]),
  );
}

function orderSelectionEndpoints(
  selection: SelectedLineRange,
  index: PatchAnchorIndex | undefined,
) {
  const first = {
    side: normalizePierreSide(selection.side),
    line: selection.start,
  };
  const second = {
    side: normalizePierreSide(selection.endSide ?? selection.side),
    line: selection.end,
  };

  const firstGitHubSide = first.side === 'deletions' ? 'LEFT' : 'RIGHT';
  const secondGitHubSide = second.side === 'deletions' ? 'LEFT' : 'RIGHT';
  const firstAnchor = index?.get(patchAnchorKey(firstGitHubSide, first.line));
  const secondAnchor = index?.get(
    patchAnchorKey(secondGitHubSide, second.line),
  );
  const isReverseByPatch =
    firstAnchor &&
    secondAnchor &&
    firstAnchor.hunk === secondAnchor.hunk &&
    firstAnchor.position > secondAnchor.position;
  const isReverseSameSide =
    first.side === second.side && first.line > second.line;
  const isReverse = Boolean(isReverseByPatch || isReverseSameSide);

  const start = isReverse ? second : first;
  const end = isReverse ? first : second;
  return {
    startSide: start.side,
    startLine: start.line,
    endSide: end.side,
    endLine: end.line,
  };
}

function normalizePierreSide(
  side: SelectedLineRange['side'] | SelectedLineRange['endSide'],
): PierreDiffSide {
  return side === 'deletions' ? 'deletions' : 'additions';
}
