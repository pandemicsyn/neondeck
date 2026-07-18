export const neonReviewFindingSchemaVersion = 1 as const;

export const neonReviewFindingLimits = {
  maxApplyBatch: 50,
  maxFindingsPerSurface: 200,
  maxTitleLength: 160,
  maxExplanationLength: 2_000,
  maxSuggestedActionLength: 500,
  maxLifecycleReasonLength: 500,
  maxEventFindingIds: 50,
  maxLineNumber: 10_000_000,
  maxLineRangeSpan: 10_000,
} as const;

export type NeonReviewFindingSeverity = 'critical' | 'major' | 'minor' | 'nit';

export type NeonReviewFindingConfidence = 'high' | 'medium' | 'low';

export type NeonReviewFindingState =
  'active' | 'stale' | 'resolved' | 'dismissed' | 'promoted';

export type NeonReviewFindingSide = 'additions' | 'deletions';

export type NeonReviewFindingAnchor =
  | {
      kind: 'line-range';
      side: NeonReviewFindingSide;
      startLine: number;
      endLine: number;
    }
  | {
      kind: 'hunk';
      side: NeonReviewFindingSide;
      hunkId: string;
    };

export type NeonReviewFindingProvenance = {
  authorRole: string;
  model: string | null;
  workflowRunId: string | null;
  createdAt: string;
};

export type NeonReviewFindingLifecycle = {
  state: NeonReviewFindingState;
  changedAt: string;
  reason: string | null;
};

export type NeonReviewFinding = {
  schemaVersion: typeof neonReviewFindingSchemaVersion;
  id: string;
  surfaceId: string;
  sourceId: string;
  revisionKey: string;
  file: string;
  anchor: NeonReviewFindingAnchor;
  title: string;
  explanation: string;
  severity: NeonReviewFindingSeverity;
  confidence: NeonReviewFindingConfidence | null;
  suggestedAction: string | null;
  provenance: NeonReviewFindingProvenance;
  lifecycle: NeonReviewFindingLifecycle;
};

export type NeonReviewFindingDraft = Omit<
  NeonReviewFinding,
  'surfaceId' | 'provenance' | 'lifecycle'
> & {
  provenance: Omit<NeonReviewFindingProvenance, 'createdAt'>;
};

export type NeonReviewFindingSubmission = Omit<
  NeonReviewFindingDraft,
  'provenance'
>;

export type ReviewSurfaceFindingsApplyRequest = {
  revisionKey: string;
  findings: NeonReviewFindingSubmission[];
};

export type ReviewSurfaceFindingsDismissRequest = {
  sourceId: string;
  revisionKey: string;
  findingIds: string[];
  reason: string | null;
};

export type ReviewSurfaceFindingsClearRequest = {
  sourceId: string;
  revisionKey: string;
  findingIds?: string[];
};

export type ReviewSurfaceFindingChange = {
  action: 'applied' | 'dismissed' | 'cleared' | 'staled';
  revisionKey: string | null;
  findingIds: string[];
  count: number;
};
