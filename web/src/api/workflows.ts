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
  options: ApiRequestOptions = {},
) {
  return getAuthorizedJson<WorkflowRunInspectionResponse>(
    `/api/workflows/runs/${encodeURIComponent(runId)}`,
    options,
  );
}
