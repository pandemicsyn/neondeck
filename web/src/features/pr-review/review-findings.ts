import type { SelectedLineRange } from '@pierre/diffs/react';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  commentAnchorExists,
  type PatchAnchorIndex,
} from '../../../../shared/patch-anchors';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';

export type NeonFindingAnchorResolution =
  | {
      state: 'anchored';
      lineNumber: number;
      selection: SelectedLineRange;
      side: 'additions' | 'deletions';
    }
  | {
      state: 'pending' | 'unavailable' | 'stale';
      reason: string;
    };

export function neonFindingAnnotationId(findingId: string) {
  return namespacedReviewUiId('neon-finding-annotation', findingId);
}

export function neonFindingNavigationId(findingId: string) {
  return namespacedReviewUiId('neon-finding-navigation', findingId);
}

export function namespacedReviewUiId(
  namespace: string,
  ...identity: Array<string | number | null>
) {
  return JSON.stringify([namespace, ...identity]);
}

export function currentActiveNeonFindings(
  findings: readonly NeonReviewFinding[],
  sourceId: string,
  revisionKey: string | null,
) {
  if (!revisionKey) return [];
  return findings.filter(
    (finding) =>
      finding.lifecycle.state === 'active' &&
      finding.sourceId === sourceId &&
      finding.revisionKey === revisionKey,
  );
}

export function resolveNeonFindingAnchor(
  finding: NeonReviewFinding,
  file: DiffFilePatch | undefined,
  index: PatchAnchorIndex | undefined,
  sourceId: string,
  revisionKey: string | null,
): NeonFindingAnchorResolution {
  if (
    finding.lifecycle.state !== 'active' ||
    finding.sourceId !== sourceId ||
    finding.revisionKey !== revisionKey
  ) {
    return {
      state: 'stale',
      reason: 'This finding is not active on the mounted review revision.',
    };
  }
  if (!file) {
    return {
      state: 'unavailable',
      reason: 'The finding file is not part of the mounted review revision.',
    };
  }
  if (!file.patch?.trim()) {
    const unavailable = Boolean(file.binary || file.truncated || file.message);
    return {
      state: unavailable ? 'unavailable' : 'pending',
      reason: unavailable
        ? file.message || 'The file patch cannot provide this finding anchor.'
        : 'The file patch has not been loaded yet.',
    };
  }

  if (finding.anchor.kind === 'line-range') {
    const side = finding.anchor.side;
    const githubSide = side === 'deletions' ? 'LEFT' : 'RIGHT';
    if (
      !index ||
      !commentAnchorExists(index, {
        side: githubSide,
        line: finding.anchor.endLine,
        startLine:
          finding.anchor.startLine === finding.anchor.endLine
            ? null
            : finding.anchor.startLine,
        startSide: githubSide,
      })
    ) {
      return {
        state: 'unavailable',
        reason: 'The declared line range does not exist in this patch.',
      };
    }
    return {
      state: 'anchored',
      lineNumber: finding.anchor.endLine,
      selection: {
        side,
        start: finding.anchor.startLine,
        end: finding.anchor.endLine,
      } as SelectedLineRange,
      side,
    };
  }

  const hunkAnchor = finding.anchor;
  const hunk = patchHunkAnchors(file.patch).find(
    (candidate) => candidate.id === hunkAnchor.hunkId,
  );
  if (!hunk) {
    return {
      state: 'unavailable',
      reason: 'The declared hunk does not exist in this patch.',
    };
  }
  const side = finding.anchor.side;
  const lineNumber = side === 'deletions' ? hunk.oldStart : hunk.newStart;
  const count = side === 'deletions' ? hunk.oldCount : hunk.newCount;
  if (count < 1) {
    return {
      state: 'unavailable',
      reason: `The declared hunk has no ${side} lines.`,
    };
  }
  return {
    state: 'anchored',
    lineNumber,
    selection: {
      side,
      start: lineNumber,
      end: lineNumber,
    } as SelectedLineRange,
    side,
  };
}

export function annotationsFromNeonFindings({
  files,
  findings,
  indexes,
  revisionKey,
  sourceId,
}: {
  files: readonly DiffFilePatch[];
  findings: readonly NeonReviewFinding[];
  indexes: ReadonlyMap<string, PatchAnchorIndex>;
  revisionKey: string | null;
  sourceId: string;
}) {
  const result: Record<string, DiffReviewAnnotation[]> = {};
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const finding of currentActiveNeonFindings(
    findings,
    sourceId,
    revisionKey,
  )) {
    const file = filesByPath.get(finding.file);
    const resolution = resolveNeonFindingAnchor(
      finding,
      file,
      indexes.get(finding.file),
      sourceId,
      revisionKey,
    );
    if (resolution.state !== 'anchored') continue;
    const annotation: DiffReviewAnnotation = {
      side: resolution.side,
      lineNumber: resolution.lineNumber,
      metadata: {
        id: neonFindingAnnotationId(finding.id),
        kind: 'finding',
        title: finding.title,
        body: finding.explanation,
        finding,
      },
    };
    result[finding.file] = [...(result[finding.file] ?? []), annotation];
  }
  return result;
}

export function findingAnchorLabel(finding: NeonReviewFinding) {
  if (finding.anchor.kind === 'hunk') {
    return `${finding.anchor.side} hunk ${finding.anchor.hunkId}`;
  }
  const range =
    finding.anchor.startLine === finding.anchor.endLine
      ? `L${finding.anchor.startLine}`
      : `L${finding.anchor.startLine}–${finding.anchor.endLine}`;
  return `${finding.anchor.side} ${range}`;
}

function patchHunkAnchors(patch: string) {
  const result: Array<{
    id: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }> = [];
  const pattern = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const line of patch.split('\n')) {
    const match = line.match(pattern);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    result.push({
      id: `${result.length}:${oldStart}:${newStart}`,
      oldStart,
      oldCount,
      newStart,
      newCount,
    });
  }
  return result;
}
