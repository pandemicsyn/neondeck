import type { RepoDiffFile } from '../../api';
import type { ReviewFindingSeverity } from '../../../../shared/review-navigation';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type { ReviewSurfaceNavigationTarget } from '../../../../shared/review-surface';

export type DiffFilePatch = Omit<RepoDiffFile, 'patch'> & {
  patch?: string | null;
  message?: string | null;
  previousPath?: string | null;
};

export type FileReviewMapEntry = {
  path: string;
  unresolvedThreadCount: number;
  draftCount: number;
  staleDraftCount: number;
  findingCount: number;
  highestFindingSeverity: ReviewFindingSeverity | null;
  findingSummaries: string[];
  tourStepOrdinals: number[];
};

export type DiffViewTone = 'primary' | 'violet' | 'accent';

export type DiffReviewAnnotationMetadata = {
  id: string;
  kind?: 'thread' | 'draft' | 'composer' | 'finding' | 'tour';
  title: string;
  body: string;
  authorLogin?: string | null;
  url?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  isStale?: boolean;
  finding?: NeonReviewFinding;
  exactAnchor?: ReviewSurfaceNavigationTarget['anchor'];
};

export type DiffReviewAnnotation = {
  side: 'additions' | 'deletions';
  lineNumber: number;
  metadata: DiffReviewAnnotationMetadata;
};
