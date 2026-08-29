export const prReviewTourSchemaVersion = 1 as const;

export const prReviewTourLimits = {
  maxSteps: 12,
  maxTitleLength: 160,
  maxSummaryLength: 1_000,
  maxSymbolLength: 120,
  maxExplanationLength: 2_000,
  maxSourceFindingIdLength: 240,
  maxLineNumber: 10_000_000,
  maxLineRangeSpan: 200,
} as const;

export type PrReviewTourSide = 'additions' | 'deletions';

export type PrReviewTourProvenance = {
  authorRole: string;
  model: string | null;
  submissionId: string | null;
  createdAt: string;
};

export type PrReviewTourStep = {
  id: string;
  key: string;
  ordinal: number;
  file: string;
  anchor: {
    kind: 'line-range';
    side: PrReviewTourSide;
    startLine: number;
    endLine: number;
  };
  symbol: string | null;
  explanation: string;
};

export type PrReviewTour = {
  schemaVersion: typeof prReviewTourSchemaVersion;
  id: string;
  generation: number;
  conversationId: string;
  reviewId: string;
  repoFullName: string;
  headSha: string;
  revisionKey: string;
  title: string;
  summary: string;
  steps: PrReviewTourStep[];
  sourceFindingId: string | null;
  provenance: PrReviewTourProvenance;
};

export type PrReviewTourDraft = Pick<
  PrReviewTour,
  'title' | 'summary' | 'sourceFindingId'
> & {
  steps: Array<
    Pick<PrReviewTourStep, 'key' | 'file' | 'symbol' | 'explanation'> & {
      side: PrReviewTourSide;
      startLine: number;
      endLine: number;
    }
  >;
};

export function prReviewTourAnnotationId(stepId: string) {
  return JSON.stringify(['tour-step', stepId]);
}

export type ReviewTourChangeEvent =
  | {
      id: string;
      action: 'tour-replaced';
      conversationId: string;
      reviewId: string;
      revisionKey: string;
      tourId: string;
      generation: number;
      changedAt: string;
    }
  | {
      id: string;
      action: 'tour-activated';
      surfaceId: string;
      tourId: string;
      generation: number;
      stepId: string;
      requestId: string;
      changedAt: string;
    }
  | {
      id: string;
      action: 'tour-activation-failed';
      surfaceId: string;
      tourId: string;
      generation: number;
      stepId: string;
      requestId: string;
      status: 'stale-revision' | 'target-unavailable';
      message: string | null;
      changedAt: string;
    }
  | {
      id: string;
      action: 'tour-closed';
      surfaceId: string;
      tourId: string;
      generation: number;
      requestId: string;
      changedAt: string;
    };
