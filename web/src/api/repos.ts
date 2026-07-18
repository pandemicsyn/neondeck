import type {
  RepoRegistryResponse,
  RepoHealthResponse,
  RepoEditEventsResponse,
  RepoDiffResponse,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getRepoRegistry(options: ApiRequestOptions = {}) {
  return getJson<RepoRegistryResponse>('/api/repos', options);
}

export async function getRepoHealth(options: ApiRequestOptions = {}) {
  return getJson<RepoHealthResponse>('/api/repos/health', options);
}

export async function getRepoEditEvents(options: ApiRequestOptions = {}) {
  return getJson<RepoEditEventsResponse>('/api/repo-edits', options);
}

export async function getRepoDiff(
  input: {
    repoId: string;
    worktreeId?: string | null;
    base?: string;
    paths?: string[];
    includePatch?: boolean;
    maxPatchBytes?: number;
    expectedRevisionKey?: string;
  },
  options: ApiRequestOptions = {},
) {
  const { repoId, ...body } = input;
  const payload = {
    ...body,
    worktreeId: body.worktreeId ?? undefined,
    paths: body.paths && body.paths.length > 0 ? body.paths : undefined,
  };
  return postJson<RepoDiffResponse>(
    `/api/repos/${encodeURIComponent(repoId)}/diff`,
    payload,
    options,
  );
}
