import type { ReviewSourceSnapshot } from './review-source';
import type {
  NeonReviewFinding,
  ReviewSurfaceFindingChange,
} from './review-finding';

export const reviewSurfaceSchemaVersion = 1 as const;

export const reviewSurfaceContextPageLimits = {
  defaultLimit: 25,
  maxLimit: 50,
  maxOffset: 5_000,
} as const;

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

export type ReviewSurfaceContextPageRequest = {
  surfaceId: string;
  offset?: number;
  limit?: number;
};

export type ReviewSurfaceContextWindow<T> = {
  items: T[];
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
};

export type ReviewSurfaceContextSummary = Omit<
  ActiveReviewSurface,
  'source' | 'reviewOrder'
> & {
  source: Omit<ReviewSourceSnapshot, 'files'>;
  counts: {
    files: number;
    reviewOrder: number;
    findings: number;
  };
};

export type ReviewSurfaceContextPage = {
  files: ReviewSurfaceContextWindow<ReviewSourceSnapshot['files'][number]>;
  reviewOrder: ReviewSurfaceContextWindow<string>;
  findings: ReviewSurfaceContextWindow<NeonReviewFinding>;
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
  action:
    | 'registered'
    | 'updated'
    | 'removed'
    | 'navigation'
    | 'acknowledged'
    | 'findings-changed';
  surfaceId: string;
  changedAt: string;
  surface: ActiveReviewSurface | null;
  navigation: ReviewSurfaceNavigationCommand | null;
  acknowledgement: ReviewSurfaceNavigationAck | null;
  findings: ReviewSurfaceFindingChange | null;
  reason: 'closed' | 'expired' | null;
};
