import type {
  ActiveReviewSurface,
  ReviewSurfaceChangeEvent,
  ReviewSurfaceNavigationAck,
  ReviewSurfaceNavigationCommand,
  ReviewSurfaceNavigationRequest,
  ReviewSurfaceSnapshot,
} from '../../../shared/review-surface';
import { dashboardEventHub } from './event-hub';
import { getJson, postJson, putJson } from './http';

export function listReviewSurfaces() {
  return getJson<{ ok: true; surfaces: ActiveReviewSurface[] }>(
    '/api/review-surfaces',
  );
}

export function readReviewSurface(surfaceId: string) {
  return getJson<{ ok: true; surface: ActiveReviewSurface }>(
    reviewSurfaceUrl(surfaceId),
  );
}

export function registerReviewSurface(snapshot: ReviewSurfaceSnapshot) {
  return putJson<{ ok: true; surface: ActiveReviewSurface }>(
    reviewSurfaceUrl(snapshot.surfaceId),
    snapshot,
  );
}

export function removeReviewSurface(surfaceId: string) {
  return fetch(reviewSurfaceUrl(surfaceId), {
    method: 'DELETE',
    keepalive: true,
  });
}

export function heartbeatReviewSurface(surfaceId: string) {
  return postJson<{ ok: true; expiresAt: string }>(
    `${reviewSurfaceUrl(surfaceId)}/heartbeat`,
    {},
  );
}

export function navigateReviewSurface(
  surfaceId: string,
  request: ReviewSurfaceNavigationRequest,
) {
  return postJson<{ ok: true; navigation: ReviewSurfaceNavigationCommand }>(
    `${reviewSurfaceUrl(surfaceId)}/navigation`,
    request,
  );
}

export function acknowledgeReviewSurfaceNavigation(
  acknowledgement: Omit<
    ReviewSurfaceNavigationAck,
    'surfaceId' | 'acknowledgedAt'
  > & { surfaceId: string },
) {
  const { commandId, surfaceId, ...body } = acknowledgement;
  return postJson<{ ok: true; acknowledgement: ReviewSurfaceNavigationAck }>(
    `${reviewSurfaceUrl(surfaceId)}/navigation/${encodeURIComponent(commandId)}/ack`,
    body,
  );
}

export function openReviewSurfaceEventStream(
  onEvent: (event: ReviewSurfaceChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'review-surface-change',
    onEvent,
    onError,
    onOpen,
  );
}

function reviewSurfaceUrl(surfaceId: string) {
  return `/api/review-surfaces/${encodeURIComponent(surfaceId)}`;
}
