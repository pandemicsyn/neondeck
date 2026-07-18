import type { SelectedLineRange } from '@pierre/diffs/react';
import type { ReviewCursorTarget } from '../../../../shared/review-navigation';
import type {
  GitHubPrReviewDraftComment,
  GitHubPullRequestReviewThread,
} from '../../api';
import {
  canExplicitlyApplyReviewRefresh,
  evaluateReviewRefreshSafety,
  type ReviewRefreshSafety,
} from '../../../../shared/review-refresh';

export function githubPrReviewRefreshSafety(input: {
  composerDirty: boolean;
  commentEditorDirty: boolean;
  replyEditorDirty: boolean;
  reviewBodyDirty: boolean;
  activeSelection: boolean;
  staleDraft: boolean;
  reanchorActive: boolean;
  mutationPending: boolean;
  safetyUncertain: boolean;
}) {
  return evaluateReviewRefreshSafety({
    dirtyEditor:
      input.composerDirty ||
      input.commentEditorDirty ||
      input.replyEditorDirty ||
      input.reviewBodyDirty,
    activeSelection: input.activeSelection,
    staleDraft: input.staleDraft,
    reanchorActive: input.reanchorActive,
    mutationPending: input.mutationPending,
    safetyUncertain: input.safetyUncertain,
  });
}

export function commentAnchorLabel(comment: GitHubPrReviewDraftComment) {
  if (comment.startLine) {
    return `${comment.startSide ?? comment.side} L${comment.startLine} -> ${comment.side} L${comment.line}`;
  }
  return `${comment.side} L${comment.line}`;
}

export function threadPath(thread: GitHubPullRequestReviewThread) {
  return (
    thread.path ?? thread.comments.find((comment) => comment.path)?.path ?? null
  );
}

export function latestThreadComment(thread: GitHubPullRequestReviewThread) {
  return thread.comments.at(-1) ?? thread.comments[0] ?? null;
}

export function clearCompletedEditor<T extends { token: number }>(
  current: T | null,
  completedToken: number,
) {
  return current?.token === completedToken ? null : current;
}

export function isCurrentReviewOperation(
  currentToken: number,
  completedToken: number,
) {
  return currentToken === completedToken;
}

export function canCommitGitHubRevisionRefresh(input: {
  candidateRevisionKey: string;
  currentCandidateRevisionKey: string;
  inputSignature: string;
  currentInputSignature: string;
  safety: ReviewRefreshSafety;
}) {
  return (
    input.candidateRevisionKey === input.currentCandidateRevisionKey &&
    input.inputSignature === input.currentInputSignature &&
    canExplicitlyApplyReviewRefresh(input.safety)
  );
}

export function refreshOrientationTargetSettled(
  target: ReviewCursorTarget | null,
  patchState: 'loaded' | 'unavailable' | 'loading' | 'unloaded' | undefined,
) {
  return (
    !target ||
    target.kind === 'file' ||
    patchState === 'loaded' ||
    patchState === 'unavailable'
  );
}

export function selectionAnchorMatchesPatch(input: {
  previousPatch: string | null | undefined;
  nextPatch: string | null | undefined;
  selection: SelectedLineRange;
}) {
  const previous = selectedPatchLines(input.previousPatch, input.selection);
  const next = selectedPatchLines(input.nextPatch, input.selection);
  return Boolean(previous && next && sameStringArray(previous, next));
}

function selectedPatchLines(
  patch: string | null | undefined,
  selection: SelectedLineRange,
) {
  if (!patch?.trim()) return null;
  const positions = patchPositions(patch);
  const endSide = selection.endSide ?? selection.side;
  if (selection.side !== endSide) {
    const startKey = `${selection.side}:${selection.start}`;
    const endKey = `${endSide}:${selection.end}`;
    const startIndex = positions.findIndex((position) =>
      position.keys.includes(startKey),
    );
    const endIndex = positions.findIndex((position) =>
      position.keys.includes(endKey),
    );
    if (startIndex < 0 || endIndex < 0) return null;
    return positions
      .slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
      .map((position) => position.fingerprint);
  }
  const requested = selectedLineKeys(selection);
  const values = new Map<string, string>();
  for (const position of positions) {
    for (const key of position.keys) values.set(key, position.content);
  }
  const selected = requested.map((key) => values.get(key));
  return selected.every((value): value is string => value !== undefined)
    ? selected
    : null;
}

function patchPositions(patch: string) {
  const positions: Array<{
    keys: string[];
    content: string;
    fingerprint: string;
  }> = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      positions.push({ keys: [], content: line, fingerprint: `hunk:${line}` });
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || oldLine === 0) {
      continue;
    }
    const content = line.slice(1);
    if (line.startsWith(' ')) {
      const keys = [`deletions:${oldLine}`, `additions:${newLine}`];
      positions.push({
        keys,
        content,
        fingerprint: `${keys.join('|')}:${content}`,
      });
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith('-')) {
      const keys = [`deletions:${oldLine}`];
      positions.push({
        keys,
        content,
        fingerprint: `${keys[0]}:${content}`,
      });
      oldLine += 1;
    } else if (line.startsWith('+')) {
      const keys = [`additions:${newLine}`];
      positions.push({
        keys,
        content,
        fingerprint: `${keys[0]}:${content}`,
      });
      newLine += 1;
    }
  }
  return positions;
}

function selectedLineKeys(selection: SelectedLineRange) {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return Array.from(
    { length: end - start + 1 },
    (_, index) => `${selection.side}:${start + index}`,
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
