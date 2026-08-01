import type {
  ActivityObservability,
  ActivitySubmissionResponse,
  WorkflowSummaryResponse,
} from './types';
import { getJson, type ApiRequestOptions } from './http';

export function getActivityObservability(options: ApiRequestOptions = {}) {
  return getJson<ActivityObservability>('/api/activity', options);
}

export function getOperationSummaries(options: ApiRequestOptions = {}) {
  return getJson<WorkflowSummaryResponse>('/api/operations/summaries', options);
}

export function getActivitySubmission(
  submissionId: string,
  options: ApiRequestOptions & { afterEventId?: number } = {},
) {
  const params = new URLSearchParams();
  if (options.afterEventId !== undefined) {
    params.set('afterEventId', String(options.afterEventId));
  }
  const query = params.toString();
  return getJson<ActivitySubmissionResponse>(
    `/api/activity/submissions/${encodeURIComponent(submissionId)}${query ? `?${query}` : ''}`,
    options,
  );
}
