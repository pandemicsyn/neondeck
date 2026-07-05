import type { SelectedLineRange } from '@pierre/diffs/react';
import type {
  GitHubPrReviewDraft,
  GitHubPrReviewDraftComment,
} from '../../api';
import { patchHasContent } from '../diff-viewer/helpers';
import type { DiffFilePatch } from '../diff-viewer/types';

type PierreDiffSide = 'additions' | 'deletions';
type PatchAnchor = { hunk: number; position: number };
export type PatchAnchorIndex = Map<string, PatchAnchor>;

export function commentInputFromSelection(selection: SelectedLineRange) {
  const startPierreSide = normalizePierreSide(selection.side);
  const endPierreSide = normalizePierreSide(
    selection.endSide ?? selection.side,
  );
  const isReverseSameSide =
    startPierreSide === endPierreSide && selection.start > selection.end;
  const startLine = isReverseSameSide ? selection.end : selection.start;
  const endLine = isReverseSameSide ? selection.start : selection.end;
  const side = endPierreSide === 'deletions' ? 'LEFT' : 'RIGHT';
  const startSide = startPierreSide === 'deletions' ? 'LEFT' : 'RIGHT';
  const isRange = startLine !== endLine || startPierreSide !== endPierreSide;
  return {
    side,
    line: endLine,
    startLine: isRange ? startLine : null,
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
    if (!index || !patchAnchorExists(index, comment)) {
      stale.add(comment.id);
    }
  }
  return stale;
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

function patchAnchorExists(
  index: PatchAnchorIndex,
  comment: GitHubPrReviewDraftComment,
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
