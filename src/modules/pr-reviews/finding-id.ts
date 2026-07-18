import { createHash } from 'node:crypto';

export type PrReviewFindingIdentity = {
  line: number | null;
  path: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  suggestedFix: string;
  summary: string;
};

export function prReviewFindingSourceId(finding: PrReviewFindingIdentity) {
  const canonicalFinding = JSON.stringify([
    finding.severity,
    finding.path,
    finding.line,
    finding.summary,
    finding.suggestedFix,
  ]);
  return `prf_${createHash('sha256').update(canonicalFinding).digest('hex').slice(0, 24)}`;
}
