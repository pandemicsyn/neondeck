export type PrReviewStatus =
  'reviewing' | 'ready' | 'submitting' | 'submitted' | 'failed';

export type PrReviewOrigin = 'chat' | 'panel' | 'api';

export type PrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type PrReviewReportOnlyFinding = {
  sourceId?: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  path: string;
  line: number | null;
  summary: string;
  suggestedFix: string;
  reason: string;
};

export type PrReviewRecord = {
  id: string;
  ref: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  author: string | null;
  prUrl: string;
  status: PrReviewStatus;
  runId: string | null;
  headSha: string;
  origin: PrReviewOrigin;
  reviewUrl: string;
  reportIds: string[];
  findingCount: number;
  seededCount: number;
  reportOnlyCount: number;
  reportOnlyFindings: PrReviewReportOnlyFinding[];
  trustBoundary: string;
  verdict: PrReviewVerdict | null;
  previousVerdict: PrReviewVerdict | null;
  githubReviewUrl: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  submittedAt: string | null;
  failedAt: string | null;
};

export const prReviewTrustBoundary =
  'Local drafts only; nothing is sent to GitHub until you submit the review.';
