import type { SelectedLineRange } from '@pierre/diffs/react';
import type {
  GitHubPrReviewDraft,
  GitHubPullRequestReviewThread,
  PrReviewReportOnlyFinding,
} from '../../api';
import {
  createReviewNavigationModel,
  moveReviewCursor,
  type ReviewCursorDirection,
  type ReviewCursorKind,
  type ReviewCursorResult,
  type ReviewCursorTarget,
  type ReviewNavigationItem,
  type ReviewNavigationModel,
} from '../../../../shared/review-navigation';
import type { DiffFilePatch } from '../diff-viewer/types';
import { latestThreadComment, threadPath } from './review-ui-helpers';

export type ReviewNavigationAnchor = {
  annotationId: string | null;
  selection: SelectedLineRange | null;
};

export type PrReviewNavigationData = {
  anchors: ReadonlyMap<string, ReviewNavigationAnchor>;
  model: ReviewNavigationModel;
};

export type ReviewPatchNavigationState =
  'loaded' | 'loading' | 'unloaded' | 'unavailable';

export type ReviewHunkTraversalResult =
  | { kind: 'target'; target: ReviewCursorTarget }
  | { kind: 'load'; path: string }
  | { kind: 'boundary'; boundary: 'start' | 'end' }
  | { kind: 'empty' };

const hunkHeader =
  /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s*(.*))?$/;

export function createPrReviewNavigationData({
  draft,
  files,
  findings,
  staleCommentIds,
  threads,
}: {
  draft: GitHubPrReviewDraft | null;
  files: DiffFilePatch[];
  findings: PrReviewReportOnlyFinding[];
  staleCommentIds: ReadonlySet<string>;
  threads: GitHubPullRequestReviewThread[];
}): PrReviewNavigationData {
  const items: ReviewNavigationItem[] = [];
  const anchors = new Map<string, ReviewNavigationAnchor>();

  for (const file of files) {
    for (const hunk of patchHunks(file)) {
      items.push(hunk.item);
      anchors.set(hunk.key, hunk.anchor);
    }
  }
  for (const thread of threads) {
    const path = threadPath(thread);
    if (!path) continue;
    const comment = latestThreadComment(thread);
    const line =
      positiveLine(thread.line) ??
      positiveLine(thread.originalLine) ??
      positiveLine(comment?.line) ??
      positiveLine(comment?.originalLine);
    const item = {
      id: thread.id,
      kind: 'review-thread' as const,
      line,
      path,
      resolved: thread.isResolved,
      stale: thread.isOutdated,
      summary: comment?.body ?? null,
    };
    items.push(item);
    anchors.set(navigationTargetKey(item.kind, item.id), {
      annotationId: item.id,
      selection: line
        ? lineSelection(
            thread.diffSide === 'LEFT' ? 'deletions' : 'additions',
            line,
          )
        : null,
    });
  }
  for (const comment of draft?.comments ?? []) {
    const item = {
      id: comment.id,
      kind: 'local-draft' as const,
      line: comment.line,
      path: comment.path,
      stale: staleCommentIds.has(comment.id),
      summary: comment.body,
    };
    items.push(item);
    anchors.set(navigationTargetKey(item.kind, item.id), {
      annotationId: item.id,
      selection: lineSelection(
        comment.side === 'LEFT' ? 'deletions' : 'additions',
        comment.line,
      ),
    });
  }
  for (const [index, finding] of findings.entries()) {
    const id = reportOnlyFindingNavigationId(finding, index);
    const item = {
      id,
      kind: 'finding' as const,
      line: finding.line,
      path: finding.path,
      severity: finding.severity,
      summary: finding.summary,
    };
    items.push(item);
    anchors.set(navigationTargetKey(item.kind, item.id), {
      annotationId: item.id,
      selection: finding.line ? lineSelection('additions', finding.line) : null,
    });
  }

  return {
    anchors,
    model: createReviewNavigationModel({
      files: files.map((file) => ({
        path: file.path,
        previousPath: file.previousPath ?? null,
      })),
      items,
    }),
  };
}

export function reportOnlyFindingNavigationId(
  finding: PrReviewReportOnlyFinding,
  index: number,
) {
  return (
    finding.sourceId ??
    `report:${index}:${finding.path}:${finding.line ?? 'file'}`
  );
}

export function reviewNavigationAnchor(
  target: ReviewCursorTarget,
  anchors: ReadonlyMap<string, ReviewNavigationAnchor>,
) {
  const key = target.kind === 'attention' ? target.targetKey : target.key;
  return (
    anchors.get(key) ?? {
      annotationId: null,
      selection: null,
    }
  );
}

export function moveReviewCursorFromPath(
  targets: readonly ReviewCursorTarget[],
  currentKey: string | null,
  activePath: string | null,
  activeOrderIndex: number,
  direction: ReviewCursorDirection,
): ReviewCursorResult {
  if (currentKey && targets.some((target) => target.key === currentKey)) {
    return moveReviewCursor(targets, currentKey, direction);
  }
  const samePathIndexes = targets
    .map((target, index) => ({ index, target }))
    .filter(({ target }) => target.path === activePath)
    .map(({ index }) => index);
  if (samePathIndexes.length > 0) {
    const index =
      direction === 'next' ? samePathIndexes[0]! : samePathIndexes.at(-1)!;
    return cursorResult(targets, index, 'initial');
  }
  const index =
    direction === 'next'
      ? targets.findIndex((target) => target.orderIndex > activeOrderIndex)
      : findLastIndex(
          targets,
          (target) => target.orderIndex < activeOrderIndex,
        );
  if (index >= 0) return cursorResult(targets, index, 'nearest');
  return moveReviewCursor(targets, null, direction);
}

export function resolveHunkTraversal({
  activePath,
  availability,
  currentKey,
  direction,
  files,
  targets,
}: {
  activePath: string | null;
  availability: ReadonlyMap<string, ReviewPatchNavigationState>;
  currentKey: string | null;
  direction: ReviewCursorDirection;
  files: readonly DiffFilePatch[];
  targets: readonly ReviewCursorTarget[];
}): ReviewHunkTraversalResult {
  if (files.length === 0) return { kind: 'empty' };
  const delta = direction === 'next' ? 1 : -1;
  const currentTarget = currentKey
    ? (targets.find((target) => target.key === currentKey) ?? null)
    : null;
  const startPath = currentTarget?.path ?? activePath ?? files[0]?.path ?? null;
  if (!startPath) return { kind: 'empty' };
  const startIndex = files.findIndex((file) => file.path === startPath);
  if (startIndex < 0) return { kind: 'empty' };
  const sameFileTargets = targets.filter((target) => target.path === startPath);
  if (currentTarget) {
    const currentIndex = sameFileTargets.findIndex(
      (target) => target.key === currentTarget.key,
    );
    const localTarget = sameFileTargets[currentIndex + delta];
    if (localTarget) return { kind: 'target', target: localTarget };
  } else if (sameFileTargets.length > 0) {
    return {
      kind: 'target',
      target:
        direction === 'next' ? sameFileTargets[0]! : sameFileTargets.at(-1)!,
    };
  } else if (!isSettledPatch(availability.get(startPath))) {
    return { kind: 'load', path: startPath };
  }

  for (
    let fileIndex = startIndex + delta;
    fileIndex >= 0 && fileIndex < files.length;
    fileIndex += delta
  ) {
    const path = files[fileIndex]?.path;
    if (!path) continue;
    const fileTargets = targets.filter((target) => target.path === path);
    if (fileTargets.length > 0) {
      return {
        kind: 'target',
        target: direction === 'next' ? fileTargets[0]! : fileTargets.at(-1)!,
      };
    }
    if (!isSettledPatch(availability.get(path))) {
      return { kind: 'load', path };
    }
  }
  return {
    kind: 'boundary',
    boundary: direction === 'next' ? 'end' : 'start',
  };
}

export function reviewNavigationKindLabel(kind: ReviewCursorKind) {
  switch (kind) {
    case 'file':
      return 'file';
    case 'hunk':
      return 'hunk';
    case 'review-thread':
      return 'unresolved thread';
    case 'local-draft':
      return 'local draft';
    case 'finding':
      return 'Neon finding';
    case 'attention':
      return 'attention item';
  }
}

export function reviewNavigationAnnouncement(
  target: ReviewCursorTarget,
  index: number,
  total: number,
  status?: string | null,
) {
  const kind =
    target.kind === 'attention'
      ? `${reviewNavigationKindLabel(target.attentionKind)} attention item`
      : reviewNavigationKindLabel(target.kind);
  const details = [
    target.stale ? 'stale' : null,
    target.missing ? 'unavailable' : null,
    target.severity ? `${target.severity} severity` : null,
    status,
  ].filter(Boolean);
  return `${target.path}, ${kind}, ${index + 1} of ${total}${
    details.length > 0 ? `, ${details.join(', ')}` : ''
  }.`;
}

function patchHunks(file: DiffFilePatch) {
  const result: Array<{
    anchor: ReviewNavigationAnchor;
    item: Extract<ReviewNavigationItem, { kind: 'hunk' }>;
    key: string;
  }> = [];
  if (!file.patch) return result;
  let index = 0;
  for (const line of file.patch.split('\n')) {
    const match = line.match(hunkHeader);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    const id = `${index}:${oldStart}:${newStart}`;
    const item = {
      id,
      kind: 'hunk' as const,
      newStart,
      oldStart,
      path: file.path,
      summary: match[5]?.trim() || line,
    };
    const key = hunkNavigationKey(file.path, id);
    result.push({
      item,
      key,
      anchor: {
        annotationId: null,
        selection:
          newStart > 0
            ? lineSelection('additions', newStart)
            : lineSelection('deletions', Math.max(1, oldStart)),
      },
    });
    index += 1;
  }
  return result;
}

function navigationTargetKey(kind: string, id: string) {
  return `${kind}:${id}`;
}

function hunkNavigationKey(path: string, id: string) {
  return `hunk:${JSON.stringify([path, id])}`;
}

function lineSelection(
  side: SelectedLineRange['side'],
  line: number,
): SelectedLineRange {
  return { side, start: line, end: line } as SelectedLineRange;
}

function positiveLine(value: number | null | undefined) {
  return typeof value === 'number' && value > 0 ? value : null;
}

function isSettledPatch(state: ReviewPatchNavigationState | undefined) {
  return state === 'loaded' || state === 'unavailable';
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function cursorResult(
  targets: readonly ReviewCursorTarget[],
  index: number,
  resolution: ReviewCursorResult['resolution'],
): ReviewCursorResult {
  return {
    boundary: null,
    index,
    resolution,
    target: targets[index] ?? null,
    total: targets.length,
  };
}
