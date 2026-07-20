import type {
  PreparedDiffFileDiffResponse,
  PreparedDiffFilesResponse,
} from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getPreparedDiffFiles(
  preparedDiffId: string,
  options: ApiRequestOptions = {},
) {
  return getJson<PreparedDiffFilesResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/files`,
    options,
  );
}

export async function getPreparedDiffFileDiff(
  input: {
    preparedDiffId: string;
    path: string;
    expectedRevisionKey?: string;
    maxPatchBytes?: number;
  },
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams({ path: input.path });
  if (input.expectedRevisionKey) {
    params.set('expectedRevisionKey', input.expectedRevisionKey);
  }
  if (input.maxPatchBytes) {
    params.set('maxPatchBytes', String(input.maxPatchBytes));
  }
  return getJson<PreparedDiffFileDiffResponse>(
    `/api/prepared-diffs/${encodeURIComponent(input.preparedDiffId)}/files/diff?${params.toString()}`,
    options,
  );
}
