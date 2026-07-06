import type {
  ReportActionResponse,
  ReportResponse,
  ReportsResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getReports(
  input: { kind?: string; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (input.kind) params.set('kind', input.kind);
  if (input.limit) params.set('limit', String(input.limit));
  const query = params.toString();
  const response = await getJson<ReportsResponse>(
    `/api/reports${query ? `?${query}` : ''}`,
  );
  if (!response.ok) throw new Error(response.message ?? 'Reports unavailable.');
  return response;
}

export async function getReport(id: string) {
  const response = await getJson<ReportResponse>(
    `/api/reports/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error(response.message ?? 'Report unavailable.');
  return response;
}

export async function stageDocsDriftFix(reportId: string) {
  const response = await postJson<ReportActionResponse>(
    `/api/reports/${encodeURIComponent(reportId)}/stage-docs-fix`,
    {},
  );
  if (!response.ok) {
    throw new Error(response.message ?? 'Could not stage docs fix.');
  }
  return response;
}
