import type { SelectedLineRange } from '@pierre/diffs/react';
import {
  ApiError,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
  type GitHubPrReviewSubmitResponse,
} from '../../api';
import { patchHasContent } from '../diff-viewer/helpers';
import type { DiffFilePatch } from '../diff-viewer/types';

type PierreDiffSide = 'additions' | 'deletions';
type PatchAnchor = { hunk: number; position: number };
export type PatchAnchorIndex = Map<string, PatchAnchor>;
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

export function failingCommentIdsFromError(error: unknown) {
  if (!(error instanceof ApiError)) return [];
  const data = error.data as GitHubPrReviewSubmitResponse | undefined;
  if (data?.data?.code !== 'github-review-submit-failed') return [];
  const ids = data.data.failingCommentIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

export function normalizeReviewBody(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function reviewCommentPreview(value: string, fallback = 'Review thread') {
  const preview = value
    .split(/\n\s*Useful\? React with/i)[0]
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[\w-]*\n?/g, '').replace(/```/g, ''),
    )
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, '')
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

export function patchAnchorIndexesByPath(files: DiffFilePatch[]) {
  return new Map(
    files.map((file) => [file.path, buildPatchAnchorIndex(file.patch)]),
  );
}

export function buildPatchAnchorIndex(patch: string | null | undefined) {
  const anchors: PatchAnchorIndex = new Map();
  if (!patchHasContent(patch)) return anchors;
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  let position = 0;
  const lines = (patch ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = line.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)/);
    if (header?.groups) {
      oldLine = Number(header.groups.old);
      newLine = Number(header.groups.next);
      hunk += 1;
      position = 0;
      continue;
    }
    if (hunk < 0) continue;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      continue;
    }

    position += 1;
    if (line.startsWith('+')) {
      anchors.set(patchAnchorKey('RIGHT', newLine), { hunk, position });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      anchors.set(patchAnchorKey('LEFT', oldLine), { hunk, position });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      anchors.set(patchAnchorKey('LEFT', oldLine), { hunk, position });
      anchors.set(patchAnchorKey('RIGHT', newLine), { hunk, position });
      oldLine += 1;
      newLine += 1;
    }
  }
  return anchors;
}

export function commentAnchorExists(
  index: PatchAnchorIndex,
  comment: Pick<
    GitHubPrReviewDraftComment,
    'side' | 'line' | 'startLine' | 'startSide'
  >,
) {
  const endAnchor = index.get(patchAnchorKey(comment.side, comment.line));
  if (!endAnchor) return false;
  if (!comment.startLine) return true;
  const startAnchor = index.get(
    patchAnchorKey(comment.startSide ?? comment.side, comment.startLine),
  );
  if (!startAnchor) return false;
  return (
    startAnchor.hunk === endAnchor.hunk &&
    startAnchor.position <= endAnchor.position
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

function patchAnchorKey(
  side: GitHubPrReviewDraftComment['side'],
  line: number,
) {
  return `${side}:${line}`;
}

function normalizePierreSide(
  side: SelectedLineRange['side'] | SelectedLineRange['endSide'],
): PierreDiffSide {
  return side === 'deletions' ? 'deletions' : 'additions';
}
