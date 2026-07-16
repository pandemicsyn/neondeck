import type { WorkflowObservability, WorkflowSummaryResponse } from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getWorkflowObservability(
  options: ApiRequestOptions = {},
) {
  return getJson<WorkflowObservability>(
    '/api/workflows/observability',
    options,
  );
}

export async function getWorkflowSummaries(options: ApiRequestOptions = {}) {
  return getJson<WorkflowSummaryResponse>('/api/workflows/summaries', options);
}
