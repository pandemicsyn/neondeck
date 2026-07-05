import type { RepoDiffFile } from '../../api';

export type DiffFilePatch = Omit<RepoDiffFile, 'patch'> & {
  patch?: string | null;
  message?: string | null;
};

export type DiffViewTone = 'primary' | 'violet' | 'accent';

export type DiffReviewAnnotationMetadata = {
  id: string;
  kind?: 'thread' | 'draft' | 'composer';
  title: string;
  body: string;
  authorLogin?: string | null;
  url?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  isStale?: boolean;
};

export type DiffReviewAnnotation = {
  side: 'additions' | 'deletions';
  lineNumber: number;
  metadata: DiffReviewAnnotationMetadata;
};
