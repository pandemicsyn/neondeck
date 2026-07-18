import { randomUUID } from 'node:crypto';
import type { ReviewSourceRevisionEvent } from '../../../shared/review-refresh';
import type {
  ReviewRevision,
  ReviewSourceKind,
} from '../../../shared/review-source';

type ReviewSourceRevisionListener = (event: ReviewSourceRevisionEvent) => void;
const listeners = new Set<ReviewSourceRevisionListener>();

export function publishReviewSourceRevision(input: {
  action?: ReviewSourceRevisionEvent['action'];
  source: {
    id?: string | null;
    kind?: ReviewSourceKind | null;
    repoId?: string | null;
    repoFullName?: string | null;
    worktreeId?: string | null;
    prNumber?: number | null;
  };
  revision?: ReviewRevision | null;
  reason: string;
}) {
  const event: ReviewSourceRevisionEvent = {
    id: randomUUID(),
    action: input.action ?? 'revision-available',
    source: {
      id: input.source.id ?? null,
      kind: input.source.kind ?? null,
      repoId: input.source.repoId ?? null,
      repoFullName: input.source.repoFullName ?? null,
      worktreeId: input.source.worktreeId ?? null,
      prNumber: input.source.prNumber ?? null,
    },
    revision: input.revision ?? null,
    changedAt: new Date().toISOString(),
    reason: input.reason,
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      listeners.delete(listener);
      console.error('[neondeck] review source event listener failed', error);
    }
  }
  return event;
}

export function subscribeReviewSourceRevisionEvents(
  listener: ReviewSourceRevisionListener,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatReviewSourceRevisionServerSentEvent(
  event: ReviewSourceRevisionEvent,
) {
  return `event: review-source-revision\ndata: ${JSON.stringify(event)}\n\n`;
}
