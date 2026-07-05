import type { ReportsResponse } from './types';
import { getJson } from './http';

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
