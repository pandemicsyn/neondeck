import type { LearningCandidateStatus, LearningOperatorState } from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getLearningOperatorState(
  input: {
    limit?: number;
    candidateStatus?: LearningCandidateStatus;
    candidateTarget?: 'memory' | 'skill';
  } = {},
  options: ApiRequestOptions = {},
) {
  return getJson<LearningOperatorState>(
    learningOperatorStateUrl(input),
    options,
  );
}

export function learningOperatorStateUrl(
  input: {
    limit?: number;
    candidateStatus?: LearningCandidateStatus;
    candidateTarget?: 'memory' | 'skill';
  } = {},
) {
  const params = new URLSearchParams();
  if (input.candidateStatus) {
    params.set('candidateStatus', input.candidateStatus);
  }
  if (input.candidateTarget) {
    params.set('candidateTarget', input.candidateTarget);
  }
  if (input.limit) params.set('limit', String(input.limit));
  const query = params.toString();
  return `/api/learning/state${query ? `?${query}` : ''}`;
}

export async function decideLearningCandidate(
  id: string,
  decision: 'approve' | 'reject',
  reason?: string,
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/learning/candidates/${id}/${decision}`, {
    reason: reason || undefined,
  });
}

export async function restoreSkillPatch(id: string, reason?: string) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/skills/patches/${id}/restore`, {
    confirm: true,
    reason: reason || 'Dashboard skill patch restore.',
  });
}

export async function queueLearningReview(kind: 'conversation' | 'pr-batch') {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    runId?: string;
    message: string;
  }>(
    kind === 'conversation'
      ? '/api/learning/reviews/conversation'
      : '/api/learning/reviews/prs',
    { reason: 'Dashboard manual learning review.' },
  );
}
