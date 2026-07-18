import type { FlueExecutionContext } from '@flue/runtime';
import type {
  NeonReviewFindingDraft,
  NeonReviewFindingProvenance,
  NeonReviewFindingSubmission,
} from '../../../shared/review-finding';

type FindingProvenanceStamp = Omit<NeonReviewFindingProvenance, 'createdAt'>;

export const localApiFindingProvenance = {
  authorRole: 'local-api',
  model: null,
  workflowRunId: null,
} satisfies FindingProvenanceStamp;

export function flueFindingProvenance(
  context: FlueExecutionContext | undefined,
): FindingProvenanceStamp {
  return {
    authorRole: context?.agentName ?? 'flue',
    model: null,
    workflowRunId: context?.runId ?? null,
  };
}

export function stampReviewFindingSubmissions(
  findings: readonly NeonReviewFindingSubmission[],
  provenance: FindingProvenanceStamp,
): NeonReviewFindingDraft[] {
  return findings.map((finding) => ({
    ...finding,
    provenance: { ...provenance },
  }));
}
