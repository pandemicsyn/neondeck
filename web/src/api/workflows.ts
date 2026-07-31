import type {
  WorkflowObservability,
  WorkflowRunInspectionResponse,
  WorkflowSummaryResponse,
} from './types';
import { getAuthorizedJson, getJson, type ApiRequestOptions } from './http';

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

export async function getWorkflowRun(
  runId: string,
  options: ApiRequestOptions & { afterEventId?: number } = {},
) {
  const params = new URLSearchParams();
  if (options.afterEventId !== undefined) {
    params.set('afterEventId', String(options.afterEventId));
  }
  const query = params.toString();
  return getAuthorizedJson<WorkflowRunInspectionResponse>(
    `/api/workflows/runs/${encodeURIComponent(runId)}${query ? `?${query}` : ''}`,
    options,
  );
}
