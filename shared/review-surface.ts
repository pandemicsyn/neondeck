import type { ReviewSourceSnapshot } from './review-source';

export const reviewSurfaceSchemaVersion = 1 as const;

export type ReviewSurfaceSelection = {
  path: string;
  side: 'additions' | 'deletions';
  startLine: number;
  endLine: number;
  endSide: 'additions' | 'deletions' | null;
};

export type ReviewSurfaceSnapshot = {
  schemaVersion: typeof reviewSurfaceSchemaVersion;
  surfaceId: string;
  source: ReviewSourceSnapshot;
  activePath: string | null;
  selection: ReviewSurfaceSelection | null;
  selectedAnnotationId: string | null;
  fileFilter: string | null;
  reviewOrder: string[];
  viewMode: 'file' | 'changeset';
  presentationMode: 'unified' | 'split' | 'auto';
  annotationVisibility: string[];
};

export type ActiveReviewSurface = ReviewSurfaceSnapshot & {
  registeredAt: string;
  updatedAt: string;
  expiresAt: string;
  lastNavigationAck: ReviewSurfaceNavigationAck | null;
};

export type ReviewSurfaceNavigationTarget = {
  path: string;
  focus: boolean;
};

export type ReviewSurfaceNavigationRequest = {
  revisionKey: string | null;
  target: ReviewSurfaceNavigationTarget;
};

export type ReviewSurfaceNavigationCommand = ReviewSurfaceNavigationRequest & {
  commandId: string;
  surfaceId: string;
  requestedAt: string;
};

export type ReviewSurfaceNavigationAckStatus =
  'resolved' | 'stale-revision' | 'target-unavailable';

export type ReviewSurfaceNavigationAck = {
  commandId: string;
  surfaceId: string;
  status: ReviewSurfaceNavigationAckStatus;
  revisionKey: string | null;
  resolvedPath: string | null;
  message: string | null;
  acknowledgedAt: string;
};

export type ReviewSurfaceChangeEvent = {
  id: string;
  action: 'registered' | 'updated' | 'removed' | 'navigation' | 'acknowledged';
  surfaceId: string;
  changedAt: string;
  surface: ActiveReviewSurface | null;
  navigation: ReviewSurfaceNavigationCommand | null;
  acknowledgement: ReviewSurfaceNavigationAck | null;
  reason: 'closed' | 'expired' | null;
};
