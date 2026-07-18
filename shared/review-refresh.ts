import {
  reconcileReviewCursor,
  type ReviewCursorTarget,
} from './review-navigation';
import {
  reviewRevisionKey,
  type ReviewFileMetadata,
  type ReviewRevision,
  type ReviewSourceKind,
  type ReviewSourceSnapshot,
} from './review-source';

export const reviewRefreshSchemaVersion = 1 as const;

export type ReviewRefreshPauseReason =
  | 'dirty-editor'
  | 'active-selection'
  | 'stale-draft'
  | 'reanchor-active'
  | 'revision-confirmation-open'
  | 'mutation-pending'
  | 'safety-uncertain';

export type ReviewRefreshSafetyInput = {
  dirtyEditor?: boolean;
  activeSelection?: boolean;
  staleDraft?: boolean;
  reanchorActive?: boolean;
  revisionConfirmationOpen?: boolean;
  mutationPending?: boolean;
  safetyUncertain?: boolean;
};

export type ReviewRefreshSafety = {
  safe: boolean;
  reasons: ReviewRefreshPauseReason[];
};

export type ReviewOrientationOutcome =
  | {
      status: 'preserved' | 'degraded';
      activePath: string;
      target: ReviewCursorTarget | null;
      message: string;
    }
  | {
      status: 'failed';
      activePath: null;
      target: null;
      message: string;
    };

export type ReviewRefreshStatus = {
  schemaVersion: typeof reviewRefreshSchemaVersion;
  state: 'current' | 'available' | 'applying';
  appliedRevisionKey: string | null;
  availableRevision: ReviewRevision | null;
  availableRevisionKey: string | null;
  pausedReasons: ReviewRefreshPauseReason[];
  preservation: ReviewOrientationOutcome['status'] | null;
  message: string | null;
};

export type ReviewSourceRevisionEvent = {
  id: string;
  action: 'revision-available' | 'source-changed';
  source: {
    id: string | null;
    kind: ReviewSourceKind | null;
    repoId: string | null;
    repoFullName: string | null;
    worktreeId: string | null;
    prNumber: number | null;
  };
  revision: ReviewRevision | null;
  changedAt: string;
  reason: string;
};

export function evaluateReviewRefreshSafety(
  input: ReviewRefreshSafetyInput,
): ReviewRefreshSafety {
  const reasons: ReviewRefreshPauseReason[] = [];
  if (input.dirtyEditor) reasons.push('dirty-editor');
  if (input.activeSelection) reasons.push('active-selection');
  if (input.staleDraft) reasons.push('stale-draft');
  if (input.reanchorActive) reasons.push('reanchor-active');
  if (input.revisionConfirmationOpen)
    reasons.push('revision-confirmation-open');
  if (input.mutationPending) reasons.push('mutation-pending');
  if (input.safetyUncertain) reasons.push('safety-uncertain');
  return { safe: reasons.length === 0, reasons };
}

export function canExplicitlyApplyReviewRefresh(safety: ReviewRefreshSafety) {
  return !safety.reasons.some(
    (reason) =>
      reason === 'dirty-editor' ||
      reason === 'reanchor-active' ||
      reason === 'revision-confirmation-open' ||
      reason === 'mutation-pending' ||
      reason === 'safety-uncertain',
  );
}

export function assertReviewRevisionCurrent(
  expectedRevisionKey: string | null,
  receivedRevision: ReviewRevision,
  message = 'The review source changed while loading revision-bound data.',
) {
  if (
    !expectedRevisionKey ||
    reviewRevisionKey(receivedRevision) !== expectedRevisionKey
  ) {
    throw new Error(message);
  }
}

export function createReviewRefreshStatus(input: {
  appliedRevision: ReviewRevision;
  availableRevision?: ReviewRevision | null;
  safety?: ReviewRefreshSafety;
  state?: ReviewRefreshStatus['state'];
  preservation?: ReviewOrientationOutcome['status'] | null;
  message?: string | null;
}): ReviewRefreshStatus {
  return {
    schemaVersion: reviewRefreshSchemaVersion,
    state: input.state ?? (input.availableRevision ? 'available' : 'current'),
    appliedRevisionKey: reviewRevisionKey(input.appliedRevision),
    availableRevision: input.availableRevision ?? null,
    availableRevisionKey: input.availableRevision
      ? reviewRevisionKey(input.availableRevision)
      : null,
    pausedReasons: input.safety?.reasons ?? [],
    preservation: input.preservation ?? null,
    message: input.message ?? null,
  };
}

export function reviewSourceRevisionEventMatches(
  source: ReviewSourceSnapshot,
  event: ReviewSourceRevisionEvent,
) {
  if (event.source.id) return event.source.id === source.id;
  if (event.source.kind && event.source.kind !== source.kind) return false;
  if (
    event.source.worktreeId &&
    event.source.worktreeId !== source.repository.worktreeId
  ) {
    return false;
  }
  if (event.source.repoId && event.source.repoId !== source.repository.repoId) {
    return false;
  }
  if (
    event.source.repoFullName &&
    event.source.repoFullName.toLowerCase() !==
      source.repository.repoFullName?.toLowerCase()
  ) {
    return false;
  }
  if (event.source.prNumber !== null) {
    const target = source.promotionTargets.find(
      (item) => item.destination === 'github-review-draft',
    );
    if (!target || target.prNumber !== event.source.prNumber) return false;
  }
  return Boolean(
    event.source.kind ||
    event.source.worktreeId ||
    event.source.repoId ||
    event.source.repoFullName ||
    event.source.prNumber !== null,
  );
}

export function reconcileReviewOrientation(input: {
  previousFiles: readonly Pick<ReviewFileMetadata, 'path' | 'previousPath'>[];
  nextFiles: readonly Pick<ReviewFileMetadata, 'path' | 'previousPath'>[];
  previousOrder?: readonly string[];
  nextOrder?: readonly string[];
  activePath: string | null;
  previousTargets?: readonly ReviewCursorTarget[];
  nextTargets?: readonly ReviewCursorTarget[];
  currentTargetKey?: string | null;
}): ReviewOrientationOutcome {
  if (input.nextFiles.length === 0) {
    return {
      status: 'failed',
      activePath: null,
      target: null,
      message: 'The refreshed revision has no reviewable files.',
    };
  }

  const nextOrder = normalizeOrder(input.nextOrder, input.nextFiles);
  const nextPaths = new Set(nextOrder);
  const exactPath =
    input.activePath && nextPaths.has(input.activePath)
      ? input.activePath
      : null;
  const renamedPath = input.activePath
    ? unambiguousRename(input.activePath, input.nextFiles)
    : null;
  const activePath =
    exactPath ??
    renamedPath ??
    nearestPath(
      input.activePath,
      normalizeOrder(input.previousOrder, input.previousFiles),
      nextOrder,
    );

  const cursor = reconcileReviewCursor(
    input.previousTargets ?? [],
    input.nextTargets ?? [],
    input.currentTargetKey ?? null,
  );
  const target = cursor.target ?? null;
  const targetDegraded = cursor.resolution === 'nearest';
  const pathDegraded = Boolean(
    input.activePath && activePath !== input.activePath,
  );
  const status = pathDegraded || targetDegraded ? 'degraded' : 'preserved';
  const message =
    status === 'preserved'
      ? 'Review orientation preserved on the refreshed revision.'
      : renamedPath
        ? `Review orientation moved with the proven rename to ${renamedPath}.`
        : `Review orientation moved to the nearest available target, ${activePath}.`;
  return { status, activePath, target, message };
}

export function reviewRefreshPauseMessage(reasons: ReviewRefreshPauseReason[]) {
  if (reasons.length === 0) return null;
  const labels: Record<ReviewRefreshPauseReason, string> = {
    'dirty-editor': 'an editor contains unsaved text',
    'active-selection': 'a line, range, or annotation selection is active',
    'stale-draft': 'the local GitHub draft belongs to the older head',
    'reanchor-active': 'a re-anchor flow is active',
    'revision-confirmation-open': 'a revision confirmation is open',
    'mutation-pending': 'a related mutation is still running',
    'safety-uncertain': 'refresh safety could not be proven',
  };
  return `Automatic refresh is paused because ${reasons
    .map((reason) => labels[reason])
    .join(', ')}.`;
}

function normalizeOrder(
  requested: readonly string[] | undefined,
  files: readonly Pick<ReviewFileMetadata, 'path'>[],
) {
  const paths = new Set(files.map((file) => file.path));
  const result = (requested ?? []).filter((path) => paths.has(path));
  for (const file of files)
    if (!result.includes(file.path)) result.push(file.path);
  return result;
}

function unambiguousRename(
  previousPath: string,
  files: readonly Pick<ReviewFileMetadata, 'path' | 'previousPath'>[],
) {
  const matches = files.filter((file) => file.previousPath === previousPath);
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}

function nearestPath(
  previousPath: string | null,
  previousOrder: readonly string[],
  nextOrder: readonly string[],
) {
  if (!previousPath) return nextOrder[0] ?? null;
  const previousIndex = Math.max(0, previousOrder.indexOf(previousPath));
  let best = nextOrder[0] ?? null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [index, path] of nextOrder.entries()) {
    const score =
      Math.abs(index - previousIndex) * 2 + (index < previousIndex ? 1 : 0);
    if (score < bestScore) {
      best = path;
      bestScore = score;
    }
  }
  return best;
}
