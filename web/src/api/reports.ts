import type {
  ReportActionResponse,
  ReportResponse,
  ReportsResponse,
} from './types';
import { ApiError, getJson, postJson, type ApiRequestOptions } from './http';

export async function getReports(
  input: { kind?: string; excludeKind?: string; limit?: number } = {},
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams();
  if (input.kind) params.set('kind', input.kind);
  if (input.excludeKind) params.set('excludeKind', input.excludeKind);
  if (input.limit) params.set('limit', String(input.limit));
  const query = params.toString();
  const response = await getJson<ReportsResponse>(
    `/api/reports${query ? `?${query}` : ''}`,
    options,
  );
  if (!response.ok) throw new Error(response.message ?? 'Reports unavailable.');
  return response;
}

export async function getReport(id: string, options: ApiRequestOptions = {}) {
  const response = await getJson<ReportResponse>(
    `/api/reports/${encodeURIComponent(id)}`,
    options,
  );
  if (!response.ok) throw new Error(response.message ?? 'Report unavailable.');
  return response;
}

export async function getReportHtml(
  id: string,
  options: ApiRequestOptions = {},
) {
  const url = `/reports/${encodeURIComponent(id)}`;
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new ApiError(
      `Report request failed with ${response.status}.`,
      response.status,
      url,
      null,
    );
  }
  return response.text();
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
