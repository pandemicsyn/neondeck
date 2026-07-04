import type { WorkflowObservability, WorkflowSummaryResponse } from './types';
import { getJson } from './http';

export async function getWorkflowObservability() {
  return getJson<WorkflowObservability>('/api/workflows/observability');
}

export async function getWorkflowSummaries() {
  return getJson<WorkflowSummaryResponse>('/api/workflows/summaries');
}
